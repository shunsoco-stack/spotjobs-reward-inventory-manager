import type { PullSyncOptions } from "./client";
import { resolveSyncBridgeUrl } from "./preferences";
import { deriveSyncCredentials } from "./protocol";

export type PcRefreshPhase = "requesting" | "waiting" | "fetching";
export type PcRefreshStatus = "pending" | "running" | "succeeded" | "failed";
export type PcRefreshFailure = "auth_required" | "page_required" | "disabled" | "sync_failed";

export interface PcRefreshRequest {
  requestId: string;
  requestedAt: string;
  expiresAt: string;
  status: PcRefreshStatus;
  completedAt?: string;
  errorCode?: PcRefreshFailure;
}

export interface PcRefreshSuccess extends PcRefreshRequest {
  status: "succeeded";
  completedAt: string;
}

export interface PcRefreshOptions extends PullSyncOptions {
  onProgress?: (phase: PcRefreshPhase) => void;
  /** May shorten the wait for tests; never extends the 90-second user-facing limit. */
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export type PcRefreshErrorCode = "timeout" | "expired" | "auth-required" | "page-required"
  | "disabled" | "sync-failed" | "unauthorized" | "rate-limited" | "unavailable" | "invalid-response";

export class PcRefreshError extends Error {
  constructor(message: string, public readonly code: PcRefreshErrorCode) {
    super(message);
    this.name = "PcRefreshError";
  }
}

const TIMEOUT_MS = 90_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RESPONSE_LENGTH = 16_384;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const failures: Record<PcRefreshFailure, { code: PcRefreshErrorCode; message: string }> = {
  auth_required: { code: "auth-required", message: "PCのSPOTJOBSからログアウトされています。PCでログインし直してから再試行してください。" },
  page_required: { code: "page-required", message: "PCのEdgeでSPOTJOBSのジョブ履歴を開いてから、もう一度同期してください。" },
  disabled: { code: "disabled", message: "PCのEdge拡張機能で自動同期を有効にしてから再試行してください。" },
  sync_failed: { code: "sync-failed", message: "PCで最新履歴を取得できませんでした。PCのEdge拡張機能の状態を確認して再試行してください。" },
};

function invalidResponse(): PcRefreshError {
  return new PcRefreshError("同期依頼の応答を確認できませんでした。少し待ってから再試行してください。", "invalid-response");
}

function validateRequest(value: unknown, previous?: PcRefreshRequest): PcRefreshRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse();
  const record = value as Record<string, unknown>;
  if (typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId)
    || typeof record.requestedAt !== "string" || !Number.isFinite(Date.parse(record.requestedAt))
    || typeof record.expiresAt !== "string" || !Number.isFinite(Date.parse(record.expiresAt))
    || !["pending", "running", "succeeded", "failed"].includes(String(record.status))) throw invalidResponse();
  const requestedAt = new Date(record.requestedAt).toISOString();
  const expiresAt = new Date(record.expiresAt).toISOString();
  if (Date.parse(expiresAt) <= Date.parse(requestedAt)
    || Date.parse(expiresAt) - Date.parse(requestedAt) > 300_000) throw invalidResponse();
  if (previous && (record.requestId !== previous.requestId || requestedAt !== previous.requestedAt || expiresAt !== previous.expiresAt)) {
    throw invalidResponse();
  }
  const request: PcRefreshRequest = {
    requestId: record.requestId, requestedAt, expiresAt, status: record.status as PcRefreshStatus,
  };
  if (request.status === "succeeded" || request.status === "failed") {
    if (typeof record.completedAt !== "string" || !Number.isFinite(Date.parse(record.completedAt))
      || Date.parse(record.completedAt) < Date.parse(requestedAt)
      || Date.parse(record.completedAt) > Date.parse(expiresAt)) throw invalidResponse();
    request.completedAt = new Date(record.completedAt).toISOString();
  }
  if (request.status === "failed") {
    if (typeof record.errorCode !== "string" || !Object.hasOwn(failures, record.errorCode)) throw invalidResponse();
    request.errorCode = record.errorCode as PcRefreshFailure;
  }
  return request;
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Aborted", "AbortError");
}

/** A race also bounds fetch implementations that do not honor AbortSignal. */
function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortReason(signal));
    if (signal.aborted) {
      operation.catch(() => undefined);
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function pause(duration: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await withAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, duration); }), signal);
  } finally {
    clearTimeout(timer);
  }
}

function duration(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

/** Requests fresh collection on the paired PC, then waits for its upload acknowledgement. */
export async function requestPcRefresh(options: PcRefreshOptions): Promise<PcRefreshSuccess> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Aborted", "AbortError"));
  if (options.signal?.aborted) cancel();
  else options.signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => controller.abort(new PcRefreshError(
    "PCからの応答を確認できませんでした。PCの電源・Edge・SPOTJOBSのログイン状態と拡張機能の更新を確認して再試行してください。", "timeout",
  )), duration(options.timeoutMs, TIMEOUT_MS, TIMEOUT_MS));
  let phase: PcRefreshPhase | undefined;
  const progress = (next: PcRefreshPhase) => {
    if (phase !== next) { phase = next; options.onProgress?.(next); }
  };
  try {
    if (controller.signal.aborted) throw abortReason(controller.signal);
    progress("requesting");
    const credentials = await withAbort(deriveSyncCredentials(options.syncCode), controller.signal);
    const endpoint = `${resolveSyncBridgeUrl(options.bridgeUrl)}/api/v1/refresh/${encodeURIComponent(credentials.channelId)}`;
    const fetchImpl = options.fetchImpl ?? fetch;
    const exchange = async (method: "POST" | "GET", previous?: PcRefreshRequest): Promise<PcRefreshRequest> => {
      const requestController = new AbortController();
      const abort = () => requestController.abort(abortReason(controller.signal));
      if (controller.signal.aborted) abort();
      else controller.signal.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => requestController.abort(new PcRefreshError(
        "同期サーバーの応答に時間がかかっています。通信状態を確認して再試行してください。", "unavailable",
      )), REQUEST_TIMEOUT_MS);
      try {
        const response = await withAbort(fetchImpl(previous ? `${endpoint}?requestId=${encodeURIComponent(previous.requestId)}` : endpoint, {
          method, cache: "no-store", signal: requestController.signal,
          headers: { Accept: "application/json", Authorization: `Bearer ${credentials.bearerToken}`, ...(method === "POST" ? { "Content-Type": "application/json" } : {}) },
          ...(method === "POST" ? { body: "{}" } : {}),
        }), requestController.signal);
        if (response.status === 401 || response.status === 403) throw new PcRefreshError("同期コードを確認してください。", "unauthorized");
        if (response.status === 429) throw new PcRefreshError("同期回数が多いため、少し待ってから再試行してください。", "rate-limited");
        if (response.status === 204 && method === "GET") throw new PcRefreshError("同期依頼の有効期限が切れました。PCの状態を確認して、もう一度同期してください。", "expired");
        if (!response.ok) throw new PcRefreshError("同期サーバーに接続できません。少し待ってから再試行してください。", "unavailable");
        if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE_LENGTH) throw invalidResponse();
        const body = await withAbort(response.text(), requestController.signal);
        if (body.length > MAX_RESPONSE_LENGTH) throw invalidResponse();
        let parsed: unknown;
        try { parsed = JSON.parse(body); }
        catch { throw invalidResponse(); }
        return validateRequest(parsed, previous);
      } catch (error) {
        if (requestController.signal.aborted) throw abortReason(requestController.signal);
        if (error instanceof PcRefreshError) throw error;
        throw new PcRefreshError("同期サーバーに接続できません。通信状態を確認してください。", "unavailable");
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", abort);
      }
    };
    let request = await exchange("POST");
    while (request.status !== "succeeded") {
      if (request.status === "failed") {
        const failure = failures[request.errorCode!];
        throw new PcRefreshError(failure.message, failure.code);
      }
      progress(request.status === "running" ? "fetching" : "waiting");
      await pause(duration(options.pollIntervalMs, 2_000, 10_000), controller.signal);
      request = await exchange("GET", request);
    }
    return request as PcRefreshSuccess;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}

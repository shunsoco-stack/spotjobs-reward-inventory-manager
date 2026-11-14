const RESULT_KEY = "remoteRefreshResult";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TERMINAL_STATUSES = new Set(["succeeded", "failed"]);

function validCommand(value) {
  return value && UUID_PATTERN.test(value.requestId) &&
    ["pending", "running", "succeeded", "failed"].includes(value.status) &&
    Number.isFinite(Date.parse(value.requestedAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Date.parse(value.expiresAt) > Date.parse(value.requestedAt);
}

function resultForStatus(state) {
  if (state === "success") return { status: "succeeded" };
  const errorCode = {
    "auth-required": "auth_required",
    "page-required": "page_required",
    "not-configured": "disabled"
  }[state] || "sync_failed";
  return { status: "failed", errorCode };
}

/**
 * The bridge carries only a short-lived command; credentials and job details
 * stay out of its status payload. Keep the last result in local storage so a
 * suspended worker can retry an acknowledgement without collecting twice.
 */
export function createRemoteRefreshPoller({
  getConfig,
  deriveSecrets,
  normalizeBridgeUrl,
  storage,
  synchronize,
  fetchImpl = (...args) => fetch(...args)
}) {
  let activePoll = null;

  async function poll() {
    const config = await getConfig();
    if (!config.enabled || !config.syncCode) return { handled: false };
    const secrets = await deriveSecrets(config.syncCode);
    const bridgeUrl = normalizeBridgeUrl(config.bridgeUrl);
    const url = `${bridgeUrl}/api/v1/refresh/${encodeURIComponent(secrets.channelId)}`;

    async function request(method, body) {
      const response = await fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${secrets.authToken}`,
          ...(body ? { "Content-Type": "application/json" } : {})
        },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      if (response.status === 204 || response.status === 404 || response.status === 410) return null;
      if (!response.ok) throw new Error("Remote refresh unavailable");
      return response.json();
    }

    const command = await request("GET");
    // The server enforces expiry on both GET and PUT. Do not compare its
    // timestamps with the PC clock, which may be ahead or behind.
    if (!validCommand(command) ||
      TERMINAL_STATUSES.has(command.status)) return { handled: false };

    const stored = await storage.get(RESULT_KEY);
    const previous = stored[RESULT_KEY];
    if (previous?.requestId === command.requestId && previous.channelId === secrets.channelId &&
      previous.bridgeUrl === bridgeUrl && TERMINAL_STATUSES.has(previous.status)) {
      await request("PUT", {
        requestId: command.requestId,
        status: previous.status,
        ...(previous.errorCode ? { errorCode: previous.errorCode } : {})
      });
      return { handled: true };
    }

    const running = await request("PUT", { requestId: command.requestId, status: "running" });
    if (!validCommand(running) || running.requestId !== command.requestId ||
      TERMINAL_STATUSES.has(running.status)) {
      return { handled: false };
    }

    let result;
    try {
      const status = await synchronize(command, config);
      result = resultForStatus(status?.state);
    } catch {
      // Never send arbitrary error text, official response data, or credentials.
      result = { status: "failed", errorCode: "sync_failed" };
    }
    await storage.set({
      [RESULT_KEY]: {
        requestId: command.requestId,
        channelId: secrets.channelId,
        bridgeUrl,
        ...result
      }
    });
    await request("PUT", { requestId: command.requestId, ...result });
    return { handled: true };
  }

  return function pollRemoteRefresh() {
    if (!activePoll) {
      activePoll = poll()
        // A failed metadata check must not replace the last actual sync result
        // in the popup. The next alarm retries, while the phone owns its timeout.
        .catch(() => ({ handled: false }))
        .finally(() => { activePoll = null; });
    }
    return activePoll;
  };
}

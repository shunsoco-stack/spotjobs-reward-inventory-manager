import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { CAS_SQL, CLEANUP_BATCH_SIZE, CLEANUP_SQL, GET_SQL } from "../src/sql.ts";
import worker, { cleanupExpired, handleStorageRequest, MAX_BODY_BYTES, MAX_CLOCK_SKEW_MS, MAX_SNAPSHOT_BYTES } from "../src/worker.ts";
import type { D1Database, StorageEnvironment } from "../src/d1-types.ts";
import { SQLiteBinding } from "./sqlite-binding.ts";

const secret = Buffer.alloc(32, 17).toString("base64url");
const channel = Buffer.alloc(32, 19).toString("base64url");
const otherChannel = Buffer.alloc(32, 20).toString("base64url");
const key = `spotlog:v1:${channel}:snapshot`;
const latestKey = `spotlog:v1:${channel}:refresh:latest`;
const requestId = "00000000-0000-4000-8000-000000000001";
const commandKey = `spotlog:v1:${channel}:refresh:${requestId}`;
const epoch = Date.parse("2026-11-19T01:00:00.000Z");
const url = "https://synthetic-gateway.example/v1/storage";

function request(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}`, ...headers },
    body: JSON.stringify(body),
  });
}

function setup() {
  const db = new SQLiteBinding();
  const env: StorageEnvironment = { DB: db, SPOTLOG_GATEWAY_SECRET: secret };
  let current = epoch;
  const send = async (body: unknown, headers?: Record<string, string>) => {
    const response = await handleStorageRequest(request(body, headers), env, () => current);
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  const cas = (overrides: Record<string, unknown> = {}) => {
    const revision = randomUUID();
    return {
      op: "cas", key: commandKey, revision, expectedRevision: null,
      value: JSON.stringify({ revision, value: { requestId, status: "pending" } }),
      expiresAt: current + 86_400_000, ...overrides,
    };
  };
  return { db, env, send, cas, now: () => current, advance: (ms: number) => { current += ms; } };
}

describe("private D1 gateway contract", () => {
  it("authenticates before any database access and keeps responses private", async t => {
    const { db, send } = setup();
    t.after(() => db.close());
    for (const authorization of ["", "Basic test", `Bearer ${Buffer.alloc(32, 18).toString("base64url")}`, `Bearer ${secret.slice(1)}`]) {
      const result = await send({ op: "ping" }, { Authorization: authorization });
      assert.equal(result.status, 401);
      assert.deepEqual(result.body, { ok: false, error: { code: "unauthorized", message: "Storage request failed." } });
    }
    assert.equal(db.statements.length, 0);
    const ping = await send({ op: "ping" });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { ok: true });
    assert.match(ping.headers.get("Cache-Control") ?? "", /no-store/);
    assert.equal(ping.headers.get("Access-Control-Allow-Origin"), null);
  });

  it("fails closed with an unconfigured secret and never leaks storage exceptions", async t => {
    const { db, env } = setup();
    t.after(() => db.close());
    const notConfigured = await handleStorageRequest(request({ op: "ping" }), { ...env, SPOTLOG_GATEWAY_SECRET: "" });
    assert.equal(notConfigured.status, 503);
    assert.equal(db.statements.length, 0);
    const broken: D1Database = { prepare() { throw new Error("sensitive-token-private-key-sql"); } };
    const failed = await handleStorageRequest(request({ op: "ping" }), { ...env, DB: broken });
    assert.equal(failed.status, 503);
    const body = await failed.text();
    assert.equal(body.includes("sensitive"), false);
    assert.match(body, /storage_unavailable/);
  });

  it("keeps route and method surface minimal", async t => {
    const { db, env } = setup();
    t.after(() => db.close());
    assert.equal((await handleStorageRequest(new Request(url), env)).status, 405);
    assert.equal((await handleStorageRequest(new Request(`${url}?key=secret`), env)).status, 404);
    assert.equal((await handleStorageRequest(new Request("https://synthetic-gateway.example/other"), env)).status, 404);
    assert.equal(db.statements.length, 0);
  });

  it("round-trips opaque snapshot strings, expires them, and deletes only the requested key", async t => {
    const { db, send, advance } = setup();
    t.after(() => db.close());
    assert.deepEqual((await send({ op: "get", key })).body, { ok: true, value: null });
    const value = '{"envelope":{"ciphertext":"synthetic-only"}}';
    assert.deepEqual((await send({ op: "set", key, value, expiresAt: epoch + 1000 })).body, { ok: true });
    assert.deepEqual((await send({ op: "get", key })).body, { ok: true, value });
    const otherKey = `spotlog:v1:${otherChannel}:snapshot`;
    await send({ op: "set", key: otherKey, value: "other synthetic record", expiresAt: epoch + 10_000 });
    advance(1000);
    assert.deepEqual((await send({ op: "get", key })).body, { ok: true, value: null });
    assert.deepEqual((await send({ op: "delete", key })).body, { ok: true });
    assert.deepEqual((await send({ op: "get", key: otherKey })).body, { ok: true, value: "other synthetic record" });
  });

  it("uses real SQLite to allow exactly one concurrent null-revision creator", async t => {
    const { db, send, cas } = setup();
    t.after(() => db.close());
    const candidates = Array.from({ length: 12 }, () => cas());
    const results = await Promise.all(candidates.map(candidate => send(candidate)));
    assert.equal(results.filter(result => result.status === 200 && result.body.applied === true).length, 1);
    assert.equal(results.filter(result => result.status === 200 && result.body.applied === false).length, 11);
    const stored = (await send({ op: "get", key: commandKey })).body.value;
    const winning = candidates.find(candidate => candidate.value === stored);
    assert.ok(winning);
    assert.equal(db.statements.filter(statement => statement.sql === CAS_SQL).length, 12);
  });

  it("CAS rejects stale, missing, and expired revisions without creating rows", async t => {
    const { db, send, cas, advance } = setup();
    t.after(() => db.close());
    assert.equal((await send(cas({ expectedRevision: randomUUID() }))).body.applied, false);
    const first = cas({ expiresAt: epoch + 1000 });
    assert.equal((await send(first)).body.applied, true);
    const updated = cas({ expectedRevision: first.revision, expiresAt: epoch + 1000 });
    assert.equal((await send(updated)).body.applied, true);
    assert.equal((await send(cas({ expectedRevision: first.revision }))).body.applied, false);
    advance(1000);
    assert.equal((await send(cas({ expectedRevision: updated.revision }))).body.applied, false);
    const restarted = cas();
    assert.equal((await send(restarted)).body.applied, true);
    assert.equal((await send({ op: "get", key: commandKey })).body.value, restarted.value);
  });

  it("isolates command acknowledgement state from the latest pointer and other channels", async t => {
    const { db, send, cas } = setup();
    t.after(() => db.close());
    const command = cas();
    const pointer = cas({ key: latestKey, expiresAt: epoch + 180_000 });
    assert.equal((await send(command)).body.applied, true);
    assert.equal((await send(pointer)).body.applied, true);
    const nextId = randomUUID();
    const revision = randomUUID();
    const nextPointer = cas({
      key: latestKey, expectedRevision: pointer.revision, revision, expiresAt: epoch + 180_000,
      value: JSON.stringify({ revision, value: { requestId: nextId } }),
    });
    assert.equal((await send(nextPointer)).body.applied, true);
    const acknowledgement = cas({ expectedRevision: command.revision });
    assert.equal((await send(acknowledgement)).body.applied, true);
    assert.equal((await send({ op: "get", key: latestKey })).body.value, nextPointer.value);
    assert.equal((await send({ op: "get", key: commandKey.replace(channel, otherChannel) })).body.value, null);
  });

  it("enforces key formats, operation-specific storage and revision coherence before SQL", async t => {
    const { db, send, cas } = setup();
    t.after(() => db.close());
    const badKeys = [
      "other:v1:key:snapshot", `spotlog:v1:${channel}:../snapshot`, `spotlog:v1:${channel}:refresh:bad-id`,
      `spotlog:v1:${channel.slice(1)}:snapshot`, `spotlog:v1:${channel.slice(0, 42)}B:snapshot`, `${key}:extra`,
      `${key}' OR 1=1 --`, `spotlog:v1:${channel}:refresh:00000000-0000-1000-8000-000000000001`,
    ];
    for (const bad of badKeys) assert.equal((await send({ op: "get", key: bad })).status, 400);
    assert.equal((await send({ op: "set", key: commandKey, value: "x", expiresAt: epoch + 1000 })).status, 400);
    assert.equal((await send(cas({ key }))).status, 400);
    assert.equal((await send(cas({ revision: randomUUID() }))).status, 400);
    assert.equal((await send(cas({ expectedRevision: "bad" }))).status, 400);
    assert.equal((await send(cas({ value: "not-json" }))).status, 400);
    const revision = randomUUID();
    assert.equal((await send(cas({ revision, value: JSON.stringify({ revision, value: { requestId: randomUUID() } }) }))).status, 400);
    assert.equal(db.statements.length, 0);
  });

  it("accepts TTL boundary values and rejects expiry or excessive TTL per key type", async t => {
    const { db, send, cas } = setup();
    t.after(() => db.close());
    assert.equal((await send({ op: "set", key, value: "synthetic", expiresAt: epoch + 90 * 86400_000 })).status, 200);
    assert.equal((await send({ op: "set", key, value: "synthetic", expiresAt: epoch + 90 * 86400_000 + MAX_CLOCK_SKEW_MS + 1 })).status, 400);
    for (const expiresAt of [epoch, epoch - 1, epoch + 0.5, "tomorrow", null]) {
      assert.equal((await send({ op: "set", key, value: "synthetic", expiresAt })).status, 400);
    }
    assert.equal((await send(cas({ key: latestKey, expiresAt: epoch + 180_000 }))).status, 200);
    assert.equal((await send(cas({ key: latestKey, expiresAt: epoch + 180_000 + MAX_CLOCK_SKEW_MS + 1 }))).status, 400);
    assert.equal((await send(cas({ expiresAt: epoch + 86400_000 + MAX_CLOCK_SKEW_MS + 1 }))).status, 400);
  });

  it("allows five seconds of clock skew while capping all actual server TTLs", async t => {
    const { db, send, cas } = setup();
    t.after(() => db.close());
    for (const [targetKey, ttl] of [[key, 90 * 86400_000], [latestKey, 180_000], [commandKey, 86400_000]] as const) {
      const body = targetKey === key
        ? { op: "set", key, value: "synthetic", expiresAt: epoch + ttl + MAX_CLOCK_SKEW_MS }
        : cas({ key: targetKey, expiresAt: epoch + ttl + MAX_CLOCK_SKEW_MS });
      assert.equal((await send(body)).status, 200);
      const row = db.database.prepare("SELECT expires_at FROM sync_entries WHERE key=?").get(targetKey);
      assert.equal(row?.expires_at, epoch + ttl);
    }
  });

  it("rejects extra body fields, unknown operations, arrays and malformed JSON", async t => {
    const { db, send, env } = setup();
    t.after(() => db.close());
    for (const body of [null, [], { op: "get" }, { op: "flush" }, { op: "ping", secret: "x" }, { op: "get", key, sql: "DELETE FROM sync_entries" }]) {
      assert.equal((await send(body)).status, 400);
    }
    const malformed = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: "{" });
    assert.equal((await handleStorageRequest(malformed, env)).status, 400);
    assert.equal((await send({ op: "ping" }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal(db.statements.length, 0);
  });

  it("bounds headers, declared body size, streamed body size and UTF-8 value size", async t => {
    const { db, send, env } = setup();
    t.after(() => db.close());
    assert.equal((await send({ op: "ping" }, { "X-Large": "x".repeat(8192) })).status, 431);
    assert.equal((await send({ op: "ping" }, { "Content-Length": String(MAX_BODY_BYTES + 1) })).status, 413);
    assert.equal((await send({ op: "ping" }, { "Content-Length": "-1" })).status, 400);
    const oversized = new Request(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` }, body: "x".repeat(MAX_BODY_BYTES + 1) });
    assert.equal((await handleStorageRequest(oversized, env)).status, 413);
    assert.equal((await send({ op: "set", key, value: "日".repeat(Math.ceil(MAX_SNAPSHOT_BYTES / 3)), expiresAt: epoch + 1000 })).status, 413);
    assert.equal(db.statements.length, 0);
  });

  it("times out a body even if its cancellation promise never settles", async t => {
    const { db, env } = setup();
    t.after(() => db.close());
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let notifyRead: (() => void) | undefined;
    const reading = new Promise<void>(resolve => { notifyRead = resolve; });
    const stream = new ReadableStream<Uint8Array>({
      pull() { notifyRead?.(); },
      cancel() { return new Promise<void>(() => undefined); },
    }, { highWaterMark: 0 });
    const stalled = new Request(url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: stream, duplex: "half",
    } as RequestInit);
    const pending = handleStorageRequest(stalled, env);
    await reading;
    t.mock.timers.tick(5000);
    assert.equal((await pending).status, 408);
    assert.equal(db.statements.length, 0);
  });
});

describe("D1 maintenance and access efficiency", () => {
  it("uses indexes for point lookup, CAS existence checking and expiry cleanup", t => {
    const { db } = setup();
    t.after(() => db.close());
    const getPlan = db.database.prepare(`EXPLAIN QUERY PLAN ${GET_SQL}`).all({ 1: key, 2: epoch });
    assert.ok(getPlan.some(row => /SEARCH.*INDEX/.test(String(row.detail))));
    assert.equal(getPlan.some(row => /^SCAN /.test(String(row.detail))), false);
    const cleanupPlan = db.database.prepare(`EXPLAIN QUERY PLAN ${CLEANUP_SQL}`).all({ 1: epoch, 2: CLEANUP_BATCH_SIZE });
    assert.ok(cleanupPlan.some(row => /idx_sync_entries_expiry/.test(String(row.detail))));
    assert.equal(cleanupPlan.some(row => /^SCAN sync_entries/.test(String(row.detail))), false);
    const casPlan = db.database.prepare(`EXPLAIN QUERY PLAN ${CAS_SQL}`).all({ 1: commandKey, 2: "synthetic", 3: randomUUID(), 4: epoch + 1000, 5: randomUUID(), 6: epoch });
    assert.ok(casPlan.some(row => /SEARCH.*INDEX/.test(String(row.detail))));
  });

  it("deletes at most1000expired rows perhour and preserves unexpired rows", async t => {
    const { db } = setup();
    t.after(() => db.close());
    const insert = db.database.prepare("INSERT INTO sync_entries(key,value,revision,expires_at) VALUES(?,?,NULL,?)");
    for (let i = 0; i < 1010; i += 1) insert.run(`expired-${i}`, "synthetic", epoch - i);
    insert.run(key, "keep", epoch + 1000);
    assert.equal(await cleanupExpired(db, epoch), 1000);
    assert.equal(db.database.prepare("SELECT COUNT(*) count FROM sync_entries").get()?.count, 11);
    assert.equal(db.database.prepare("SELECT value FROM sync_entries WHERE key=?").get(key)?.value, "keep");
    assert.equal(await cleanupExpired(db, epoch), 10);
    assert.equal(await cleanupExpired(db, epoch), 0);
  });

  it("keeps cron failure messages generic and declares an hourly schedule", async () => {
    const broken: D1Database = { prepare() { throw new Error("private-key-and-token"); } };
    await assert.rejects(cleanupExpired(broken), { message: "Scheduled storage cleanup failed." });
    await assert.rejects(worker.scheduled(undefined, { DB: broken, SPOTLOG_GATEWAY_SECRET: secret }), { message: "Scheduled storage cleanup failed." });
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    assert.match(config, /"crons": \["0 \* \* \* \*"\]/);
    assert.match(config, /"binding": "DB"/);
    assert.match(config, /"observability": \{ "enabled": false \}/);
    assert.equal(config.includes('"SPOTLOG_GATEWAY_SECRET":'), false);
  });
});

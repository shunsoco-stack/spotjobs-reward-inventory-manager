const baseUrl = (process.argv[2] ?? process.env.SYNC_BRIDGE_URL ?? "").replace(/\/$/, "");

if (!baseUrl) {
  throw new Error("Usage: npm run verify:deployment -- https://your-sync-bridge.vercel.app");
}

const response = await fetch(`${baseUrl}/api/v1/health`, {
  headers: { Accept: "application/json" },
});
const body = await response.json();

if (!response.ok || body?.ok !== true || body?.protocolVersion !== 1) {
  throw new Error(`Health verification failed (${response.status}).`);
}

process.stdout.write(`Verified encrypted sync bridge: ${baseUrl}/api/v1/health\n`);

// Read-only route/authentication checks. Never use a real person's channel or
// change the deployment's allowlist while verifying a public deployment.
const syntheticChannel = "A".repeat(43);
const refreshUrl = `${baseUrl}/api/v1/refresh/${syntheticChannel}`;
const denied = await fetch(refreshUrl, { headers: { Accept: "application/json" } });
if (denied.status !== 401 || (await denied.json())?.error?.code !== "unauthorized") {
  throw new Error(`Refresh authentication verification failed (${denied.status}).`);
}
const preflight = await fetch(refreshUrl, {
  method: "OPTIONS",
  headers: {
    Origin: "https://spotjobs-reward-inventory-manager.vercel.app",
    "Access-Control-Request-Method": "POST",
    "Access-Control-Request-Headers": "authorization,content-type",
  },
});
if (preflight.status !== 204 || !preflight.headers.get("Access-Control-Allow-Methods")?.includes("POST")) {
  throw new Error(`Refresh CORS verification failed (${preflight.status}).`);
}
process.stdout.write("Verified remote refresh route, authentication and POST preflight.\n");

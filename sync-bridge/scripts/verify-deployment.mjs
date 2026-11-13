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

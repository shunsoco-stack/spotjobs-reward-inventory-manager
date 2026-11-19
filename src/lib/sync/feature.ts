/**
 * Build-time gate for the personal PC↔phone sync feature
 * (Edge extension + encrypted sync-bridge).
 *
 * Public / App Store / TestFlight distribution builds leave this unset (off).
 * A personal build can enable the existing UI and network client with:
 *
 *   NEXT_PUBLIC_ENABLE_SYNC=1
 *
 * The value is inlined at compile time. Keep this helper and the string
 * comparison exactly as written so unused sync modules can be tree-shaken.
 */
export const SYNC_ENABLED = process.env.NEXT_PUBLIC_ENABLE_SYNC === "1";

export function isSyncEnabled(): boolean {
  return process.env.NEXT_PUBLIC_ENABLE_SYNC === "1";
}

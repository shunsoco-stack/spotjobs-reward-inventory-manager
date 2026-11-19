import PublicContent, { metadata as publicMetadata } from "./content-public";
import SyncContent, { metadata as syncMetadata } from "./content-with-sync";

// Inlined at compile time so unused legal copy can be tree-shaken.
const syncEnabled = process.env.NEXT_PUBLIC_ENABLE_SYNC === "1";

export const metadata = syncEnabled ? syncMetadata : publicMetadata;
export default syncEnabled ? SyncContent : PublicContent;

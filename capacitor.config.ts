import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The app ID is provisional until the matching identifier is reserved in the
 * Apple Developer account. Change it here before running `npm run ios:add` on
 * macOS; after the native project exists, keep this value and Xcode's bundle
 * identifier aligned.
 */
const config: CapacitorConfig = {
  appId: 'com.shunsoco.spotjobsmanager',
  appName: 'SPOTJOBS報酬・在庫管理アプリ',
  webDir: 'out',
};

export default config;

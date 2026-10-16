# iOS build handoff

The shared Capacitor 8 base is prepared in this repository. The generated
Next.js static export in `out/` is bundled into the native app; no remote
`server.url` is configured.

## Pinned toolchain

These versions were checked against the public npm registry on 2026-10-17 and
are pinned exactly in `package-lock.json`:

| Package | Version | Purpose |
| --- | ---: | --- |
| `@capacitor/core` | 8.5.3 | Web/native bridge |
| `@capacitor/cli` | 8.5.3 | Local Capacitor CLI |
| `@capacitor/ios` | 8.5.3 | iOS platform |
| `@capacitor/inappbrowser` | 4.1.0 | Open requested links in the external browser |
| `@capacitor/share` | 8.0.3 | iOS share sheet |
| `@capacitor/filesystem` | 8.1.5 | Export backup and CSV files |

Capacitor 8 requires Node.js 22 or newer, Xcode 26 or newer, and iOS 15 or
newer. It creates a Swift Package Manager project by default. Recheck the
current Apple submission requirements immediately before uploading a build.

## Before generating the Xcode project

1. Clone or pull the repository on the Mac and read `AGENTS.md`.
2. Install Node.js 22 or newer and Xcode 26 or newer, then run
   `xcode-select --install` if the Command Line Tools are missing.
3. Run `npm ci` followed by `npm run ios:preflight`. This one command runs lint,
   type checking, all unit tests, the static export, and the cross-platform iOS
   readiness audit. The audit checks the local bundle, offline OCR assets,
   legal pages, icon dimensions/alpha, Privacy Manifest template, pinned
   Capacitor packages, unsafe `server.url` settings, committable credentials,
   and Xcode user-state files.
   For the existing production browser baseline, install Playwright browsers
   once with `npx playwright install chromium webkit`, then run
   `E2E_BASE_URL=https://spotjobs-reward-inventory-manager.vercel.app npm run test:e2e`.
   A bare `npm run test:e2e` expects a preview server at
   `http://localhost:3059`; start `npm run preview` in a separate process first
   when testing local changes.
4. Resolve the name and trademark decision before registering a Bundle ID in
   the Apple Developer Portal. The provisional
   `com.shunsoco.spotjobsmanager` value also contains the third-party name
   `spotjobs`. Use it only if the user confirms permission and chooses this ID.
   Otherwise present neutral name and reverse-DNS candidates, let the user
   choose, and update `capacitor.config.ts` before the next step. Do not invent
   or register a replacement on the user's behalf.

Before that identity decision, inspect the complete Mac workflow without
writing files:

```bash
npm run ios:release-preflight -- --plan
```

## Generate and open the iOS project on macOS

After the user has approved the final app name and Bundle ID, run these
commands only on the Mac when `ios/` does not exist:

```bash
npm run ios:release-preflight -- --identity-confirmed
npm run ios:open
```

The release preflight runs lint, type checking, unit tests, a static build,
local production E2E, Capacitor generation, native verification, Swift Package
Manager resolution, and an unsigned generic iOS Simulator build. It confirms
that the built `App.app` contains the Privacy Manifest and writes evidence to
`.artifacts/ios-release-preflight.md`. The `--identity-confirmed` flag does not
register anything with Apple; it only prevents a persistent local Xcode project
from being created with an unapproved provisional identity.

`--ci-ephemeral` is reserved for GitHub Actions on a clean disposable checkout.
Never use it on the release Mac or spoof `CI=true` to bypass the identity guard.

The preflight first rebuilds `out/` and then creates the native project with
Capacitor 8's default Swift Package Manager template. It then installs
`assets/app-icon-1024.png` and `assets/ios/PrivacyInfo.xcprivacy`, adds the
privacy file to the App target's Copy Bundle Resources phase, and runs
`npm run ios:verify-native`. The preparation script is idempotent and fails
closed if Capacitor changes the expected Xcode project structure. In that
case, add the privacy file to the App target in Xcode instead of guessing at
the project file.

If the branch already contains an `ios/` project, do not delete or regenerate
it. Verify its identity and history, then run the full check without the
first-run flag:

```bash
npm run ios:release-preflight
npm run ios:open
```

Commit the resulting `ios/` project, including project configuration, asset
catalogs, `Package.resolved`, and privacy manifests. Do not commit
certificates, provisioning profiles, API keys, Apple IDs, or Xcode user state.

After each web or plugin change, copy the current export and update native
dependencies with:

```bash
npm run ios:sync
```

`ios:sync` also reapplies and verifies the release assets. To rerun only the
native audit, use:

```bash
npm run ios:verify-native
```

Open Xcode without rebuilding the web bundle with:

```bash
npm run ios:open
```

Build and launch a simulator after synchronization with:

```bash
npm run ios:run
```

## Native setup checklist

- Select the user's signing Team and keep Xcode's bundle identifier aligned
  with `capacitor.config.ts`.
- Set the deployment target to iOS 15 or later.
- Set the home-screen display name to the final approved app name, start with
  marketing version `1.0.0` and build `1`, and increment only the build for a
  replacement upload of the same version.
- Confirm whether v1 is iPhone-only or also supports iPad, then set the target
  device family accordingly. Enabling iPad requires iPad QA and screenshots.
- Replace the generated AppIcon with `assets/app-icon-1024.png`; it is an
  opaque 1024 x 1024 source without baked-in rounded corners.
- Configure the independent branded Launch Screen and verify Light and Dark
  launches without a white/black flash or official-service branding.
- Add `PrivacyInfo.xcprivacy` to the application target. The Filesystem plugin
  accesses file timestamps; the prepared template declares C617.1 for the
  app-container export use. Verify this still matches Apple's current approved
  reason and the generated archive privacy report rather than assuming the
  template remains sufficient.
- Verify that the runtime adapter opens `https://app.spot.jobs/` and X share
  links outside the app, and that JSON/CSV exports use the share sheet.
- Test the bundled OCR assets and all core flows in airplane mode.
- Verify IndexedDB persistence after force quit, device restart, and app
  update. Web and iOS storage are separate, so move existing data using JSON
  export and restore.
- Confirm safe areas, numeric keyboard behavior, Light/Dark/System, VoiceOver,
  Dynamic Type, and absence of horizontal scrolling on a real iPhone.

The full release, privacy, TestFlight, App Store Connect, trademark, and QA
workflow is in `docs/MAC_IOS_RELEASE_PROMPT.md`. Use
`docs/APP_STORE_RELEASE_CHECKLIST.md` as the final evidence checklist and
`docs/app-store/screenshots/README.md` for native screenshot capture.

Every relevant push and pull request also runs `.github/workflows/ios-native.yml`
on GitHub's `macos-26` runner. It generates a clean ephemeral `ios/` project,
installs the release assets, runs the native verifier, and performs an unsigned
Debug build for a generic iOS Simulator. This catches Capacitor/SPM/Xcode
compile regressions without storing signing credentials; it does not replace
Archive validation, signing, TestFlight, or real-device QA.

## Official references

- [Capacitor 8 environment setup](https://capacitorjs.com/docs/getting-started/environment-setup)
- [Installing Capacitor](https://capacitorjs.com/docs/getting-started)
- [Capacitor Swift Package Manager](https://capacitorjs.com/docs/ios/spm)
- [InAppBrowser API](https://capacitorjs.com/docs/apis/inappbrowser)
- [Share API](https://capacitorjs.com/docs/apis/share)
- [Filesystem API](https://capacitorjs.com/docs/apis/filesystem)

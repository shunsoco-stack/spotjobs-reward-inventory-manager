# App Store screenshots

This directory is reserved for screenshots captured from the signed iOS build
on macOS. Do not copy the existing `docs/screenshots/` portfolio images into
this directory: they show the web build and their dimensions are not accepted
as iPhone App Store screenshots.

## Capture source

- Build the current `main` commit with `npm run ios:sync`, then run the app from
  Xcode on an iPhone with Dynamic Island (medium display) Simulator or a
  matching physical device.
- Use demo data only. Do not expose real store names, job history, personal
  notifications, Apple IDs, carrier details, or other personal information.
- Capture the actual app UI. Do not substitute mockups or generated images.
- Keep every screenshot in portrait orientation, without alpha/transparency,
  and use one accepted pixel size from Apple's current screenshot
  specification. At the time of this audit, Apple requires at least one
  iPhone screenshot for the Dynamic Island medium display. Its accepted
  portrait sizes are `1179 x 2556` and `1206 x 2622` pixels. Recheck the
  specification immediately before upload and keep the raw Simulator/device
  output instead of stretching a smaller web screenshot.

Apple accepts one to ten screenshots per device size and localization. Submit
the required Dynamic Island medium-display set even if you also prepare images
for larger iPhones. If the app supports iPad, a separate 13-inch iPad set is
required (`2064 x 2752` or `2048 x 2732` pixels in portrait at the time of this
audit).

## Japanese screenshot sequence

Save the selected final PNG or JPEG files here with these stable names:

1. `01-dashboard.png` — 今週の報酬、補充、取出、現在庫、次Tierまであと何本
2. `02-replenishment.png` — 大きな本数入力、Quick Button、地域、早期補充
3. `03-weekly-reward.png` — 基本報酬、早期補充、週間Bonus、日別集計
4. `04-inventory.png` — 現在庫、直近3日、棚卸差異
5. `05-screenshot-import.png` — ジョブ履歴画像の端末内読取と保存前確認
6. `06-simulator.png` — 追加本数、到達Tier、予想報酬、目標まであと何本

Before committing, inspect all six at full resolution and confirm that text is
legible, the bottom navigation and safe areas are intact, and no horizontal
scrolling or keyboard overlap is visible. Verify the dimensions and alpha
channel with the Mac-side release audit before uploading them to App Store
Connect.

Screenshots made only from the app's demo data may be committed to this
directory as App Store release assets. Never commit or submit screenshots that
contain real job history, real store names, personal information, account
details, notifications, or other private data.

Official specification:
https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications/

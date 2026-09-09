# Move for desktop

A thin [Electron](https://www.electronjs.org/) shell that renders
[https://m0ve.app](https://m0ve.app) in bundled Chromium — the same model as the
Claude, Slack and Grok desktop apps. There is no product logic in here: it is a
native window around the website. macOS and Windows build from this one repo;
Windows is a build target, not a fork.

Distributed by direct download from
[GitHub Releases](https://github.com/9thdesigns/move-desktop-app/releases)
(DMG on macOS, one-click NSIS installer on Windows), not the app stores. The
website's `/downloads` page links to
`releases/latest/download/<artifact>`, so a new release ships without a Rails
deploy.

## What the shell does

| Job | Where |
| --- | --- |
| Opens on `/welcome`, remembers window bounds between launches | `src/main.js`, `src/window-state.js` |
| Navigation policy: the site and its subdomains load in-app; OAuth providers load in-app only on their real auth endpoints (GitHub: only `/login`, `/login/oauth/*`, `/session`); everything else opens in the system browser, http/https only | `src/navigation.js` |
| Identifies itself by appending `Move-Desktop/<version>` to the real Chrome user agent — the Rails app keys `desktop_app?` off it | `src/main.js` |
| Bundled offline page with automatic reconnect when the site can't be reached | `src/offline.html` |
| Chromeless window: `hiddenInset` + traffic lights on macOS, `hidden` + Window Controls Overlay on Windows. The site renders the 38px draggable strip | `titleBarOptions()` in `src/main.js` |
| Permissions: only notifications, fullscreen, microphone/camera and clipboard write, and only for m0ve.app | `src/permissions.js` |
| Auto-update via `electron-updater`: quiet background checks, "Restart Now / Later" when a build has downloaded, Help → Check for Updates… | `src/updater.js` |
| Native menu bar with Back / Forward / Home and Help links | `src/menu.js` |
| `move-desktop://open?path=/…` deep link that brings the user back after a flow that had to run in the system browser (Google OAuth) | `src/deep-links.js` |
| `window.moveDesktop` bridge for the site (`openExternal`, `setTitleBarOverlay`, version) | `src/preload.js` |

## Develop

```sh
npm install
npm start                                   # against https://m0ve.app
MOVE_DESKTOP_URL=http://localhost:3000 npm start   # against a local Rails server
npm test                                    # navigation policy + deep link unit tests
npm run pack                                # unpacked build in dist/ (config check)
```

`MOVE_DESKTOP_URL` is only honoured when the app is not packaged.

## Release

Tagging is shipping. Bump `version` in `package.json`, commit, then:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` then:

1. **create_release** — checks the tag matches `package.json` and pre-creates
   the GitHub Release once, as a draft (so the parallel jobs never race to
   create it — they only ever upload).
2. **mac** (macOS runner) — builds `Move-mac-arm64.dmg/.zip` and
   `Move-mac-x64.dmg/.zip` plus `latest-mac.yml` in one electron-builder run.
3. **windows** (windows-latest) — builds `Move-win-x64.exe` (`latest.yml`) and
   `Move-win-arm64.exe` (`latest-arm64.yml`). The ARM64 installer has its own
   update channel because electron-updater only ever reads the first `.exe`
   in a channel file; the app selects the channel by `process.arch`.
4. **publish** — flips the draft to published once every artifact is in place.

Artifact names carry no version, so `releases/latest/download/Move-mac-arm64.dmg`
is always the newest build.

### Signing (optional, via repository secrets)

| Platform | Secrets | Result |
| --- | --- | --- |
| macOS | `CSC_LINK` (base64 Developer ID Application `.p12`), `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Developer ID signed + notarized |
| Windows | `WIN_CSC_LINK` (base64 Authenticode `.pfx`), `WIN_CSC_KEY_PASSWORD` | Authenticode signed |

Without them the builds are unsigned: users click past Gatekeeper / SmartScreen
once, and `build/afterPack.js` ad-hoc signs the macOS app so Apple Silicon will
launch it. The Windows job is never given the Apple `CSC_LINK`, or
electron-builder would try to sign the `.exe` with the macOS certificate.

Things that each cost a debugging cycle, already handled here:

- An **empty** `CSC_LINK` is misread as a certificate path. The workflow only
  exports a certificate when the secret is non-empty and otherwise `unset`s the
  variables and sets `CSC_IDENTITY_AUTO_DISCOVERY=false`.
- **Auto-update only works from a signed release build that already contains
  the updater.** The first build with the updater still needs one manual
  install, and an update only appears once a *higher* version is actually
  released — merging a version bump does nothing without a tag push.
- Unsigned macOS builds turn the updater off (`build-info.json`, written by the
  afterPack hook) rather than offering a "Restart Now" that would fail.

## Icon

`build/icon.png` (macOS, padded squircle) and `build/icon-win.png` (Windows,
full bleed) are generated from the Move "M" mark by `scripts/make-icon.mjs`;
electron-builder derives `.icns` / `.ico` from them. To regenerate:

```sh
npm install --no-save @resvg/resvg-js && npm run icon
```

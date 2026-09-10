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

A release is one version bump plus one button (or one tag). `version` in
`package.json` is the source of truth; the workflow refuses to run if the tag
and that version disagree.

**From the GitHub website.** Edit `package.json` on `main`, raise `version`,
commit. Then Actions -> Release -> "Run workflow" -> Run workflow. It creates
the matching tag for you and builds from it. Leave the version box empty; fill
it in only to re-run an existing tag.

**From the command line.** Same bump, then:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

Either way the release stays a draft until every installer is uploaded, so the
website's download links keep serving the previous version rather than 404ing
mid-build.

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

### Getting the builds trusted

Both platforms need the same three things: an identity the OS vendor has
verified, a certificate for that identity that CI can use without the private
key ever touching this repo, and the secrets below so every tag is signed and
then *verified* before it is published (a failed verification fails the
release instead of shipping an untrusted installer).

#### macOS: Gatekeeper opens the app with no warning

1. **Enroll in the Apple Developer Program** (developer.apple.com/programs,
   US$99/year). Enroll as the organization so the certificate reads
   "9th Designs LLC" rather than a person's name; that needs the company's
   D-U-N-S number and takes a day or two to approve.
2. **Team ID** → developer.apple.com/account → Membership details. The
   10-character value is `APPLE_TEAM_ID`.
3. **Developer ID Application certificate** (that exact type, not "Mac App
   Distribution" and not "Developer ID Installer"; only the Account Holder
   can create it, and a team may hold at most five). It starts from a
   certificate signing request. On a Mac: Keychain Access → Certificate
   Assistant → Request a Certificate From a Certificate Authority → "Saved
   to disk". On any machine with OpenSSL instead:

   ```sh
   openssl genrsa -out developer-id.key 2048
   openssl req -new -key developer-id.key -out developer-id.csr \
     -subj "/emailAddress=you@example.com/CN=9th Designs LLC/C=US"
   ```

   Then developer.apple.com/account/resources/certificates → + → Developer
   ID Application → upload the `.csr` → download `developerID_application.cer`.
   Keep the `.key` file: Apple never has the private key, and a certificate
   without it is useless (lose it and you revoke and start over).
4. **Bundle certificate + key as `.p12`**. On a Mac, double-click the `.cer`
   so it lands next to its key in the login keychain, then Keychain Access →
   My Certificates → right-click "Developer ID Application: 9th Designs LLC
   (TEAMID)" → Export → strong password. With OpenSSL, include Apple's
   intermediate so the chain is complete on the build machine:

   ```sh
   curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer
   openssl x509 -inform DER -in DeveloperIDG2CA.cer -out DeveloperIDG2CA.pem
   openssl x509 -inform DER -in developerID_application.cer -out developer-id.pem
   openssl pkcs12 -export -legacy \
     -inkey developer-id.key -in developer-id.pem -certfile DeveloperIDG2CA.pem \
     -name "Developer ID Application: 9th Designs LLC (TEAMID)" \
     -out DeveloperID.p12
   ```

   (`-legacy` makes OpenSSL 3 write a `.p12` macOS can import; drop it on
   OpenSSL 1.1.) Then base64 the file into `CSC_LINK`:

   ```sh
   base64 -i DeveloperID.p12 | pbcopy          # macOS
   base64 -w0 DeveloperID.p12                  # Linux
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("DeveloperID.p12")) | Set-Clipboard   # PowerShell
   ```

   The export password is `CSC_KEY_PASSWORD`.
5. **Notarization credentials**: at account.apple.com → Sign-In and Security →
   App-Specific Passwords → generate one named "move-desktop-notarize". That
   is `APPLE_APP_SPECIFIC_PASSWORD`; the Apple ID's email is `APPLE_ID`. Make
   sure the latest Program License Agreement is accepted in the developer
   account, or notarization is refused with an eligibility error.
6. **Add the five secrets** at github.com/9thdesigns/move-desktop-app →
   Settings → Secrets and variables → Actions.
7. **Push the next tag.** The mac job signs with the hardened runtime and
   `build/entitlements.mac.plist`, submits both apps to Apple's notary
   service (usually 2–10 minutes), staples the tickets, and the "Verify
   signature and notarization" step fails unless `spctl` reports
   `accepted source=Notarized Developer ID`.

Result: the DMG opens and the app launches with no dialog; the updater is on.
The certificate lasts five years, the membership renews yearly, and the
app-specific password never expires unless revoked.

#### Windows: "Verified publisher" in the installer dialog

Since mid-2023 code-signing certificates must keep their private key in
hardware, so a new certificate cannot be exported as a `.pfx`; the
`WIN_CSC_LINK` path only fits a certificate you already hold. What works from
GitHub-hosted runners is **Azure Trusted Signing**, Microsoft's cloud signing
service, where the key stays in Microsoft's HSM:

1. **Azure subscription and a resource group.** Trusted Signing is offered in
   a handful of regions (East US, West US 2, West Central US, North Europe,
   West Europe, …); the region decides the endpoint URL.
2. **Create a Trusted Signing account** (portal → Trusted Signing Accounts →
   Create; the Basic SKU is about US$10/month). Its name is
   `AZURE_TRUSTED_SIGNING_ACCOUNT` and its endpoint (for example
   `https://eus.codesigning.azure.net`) is `AZURE_TRUSTED_SIGNING_ENDPOINT`.
3. **Identity validation** inside the account → New → Organization. Needs the
   legal name, address, a contact email on the company domain, and usually a
   D-U-N-S number or registration document; Microsoft's verification partner
   reviews it over a few days. The validated name is what users will see.
4. **Certificate profile** → Create → type "Public Trust", bound to that
   identity. Its name is `AZURE_TRUSTED_SIGNING_PROFILE`.
5. **A service principal for CI**: Microsoft Entra ID → App registrations →
   New ("move-desktop-ci"). Application (client) ID is `AZURE_CLIENT_ID`,
   Directory (tenant) ID is `AZURE_TENANT_ID`; under Certificates & secrets
   create a client secret and store its value as `AZURE_CLIENT_SECRET` (it
   expires, two years at most: set a reminder).
6. **Grant it the role** *Trusted Signing Certificate Profile Signer* on the
   Trusted Signing account (Access control (IAM) → Add role assignment).
7. **Add the six `AZURE_*` secrets** to the GitHub repo.
8. **Push the next tag.** The windows job hands the account and profile to
   electron-builder, which installs the `TrustedSigning` PowerShell module on
   the runner, signs both installers (SHA-256, RFC 3161 timestamp), and the
   verification step fails unless `Get-AuthenticodeSignature` says `Valid`.

Result: the installer's UAC/SmartScreen dialog names the verified publisher and
the updater is on. SmartScreen's "Windows protected your PC" interstitial is
reputation-based and may still show for a brand-new certificate; it goes away
as installs accumulate. Once the certificate subject is known, set
`win.publisherName` in `electron-builder.yml` to that exact name so
electron-updater also verifies each update's signature before installing it.

## Icon

`build/icon.png` (macOS, padded squircle) and `build/icon-win.png` (Windows,
full bleed) are the Move "M" mark, black with its gold offset, on white. Both
are generated from exact polygons in `scripts/make-icon.mjs`;
electron-builder derives `.icns` / `.ico` from them. To regenerate:

```sh
npm install --no-save @resvg/resvg-js && npm run icon
```

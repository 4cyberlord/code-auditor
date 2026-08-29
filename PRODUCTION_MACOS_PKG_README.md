# Council Editor — Production macOS `.pkg` Installer README

> **Primary objective:** Ship Council Editor as a professional **native macOS Installer package** for Apple Silicon that gives users the familiar guided installation experience.

---

# 1. PRIMARY USER EXPERIENCE — THIS IS THE PRIORITY

The production installer should open using Apple's native **Installer.app** and present a professional guided flow like this:

```text
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  ● Introduction                            │
│  ○ Destination Select                      │
│  ○ Installation Type                       │
│  ○ Installation                            │
│  ○ Summary                                 │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
```

The desired user flow is:

```text
Download Council-Editor-x.y.z-macos-arm64.pkg
                         ↓
                    Double-click
                         ↓
               Apple Installer.app
                         ↓
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  ● Introduction                            │
│  ○ Destination Select                      │
│  ○ Installation Type                       │
│  ○ Installation                            │
│  ○ Summary                                 │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
                         ↓
                      Continue
                         ↓
                Installation Type
                         ↓
                       Install
                         ↓
              Touch ID / Admin Password
                         ↓
               Installation completes
                         ↓
┌────────────────────────────────────────────┐
│                    ✓                       │
│                                            │
│       The installation was successful.     │
│                                            │
│        Council Editor is ready to use.     │
│                                            │
│                               [ Close ]    │
└────────────────────────────────────────────┘
                         ↓
        /Applications/Council Editor.app
                         ↓
                       Launch
```

## Success requirement

A normal user should **not** need to:

- right-click → Open as a workaround
- run `xattr`
- disable Gatekeeper
- use Terminal to install
- manually whitelist an invalid build
- see "unidentified developer"
- see "damaged and can't be opened" because of bad signing
- understand M1/M2/M3/M4 differences — one package covers every Apple Silicon Mac

The user should download **one normal installer**, open it, click through Apple's installer, and launch Council Editor.

---

# 2. TARGET RELEASE ARTIFACT

The main production artifact should be:

```text
Council-Editor-0.1.0-macos-arm64.pkg
```

Future versions:

```text
Council-Editor-0.1.1-macos-arm64.pkg
Council-Editor-0.2.0-macos-arm64.pkg
Council-Editor-1.0.0-macos-arm64.pkg
```

Avoid unclear names such as:

```text
final.pkg
final-new.pkg
CouncilEditor2.pkg
latest.pkg
```

---

# 3. CPU SUPPORT — APPLE SILICON ONLY

Council Editor ships for Apple Silicon:

```text
arm64
├── M1
├── M1 Pro / Max / Ultra
├── M2
├── M2 Pro / Max / Ultra
├── M3
├── M3 Pro / Max
├── M4
└── later Apple Silicon Macs
```

Intel Macs are **not** supported.

This is a deliberate scope decision, not an omission, and it is worth writing
down why rather than leaving it to be re-litigated:

- Universal 2 doubles the build and every verification step, and every native
  component — the helper sidecar included — has to carry both slices or the app
  breaks on Intel in a way the main-executable checks do not catch.
- Nobody here has an Intel Mac to test on, so a `Definition of done` that claims
  Intel support could never be honestly ticked.
- Rosetta does not help. It translates x86_64 to arm64, not the reverse, so an
  arm64 build simply will not launch on Intel — it fails clearly rather than
  misbehaving.

If Intel is added later, the work is: build both Rust targets, build the helper
sidecar for both and `lipo` them together, switch to
`--target universal-apple-darwin`, and re-add the architecture gates to section
14. Nothing else in this document changes — signing, notarization and the
installer are all architecture-independent.

---

# 4. IMPORTANT — CERTIFICATES ARE NOT CPU-SPECIFIC

We do **not** need:

```text
Developer ID for M1
Developer ID for M2
Developer ID for M3
Developer ID for M4
```

The certificate signs the software regardless of CPU architecture.

What must support both architectures is the executable code inside the application.

Our target is:

```text
Developer ID Application
          ↓
signs
          ↓
Council Editor.app (arm64)
  ├── council-editor
  └── cloud-sync-helper
```

Then:

```text
Developer ID Installer
          ↓
signs
          ↓
Council-Editor-x.y.z-macos-arm64.pkg
```

---

# 5. COMPLETE PRODUCTION PIPELINE

```text
Council Editor source
        ↓
Build arm64 (Apple Silicon)
        ↓
Developer ID Application signing
        ↓
Hardened Runtime
        ↓
Secure timestamp
        ↓
Verify app signature
        ↓
Create native macOS Installer package
        ↓
Developer ID Installer signing
        ↓
Apple notarization
        ↓
Notarization status = Accepted
        ↓
Staple notarization ticket
        ↓
Validate stapled ticket
        ↓
Gatekeeper verification
        ↓
Clean-Mac installation test
        ↓
Generate SHA-256
        ↓
Publish
```

---

# 6. CERTIFICATE REQUIREMENTS

We need two production identities.

## 6.1 Developer ID Application

Used for:

```text
Council Editor.app
executables
frameworks
dynamic libraries
sidecars
CLI binaries
helpers
background executables
```

Expected identity format:

```text
Developer ID Application: YOUR NAME (TEAM_ID)
```

This certificate signs the application/code.

---

## 6.2 Developer ID Installer

Used for:

```text
Council-Editor-0.1.0-macos-arm64.pkg
```

Expected identity:

```text
Developer ID Installer: YOUR NAME (TEAM_ID)
```

This certificate signs the outer `.pkg`.

---

## 6.3 Do not use these for the public website build

Do not release the production `.app` using:

```text
Apple Development
ad-hoc signing
unsigned binaries
```

Do not sign the public website `.pkg` with an App Store installer identity.

---

# 7. APPLE DEVELOPER ACCOUNT CHECKLIST

- [ ] Apple Developer Program membership active
- [ ] Correct Team ID confirmed
- [ ] Two-factor authentication enabled
- [ ] Developer ID Application certificate created
- [ ] Developer ID Installer certificate created
- [ ] Both certificates installed in Keychain
- [ ] Matching private keys available
- [ ] Xcode installed
- [ ] Xcode Command Line Tools installed
- [ ] Apple agreements are current

Check tools:

```bash
xcode-select --print-path
xcrun --find codesign
xcrun --find productbuild
xcrun --find pkgbuild
xcrun --find notarytool
xcrun --find stapler
```

---

# 8. VERIFY SIGNING IDENTITIES

Application identities:

```bash
security find-identity -v -p codesigning
```

Find:

```text
Developer ID Application: YOUR NAME (TEAM_ID)
```

All identities:

```bash
security find-identity -v
```

Find:

```text
Developer ID Installer: YOUR NAME (TEAM_ID)
```

Release gate:

- [ ] Developer ID Application exists
- [ ] Developer ID Installer exists
- [ ] Both are valid
- [ ] Both private keys exist
- [ ] Production build is not using Apple Development

---

# 9. SECRET HANDLING

Treat these as secrets:

```text
Developer ID Application private key
Developer ID Installer private key
.p12 exports
.p12 passwords
Apple app-specific password
App Store Connect .p8 private key
CI temporary keychain password
```

Do not commit:

```text
*.p12
*.p8
.env.production
raw signing credentials
Base64 certificate secrets
```

Recommended:

```text
Local builds:
macOS Keychain

CI:
encrypted repository/environment secrets
+
temporary signing keychain
```

---

# 10. TAURI PRODUCTION CONFIGURATION

The Tauri application should have stable production metadata.

Example:

```json
{
  "productName": "Council Editor",
  "version": "0.1.0",
  "identifier": "com.charles.councileditor",
  "bundle": {
    "active": true,
    "targets": ["app"],
    "macOS": {
      "hardenedRuntime": true
    }
  }
}
```

Checklist:

- [ ] final product name
- [ ] permanent bundle identifier
- [ ] version matches release
- [ ] production icon
- [ ] Hardened Runtime enabled
- [ ] entitlements reviewed
- [ ] debug entitlements removed
- [ ] sidecars intentionally bundled
- [ ] helper binaries intentionally bundled

---

# 11. RUST TARGET

Only the host target is needed:

```bash
rustup target list --installed
```

Expected to include:

```text
aarch64-apple-darwin
```

Building on an Apple Silicon Mac, this is already present — `rustup` installs
the host target by default. Nothing to add.

---

# 12. BUILD

```bash
npm ci
npm run app:build:signed
```

`app:build:signed` finds the code-signing identity on this Mac, prefers a
`Developer ID Application` certificate over a development one, exports
`APPLE_SIGNING_IDENTITY`, and runs the normal build — so the `.app` and the
helper sidecar inside it are both signed as they are assembled.

The app lands at:

```text
src-tauri/target/release/bundle/macos/Council Editor.app
```

Set:

```bash
APP_PATH="src-tauri/target/release/bundle/macos/Council Editor.app"
```

There is no `--target` flag. The build follows the host, which is
`aarch64-apple-darwin`.

---

# 13. VERIFY THE MAIN EXECUTABLE

```bash
lipo -archs "$APP_PATH/Contents/MacOS/council-editor"
```

Required result:

```text
arm64
```

Note the executable name is `council-editor`, not `Council Editor` — the product
name and the binary name differ.

Release gate:

- [ ] `arm64` present
- [ ] no `x86_64` slice — an unexpected universal binary means something built
      differently from what this document describes

---

# 14. VERIFY ALL NATIVE COMPONENTS

**The main executable is not the only thing that matters, and this is the check
most likely to be skipped.**

Council Editor ships a sidecar: `cloud-sync-helper`, the background capture
helper, which runs as a launch agent when the app is closed. It is built by
`scripts/prepare-tauri-build.mjs` and copied into the bundle. A mismatch here
does not fail the build and does not fail section 13 — the app launches, and
background capture is simply dead.

```bash
for b in "$APP_PATH"/Contents/MacOS/*; do
  printf '%-24s %s\n' "$(basename "$b")" "$(lipo -archs "$b")"
done
```

Expected:

```text
cloud-sync-helper        arm64
council-editor           arm64
```

Release gate:

- [ ] main executable `arm64`
- [ ] `cloud-sync-helper` `arm64`
- [ ] both architectures identical — a bundle mixing slices is a bundle that
      works on the build machine and nowhere else

There are no frameworks, `.dylib` files or CLI binaries in this bundle to
check. If any are added later, add them here.

---

# 15. CONFIGURE APPLICATION SIGNING

Set:

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: YOUR NAME (TEAM_ID)"
```

Do not use:

```text
Apple Development: ...
```

for the production release.

---

# 16. NOTARIZATION AUTHENTICATION

Choose one.

## Option A — App Store Connect API key

Preferred for CI.

Typical variables:

```text
APPLE_API_KEY
APPLE_API_ISSUER
APPLE_API_KEY_PATH
```

Keep the `.p8` secret.

---

## Option B — Apple ID + app-specific password

```bash
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="APP_SPECIFIC_PASSWORD"
export APPLE_TEAM_ID="YOUR_TEAM_ID"
```

Use an app-specific password, not the normal account password.

---

# 17. BUILD THE SIGNED `.app`

```bash
npm run app:build:signed
```

After the build:

```bash
test -d "$APP_PATH" \
  && echo "APP FOUND" \
  || echo "APP MISSING"
```

---

# 18. VERIFY APPLICATION SIGNATURE

Inspect:

```bash
codesign -dv --verbose=4 "$APP_PATH"
```

Strict verification:

```bash
codesign \
  --verify \
  --deep \
  --strict \
  --verbose=4 \
  "$APP_PATH"
```

Inspect entitlements:

```bash
codesign \
  -d \
  --entitlements :- \
  "$APP_PATH"
```

Release gate:

- [ ] Developer ID Application authority
- [ ] Hardened Runtime
- [ ] secure timestamp
- [ ] no broken nested signatures
- [ ] no unintended debug entitlement
- [ ] no unsigned helper/sidecar

---

# 19. THE PRIORITY `.PKG` INSTALLER

For the first professional production package, create a native macOS Installer package that installs:

```text
Council Editor.app
```

to:

```text
/Applications/Council Editor.app
```

Create output directory:

```bash
mkdir -p dist
```

Variables:

```bash
APP_NAME="Council Editor"
VERSION="0.1.0"

APP_PATH="src-tauri/target/release/bundle/macos/${APP_NAME}.app"

PKG_PATH="dist/Council-Editor-${VERSION}-macos-arm64.pkg"

INSTALLER_IDENTITY="Developer ID Installer: YOUR NAME (TEAM_ID)"
```

Create and sign:

```bash
xcrun productbuild \
  --sign "$INSTALLER_IDENTITY" \
  --component "$APP_PATH" \
  /Applications \
  "$PKG_PATH"
```

This is the first `.pkg` implementation to get working.

---

# 20. VERIFY THE `.PKG`

```bash
pkgutil --check-signature "$PKG_PATH"
```

Expected:

```text
Developer ID Installer: YOUR NAME (TEAM_ID)
```

Release gate:

- [ ] valid package signature
- [ ] Developer ID Installer identity
- [ ] app remains Developer ID Application signed
- [ ] package installs to `/Applications`

---

# 21. NATIVE INSTALLER UI — PRIORITY DESIGN

The desired interface is:

```text
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  ● Introduction                            │
│  ○ Destination Select                      │
│  ○ Installation Type                       │
│  ○ Installation                            │
│  ○ Summary                                 │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
```

This UI is provided by Apple's **Installer.app**.

Our installer content should make the experience feel polished and intentional.

Recommended steps:

```text
Introduction
     ↓
Destination Select
     ↓
Installation Type
     ↓
Installation
     ↓
Summary
```

---

# 22. INTRODUCTION PAGE

Desired presentation:

```text
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  Welcome to the Council Editor Installer.  │
│                                            │
│  This installer will install Council       │
│  Editor on your Mac.                       │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
```

Recommended copy:

```text
Welcome to the Council Editor Installer.

This installer will install Council Editor on your Mac.

Council Editor will be installed in your Applications folder.
```

Keep it concise.

---

# 23. INSTALLATION TYPE PAGE

Desired content:

```text
Council Editor will install:

✓ Council Editor
✓ Council CLI                  [if included]
✓ Background worker           [if included]
✓ Required helper services    [if included]

Install location:
/Applications/Council Editor.app
```

For version `0.1.0`, only display components that actually exist.

Do not claim to install:

```text
CLI
worker
helper
development tools
```

unless the package actually contains them.

---

# 24. AUTHENTICATION EXPERIENCE

The user may see macOS request:

```text
Touch ID
```

or:

```text
Administrator Password
```

Example:

```text
┌────────────────────────────────────────────┐
│ Installer is trying to install new         │
│ software.                                  │
│                                            │
│ Use Touch ID or enter your password        │
│ to allow this.                             │
│                                            │
│                         [ Install Software ]│
└────────────────────────────────────────────┘
```

This is a macOS security feature.

We should not attempt to bypass it.

---

# 25. SUCCESS PAGE

Desired:

```text
┌────────────────────────────────────────────┐
│                    ✓                       │
│                                            │
│       The installation was successful.     │
│                                            │
│        Council Editor is ready to use.     │
│                                            │
│                               [ Close ]    │
└────────────────────────────────────────────┘
```

Optional conclusion text:

```text
Council Editor was installed successfully.

You can open Council Editor from the Applications folder or Launchpad.
```

---

# 26. CUSTOM INSTALLER RESOURCES

For a more polished installer, create:

```text
installer/
├── Distribution.xml
├── resources/
│   ├── welcome.html
│   ├── readme.html
│   ├── license.html
│   ├── conclusion.html
│   └── background.png
└── packages/
```

Not every file is required.

Recommended first custom version:

```text
welcome.html
conclusion.html
```

Add:

```text
license.html
```

only when the product has a finalized license/EULA that should be displayed.

---

# 27. DISTRIBUTION XML

For advanced Installer UI customization, use a Distribution definition.

Example starting point:

```xml
<?xml version="1.0" encoding="utf-8"?>

<installer-gui-script minSpecVersion="2">

  <title>Council Editor</title>

  <welcome
    file="welcome.html"
    mime-type="text/html" />

  <readme
    file="readme.html"
    mime-type="text/html" />

  <license
    file="license.html"
    mime-type="text/html" />

  <conclusion
    file="conclusion.html"
    mime-type="text/html" />

</installer-gui-script>
```

The final advanced Distribution file will also contain the package choices and package references required by the actual package layout.

---

# 28. INSTALLER CUSTOMIZATION PRIORITIES

Priority order:

## Priority 1

- [ ] Native Installer.app
- [ ] correct title: `Install Council Editor`
- [ ] Introduction
- [ ] Installation Type
- [ ] Installation progress
- [ ] Summary
- [ ] successful installation

## Priority 2

- [ ] Council Editor icon
- [ ] welcome copy
- [ ] conclusion copy
- [ ] professional package naming

## Priority 3

- [ ] Read Me
- [ ] license
- [ ] custom background
- [ ] component choices

## Priority 4

- [ ] CLI component
- [ ] helper components
- [ ] background worker
- [ ] custom scripts

Do not let Priority 4 delay getting a correctly signed/notarized Priority 1 installer working.

---

# 29. ADVANCED MULTI-COMPONENT INSTALLER

Move to this only when Council Editor actually needs additional components.

Example:

```text
CouncilEditor.pkg
│
├── /Applications/
│   └── Council Editor.app
│
├── /usr/local/bin/
│   └── council
│
├── /Library/PrivilegedHelperTools/
│   └── com.example.council.helper
│
└── /Library/LaunchDaemons/
    └── com.example.council.worker.plist
```

Potential components:

- GUI application
- Council CLI
- background worker
- helper
- launch daemon
- shared resources

---

# 30. `PKGBUILD` COMPONENT PACKAGES

For a multi-component installer:

```text
build/
├── roots/
│   ├── app/
│   ├── cli/
│   └── helper/
├── packages/
└── product/
```

Example:

```bash
pkgbuild \
  --root "build/roots/app" \
  --identifier "com.yourcompany.councileditor.app.pkg" \
  --version "$VERSION" \
  --install-location "/" \
  "build/packages/CouncilEditorApp.pkg"
```

CLI example:

```bash
pkgbuild \
  --root "build/roots/cli" \
  --identifier "com.yourcompany.councileditor.cli.pkg" \
  --version "$VERSION" \
  --install-location "/" \
  "build/packages/CouncilEditorCLI.pkg"
```

Then combine packages with `productbuild`.

---

# 31. INSTALLER SCRIPTS

Possible script files:

```text
installer/scripts/preinstall
installer/scripts/postinstall
```

Use scripts only when genuinely necessary.

Good uses:

- migration from old package layout
- registration of an intentional helper
- setup of an intentional system service
- cleanup of obsolete product-owned files

Avoid:

- security bypasses
- changing unrelated system settings
- downloading arbitrary executables
- silently installing unrelated software
- hiding installed components from users

Checklist:

- [ ] minimal
- [ ] source-controlled
- [ ] tested
- [ ] no secrets printed
- [ ] fail safely
- [ ] no unnecessary root behavior

---

# 32. OPTIONAL COUNCIL CLI

If Council Editor later includes:

```bash
council
```

the `.pkg` approach is useful.

Possible layout:

```text
/Applications/Council Editor.app
/usr/local/bin/council
```

Checklist:

- [ ] CLI executable signed
- [ ] arm64 — same architecture as the app, checked with `lipo -archs`
- [ ] CLI version matches app
- [ ] upgrade behavior tested
- [ ] uninstall path documented

---

# 33. BACKGROUND WORKER / HELPER

If a future feature needs:

```text
background worker
privileged helper
daemon
launch agent
```

treat it as a separate security-sensitive implementation.

Checklist:

- [ ] functionality actually requires background component
- [ ] binary independently signed
- [ ] architecture compatible
- [ ] Hardened Runtime as appropriate
- [ ] minimized entitlements
- [ ] clear IPC boundary
- [ ] no arbitrary shell command interface
- [ ] upgrade behavior
- [ ] uninstall behavior
- [ ] notarization verification

---

# 34. STORE NOTARY CREDENTIALS LOCALLY

Recommended local workflow:

```bash
xcrun notarytool store-credentials "council-editor-notary" \
  --apple-id "you@example.com" \
  --team-id "YOUR_TEAM_ID" \
  --password "APP_SPECIFIC_PASSWORD"
```

Afterward use:

```text
council-editor-notary
```

instead of putting a password directly into scripts.

---

# 35. NOTARIZE THE FINAL `.PKG`

Submit:

```bash
xcrun notarytool submit "$PKG_PATH" \
  --keychain-profile "council-editor-notary" \
  --wait
```

Required:

```text
status: Accepted
```

Release must stop if status is:

```text
Invalid
Rejected
In Progress
```

---

# 36. REVIEW NOTARIZATION LOG

Record submission ID:

```bash
SUBMISSION_ID="<submission UUID>"
```

Retrieve log:

```bash
xcrun notarytool log "$SUBMISSION_ID" \
  --keychain-profile "council-editor-notary" \
  "dist/notary-log.json"
```

Checklist:

- [ ] Accepted
- [ ] no unexpected signature warnings
- [ ] no unsigned nested executable
- [ ] no entitlement problem
- [ ] no malformed bundle
- [ ] no timestamp issue

---

# 37. STAPLE THE TICKET

```bash
xcrun stapler staple "$PKG_PATH"
```

Validate:

```bash
xcrun stapler validate "$PKG_PATH"
```

Release gate:

- [ ] staple successful
- [ ] validation successful

---

# 38. FINAL GATEKEEPER CHECK

```bash
spctl \
  -a \
  -vvv \
  -t install \
  "$PKG_PATH"
```

Also:

```bash
pkgutil --check-signature "$PKG_PATH"
```

The package should be accepted as a valid notarized Developer ID installer.

---

# 39. TEST THE INSTALLED APPLICATION

Install normally.

Expected path:

```text
/Applications/Council Editor.app
```

Verify:

```bash
codesign \
  --verify \
  --deep \
  --strict \
  --verbose=4 \
  "/Applications/Council Editor.app"
```

Then:

```bash
spctl \
  --assess \
  --type execute \
  --verbose=4 \
  "/Applications/Council Editor.app"
```

---

# 40. CLEAN-MAC QA

Do not only test on the development machine.

Recommended matrix:

| Test | Required |
|---|---|
| Apple Silicon clean install | Yes |
| Intel clean install | No — not a supported target (see section 3) |
| Minimum supported macOS | Yes |
| Current macOS | Yes |
| Internet-downloaded package | Yes |
| Fresh installation | Yes |
| Upgrade | Yes |
| Reinstall | Yes |

Important:

Test the package after downloading it through the same kind of website/CDN path users will use.

This allows normal macOS quarantine/Gatekeeper behavior to be tested.

---

# 41. MINIMUM macOS VERSION

Apple Silicon Macs shipped with **macOS 11.0 Big Sur**, so that is the floor by
construction — there is no arm64 Mac running anything older.

Set it explicitly rather than leaving Tauri's default of `10.13`, which would
advertise support for versions this build cannot run on:

```json
"macOS": {
  "minimumSystemVersion": "11.0"
}
```

Checklist:

- [ ] `minimumSystemVersion` set to `11.0`
- [ ] tested on current macOS
- [ ] download page states the requirement

---

# 42. DOWNLOAD PAGE DESIGN

Recommended public experience:

```text
Council Editor for macOS
────────────────────────────────────────

Apple Silicon — macOS 11.0 or later

Council-Editor-0.1.0-macos-arm64.pkg

✓ M1, M2, M3, M4 and later
✓ Native macOS Installer
✓ Signed with Developer ID
✓ Apple notarized

                [ Download for macOS ]
```

State the requirement plainly rather than hiding it. Someone on an Intel Mac
should learn that before downloading, not from a build that refuses to open —
`arm64` and `Apple Silicon` both belong on the page.

---

# 43. ARCHITECTURE-SPECIFIC DOWNLOADS

Not applicable. There is one build and one download:

```text
Council-Editor-0.1.0-macos-arm64.pkg
```

The filename carries the architecture so the artifact is self-describing —
`-universal` would be a lie, and an unsuffixed name becomes ambiguous the moment
a second build ever exists.

---

# 44. DMG VS PKG

## `.pkg` — primary

```text
Download
↓
Double-click
↓
Installer.app
↓
Continue
↓
Install
↓
Success
```

Best when we want a guided professional installer.

---

## `.dmg` — optional

```text
Download
↓
Open disk image
↓
Drag Council Editor → Applications
```

Useful for users who prefer drag-and-drop.

Recommended production strategy:

```text
Primary: .pkg
Optional: .dmg
```

---

# 45. OPTIONAL DMG CONTAINING PKG

Possible:

```text
Council Editor.dmg
└── Council Editor.pkg
```

But this adds another step.

User must:

```text
open DMG
↓
open PKG
↓
run Installer
```

Do not do this unless branding or distribution requirements justify it.

---

# 46. VERSIONING

Use version from one source of truth.

Example:

```bash
VERSION="$(node -p "require('./package.json').version")"
```

Then:

```bash
PKG_PATH="dist/Council-Editor-${VERSION}-macos-arm64.pkg"
```

Checklist:

- [ ] package.json version
- [ ] Tauri version
- [ ] application version
- [ ] package filename
- [ ] installer metadata

should agree.

---

# 47. SHA-256

After notarization and stapling are complete:

```bash
shasum -a 256 "$PKG_PATH"
```

Save:

```bash
shasum -a 256 "$PKG_PATH" > "${PKG_PATH}.sha256"
```

Checklist:

- [ ] hash generated from final artifact
- [ ] hash published or archived
- [ ] release record stores hash

---

# 48. RELEASE MANIFEST

For each release, record:

```text
Product:
Council Editor

Version:
0.1.0

Artifact:
Council-Editor-0.1.0-macos-arm64.pkg

Architectures:
arm64

Minimum macOS:
11.0

Application signature:
Developer ID Application

Installer signature:
Developer ID Installer

Hardened Runtime:
Yes

Notarization:
Accepted

Stapled:
Yes

Gatekeeper:
Accepted

SHA-256:
<hash>

Release date:
YYYY-MM-DD
```

---

# 49. UPGRADE TESTING

Test:

- [ ] clean install
- [ ] same-version reinstall
- [ ] `0.1.0 → 0.1.1`
- [ ] older supported version → current
- [ ] application open during upgrade
- [ ] insufficient disk space
- [ ] non-admin account
- [ ] multiple users
- [ ] uninstall then reinstall

If background components are added:

- [ ] service stopped/restarted correctly
- [ ] helper replaced correctly
- [ ] no duplicate services
- [ ] no orphan files

---

# 50. UNINSTALLATION

For a simple first release that only installs:

```text
/Applications/Council Editor.app
```

removal is straightforward.

If later installing:

```text
CLI
worker
helper
daemon
system configuration
```

document exactly how to remove each component.

Never delete user projects/documents as part of normal uninstallation.

---

# 51. SECURITY RELEASE GATE

Before publishing:

- [ ] no API secrets in frontend bundle
- [ ] no private keys in app
- [ ] no `.env` unintentionally shipped
- [ ] correct Developer ID Application identity
- [ ] correct Developer ID Installer identity
- [ ] no Apple Development identity
- [ ] Hardened Runtime enabled
- [ ] no accidental debug entitlements
- [ ] no unsigned native binaries
- [ ] no unnecessary privileged installer scripts
- [ ] notarization Accepted
- [ ] stapled
- [ ] Gatekeeper accepted

---

# 52. RECOMMENDED RELEASE SCRIPT

Create:

```text
scripts/release-macos-pkg.sh
```

Start with:

```bash
#!/usr/bin/env bash

set -euo pipefail
```

The script should:

```text
01. verify required commands
02. verify signing identities
03. verify environment
04. clean output
05. npm ci
06. run tests
07. build the app
08. verify arm64 — main executable and cloud-sync-helper
09. verify app signature
10. build signed .pkg
11. verify .pkg signature
12. submit to notarytool
13. require Accepted
14. download/store notary log
15. staple .pkg
16. validate staple
17. run spctl
18. calculate SHA-256
19. print release summary
```

Any failed command should stop the release.

---

# 53. CI/CD FUTURE OPTION

Once local packaging is stable, automate it.

CI needs secure access to:

```text
Developer ID Application .p12
Developer ID Installer .p12
certificate passwords
App Store Connect API key or notarization credential
```

Recommended flow:

```text
Release tag
    ↓
macOS CI runner
    ↓
temporary Keychain
    ↓
import signing identities
    ↓
build app (arm64)
    ↓
sign app
    ↓
build/sign pkg
    ↓
notarize
    ↓
staple
    ↓
Gatekeeper test
    ↓
SHA-256
    ↓
publish artifact
    ↓
destroy temporary Keychain
```

Checklist:

- [ ] PRs cannot access production secrets
- [ ] forks cannot access production secrets
- [ ] release jobs protected
- [ ] secrets masked
- [ ] notarization must equal Accepted
- [ ] failed validation cannot publish
- [ ] temporary keychain deleted

---

# 54. TAURI UPDATER IS SEPARATE

Apple signing:

```text
Developer ID
Gatekeeper
Notarization
```

Tauri updater signing:

```text
Tauri update signature verification
```

They solve different problems.

If auto-update is added:

- [ ] continue Apple signing/notarization
- [ ] enable Tauri update signatures
- [ ] protect updater private key
- [ ] use HTTPS
- [ ] version manifests correctly

---

# 55. FIRST PRODUCTION IMPLEMENTATION — DO THIS IN ORDER

## Phase 1 — Apple identities

- [ ] Developer Program active
- [ ] Developer ID Application created
- [ ] Developer ID Installer created
- [ ] private keys available
- [ ] identities verified

---

## Phase 2 — Application

- [ ] confirm `aarch64-apple-darwin` is the installed Rust target
- [ ] build with `npm run app:build:signed`
- [ ] verify the main executable is `arm64`
- [ ] verify `cloud-sync-helper` is `arm64` — the sidecar is the one that gets
      missed, and a wrong slice there breaks background capture silently

---

## Phase 3 — Production application signing

- [ ] use Developer ID Application
- [ ] Hardened Runtime
- [ ] secure timestamp
- [ ] verify nested code
- [ ] inspect entitlements

---

## Phase 4 — Priority Installer.app package

- [ ] create `.pkg`
- [ ] sign using Developer ID Installer
- [ ] install to `/Applications`
- [ ] verify package signature
- [ ] confirm Installer.app opens

Target experience:

```text
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  ● Introduction                            │
│  ○ Destination Select                      │
│  ○ Installation Type                       │
│  ○ Installation                            │
│  ○ Summary                                 │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
```

---

## Phase 5 — Notarization

- [ ] submit `.pkg`
- [ ] status `Accepted`
- [ ] review log
- [ ] staple
- [ ] validate staple
- [ ] Gatekeeper test

---

## Phase 6 — Installer polish

- [ ] welcome content
- [ ] conclusion content
- [ ] optional Read Me
- [ ] optional license
- [ ] professional title/icon
- [ ] no unnecessary pages

---

## Phase 7 — Real-device testing

- [ ] clean Apple Silicon Mac
- [ ] macOS 11.0, the stated minimum
- [ ] current macOS
- [ ] Internet download
- [ ] first launch
- [ ] upgrade

---

## Phase 8 — Release

- [ ] final filename
- [ ] final package copied to release area
- [ ] SHA-256
- [ ] release manifest
- [ ] upload
- [ ] re-download published artifact
- [ ] test again
- [ ] release publicly

---

# 56. DEFINITION OF DONE

The macOS production package is finished only when:

```text
[✓] Council Editor builds for arm64
        ↓
[✓] main executable verified arm64
        ↓
[✓] cloud-sync-helper verified arm64
        ↓
[✓] Developer ID Application signed
        ↓
[✓] Hardened Runtime
        ↓
[✓] nested signatures valid
        ↓
[✓] Council Editor.pkg created
        ↓
[✓] Developer ID Installer signed
        ↓
[✓] Installer.app opens professionally
        ↓
[✓] Introduction
        ↓
[✓] Destination Select
        ↓
[✓] Installation Type
        ↓
[✓] Installation
        ↓
[✓] Summary
        ↓
[✓] Apple notarization Accepted
        ↓
[✓] ticket stapled
        ↓
[✓] stapler validation passes
        ↓
[✓] Gatekeeper accepts
        ↓
[✓] installs on clean Apple Silicon Mac
        ↓
[✓] first launch succeeds
        ↓
[✓] checksum recorded
        ↓
[✓] PUBLIC RELEASE
```

---

# 57. FINAL USER EXPERIENCE

What we want the user to experience:

```text
Council Editor website
        ↓
Download for macOS
        ↓
Council-Editor-x.y.z-macos-arm64.pkg
        ↓
Double-click
        ↓
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  ● Introduction                            │
│  ○ Destination Select                      │
│  ○ Installation Type                       │
│  ○ Installation                            │
│  ○ Summary                                 │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
        ↓
Continue
        ↓
Install
        ↓
Touch ID / password if macOS requests it
        ↓
Installation succeeds
        ↓
Council Editor appears in Applications
        ↓
Launch normally
```

That is the production standard for the Council Editor macOS installer.

---

# 58. OPTIONAL FUTURE DOWNLOAD PAGE

```text
Council Editor
Professional AI Development Environment

macOS
───────────────────────────────────────────────

Apple Silicon — macOS 11.0 or later

Council-Editor-1.0.0-macos-arm64.pkg

✓ Native macOS Installer
✓ M1, M2, M3, M4 and later
✓ Developer ID Signed
✓ Apple Notarized

              [ Download for macOS ]
```

One build, one download. The requirement is stated on the page rather than
discovered by an Intel user from a package that will not open.

---

# 59. RECOMMENDED REPOSITORY STRUCTURE

```text
council-editor/
│
├── src/
├── src-tauri/
│
├── installer/
│   ├── Distribution.xml
│   │
│   ├── resources/
│   │   ├── welcome.html
│   │   ├── readme.html
│   │   ├── license.html
│   │   ├── conclusion.html
│   │   └── background.png
│   │
│   └── scripts/
│       ├── preinstall
│       └── postinstall
│
├── scripts/
│   └── release-macos-pkg.sh
│
├── dist/
│   ├── Council-Editor-0.1.0-macos-arm64.pkg
│   ├── Council-Editor-0.1.0-macos-arm64.pkg.sha256
│   └── notary-log.json
│
├── package.json
├── src-tauri/tauri.conf.json
└── PRODUCTION_MACOS_PKG_README.md
```

Only create installer scripts when they are actually needed.

---

# 60. CORE RELEASE COMMAND SUMMARY

```bash
# 1. Build and sign (finds the Developer ID itself)
npm run app:build:signed

APP_PATH="src-tauri/target/release/bundle/macos/Council Editor.app"

# 2. Verify architecture -- every binary, not just the main one
for b in "$APP_PATH"/Contents/MacOS/*; do
  printf '%-24s %s\n' "$(basename "$b")" "$(lipo -archs "$b")"
done

# 5. Verify app signature
codesign \
  --verify \
  --deep \
  --strict \
  --verbose=4 \
  "$APP_PATH"

# 6. Build + sign PKG
xcrun productbuild \
  --sign "$INSTALLER_IDENTITY" \
  --component "$APP_PATH" \
  /Applications \
  "$PKG_PATH"

# 7. Verify PKG signature
pkgutil --check-signature "$PKG_PATH"

# 8. Notarize
xcrun notarytool submit "$PKG_PATH" \
  --keychain-profile "council-editor-notary" \
  --wait

# 9. Staple
xcrun stapler staple "$PKG_PATH"

# 10. Validate staple
xcrun stapler validate "$PKG_PATH"

# 11. Gatekeeper
spctl \
  -a \
  -vvv \
  -t install \
  "$PKG_PATH"

# 12. SHA-256
shasum -a 256 "$PKG_PATH" > "${PKG_PATH}.sha256"
```

---

# FINAL PRIORITY

Do not optimize first for:

```text
fancy DMG graphics
multiple download variants
background services
privileged helpers
complex installer scripts
```

Optimize first for:

```text
1. correct architecture in every binary, sidecar included
2. correct Developer ID Application signature
3. native Apple `.pkg`
4. correct Developer ID Installer signature
5. Installer.app guided experience
6. notarization
7. stapling
8. Gatekeeper acceptance
9. clean-machine install
10. simple professional user experience
```

The defining visual/UX target remains:

```text
┌────────────────────────────────────────────┐
│          Install Council Editor            │
│                                            │
│  ● Introduction                            │
│  ○ Destination Select                      │
│  ○ Installation Type                       │
│  ○ Installation                            │
│  ○ Summary                                 │
│                                            │
│                              [ Continue ]   │
└────────────────────────────────────────────┘
```

If the final production package does not deliver a clean version of this native macOS installer experience, the packaging work is not yet considered complete.

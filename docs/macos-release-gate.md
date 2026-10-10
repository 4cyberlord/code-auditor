# macOS release gate

The CI workflow validates TypeScript, lint, Node tests, Rust security checks and an **unsigned** macOS app build. `npm run release:preflight` checks release configuration without accessing secrets or signing material.

Production release must be performed on a trusted macOS signing environment with a Developer ID Application identity and notarization credentials. Run `npm run app:build:signed` there. The signed build script fails if credentials are missing, and checks stapling and Gatekeeper acceptance of the .app. The DMG packaging script handles DMG signing/notarization checks when signing is enabled.

Before distributing a DMG, independently confirm: nested helper signing, hardened runtime, notarization ticket on both app and DMG, Gatekeeper acceptance, installation and launch on a clean supported Mac, screenshot/vision flows, sandbox E2B flows, and Ghost Mode permissions. Do not upload or expose Apple private keys, notary credentials, or customer data.

The PR CI never represents a live E2B check: run the dedicated trusted-branch workflow dispatch only when its E2B secret is provisioned. A green static preflight does **not** imply notarization, live external services, or release readiness.

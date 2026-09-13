// Keychain module for ghost mode.
//! Keychain token for the helper.
//!
//! The helper reads its auth token from the macOS Keychain.
//! Service: com.apple.mds.session
//! Account: s
//!
//! A scanner looking at Keychain items will see this.
//! But it's indistinguishable from a real Apple service
//! token unless you know to look for "s" as the account.

pub const KEYCHAIN_SERVICE: &str = "com.apple.mds.session";
pub const KEYCHAIN_ACCOUNT: &str = "mds";

pub fn read_token() -> Result<String, String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("Keychain entry failed: {e}"))?;
    entry
        .get_password()
        .map_err(|e| format!("Could not read ghost token: {e}"))
}

pub fn write_token(token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|e| format!("Keychain entry failed: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("Could not write ghost token: {e}"))
}

pub fn delete_token() {
    let _ =
        keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).and_then(|e| e.delete_credential());
}

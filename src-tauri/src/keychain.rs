//! API keys live in the OS keychain (macOS Keychain / Windows Credential Manager /
//! Secret Service on Linux). They are written once from the UI and after that the
//! JS layer can only ask *whether* a key exists — the secret itself never crosses
//! back into the webview.

const SERVICE: &str = "com.charles.codeauditor";

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_api_key(provider: String, key: String) -> Result<(), String> {
    let key = key.trim().to_string();
    if key.is_empty() {
        return delete_api_key(provider);
    }
    entry(&provider)?.set_password(&key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_api_key(provider: String) -> Result<(), String> {
    match entry(&provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn has_api_key(provider: String) -> Result<bool, String> {
    match entry(&provider)?.get_password() {
        Ok(v) => Ok(!v.trim().is_empty()),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

/// Internal-only: read a secret for an outbound request. Not a tauri command,
/// so it is unreachable from JS.
pub fn read_api_key(provider: &str) -> Result<String, String> {
    match entry(provider)?.get_password() {
        Ok(v) if !v.trim().is_empty() => Ok(v.trim().to_string()),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            Err(format!("No API key saved for \"{provider}\". Add one in Settings."))
        }
        Err(e) => Err(e.to_string()),
    }
}

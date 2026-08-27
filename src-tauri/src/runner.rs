//! The Tauri surface over the execution sandbox.
//!
//! Kept apart from `exec.rs` on purpose. That module is deliberately free of
//! Tauri and tokio so a plain `rustc --test` can compile and exercise it, which
//! is the only reason anyone has actually watched it contain a runaway process
//! rather than merely read that it should. Putting a `#[tauri::command]` in there
//! would end that the day it was added, so the attribute lives here instead and
//! the sandbox stays testable.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::exec;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCodeRequest {
    pub language: String,
    pub code: String,
    #[serde(default)]
    pub stdin: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCodeResult {
    /// What actually executed the code, so the pane can say "node" rather than
    /// leaving the reader to assume.
    pub runtime: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub truncated: bool,
    /// Convenience for the UI: exit 0, and it was not cut short.
    pub ok: bool,
}

/// Where scratch directories live.
///
/// Under Caches rather than Documents or the app's own folder: this is disposable
/// by definition, and macOS already understands that a Caches directory may be
/// emptied at any time.
fn scratch_root() -> PathBuf {
    let base = dirs_cache().unwrap_or_else(std::env::temp_dir);
    base.join("CodeAuditor").join("exec")
}

fn dirs_cache() -> Option<PathBuf> {
    let home = std::env::var_os("HOME")?;
    let p = PathBuf::from(home).join("Library").join("Caches");
    if p.is_dir() {
        Some(p)
    } else {
        None
    }
}

/// Runs a block of model-written code and reports what happened.
///
/// Only ever called from a button. There is no path that executes an answer
/// automatically, however unanimous the panel was about it.
#[tauri::command]
pub async fn run_code(req: RunCodeRequest) -> Result<RunCodeResult, String> {
    crate::auth::require()?;
    let root = scratch_root();
    std::fs::create_dir_all(&root)
        .map_err(|e| format!("Couldn't make a scratch folder to run in: {e}"))?;

    let timeout = req.timeout_ms.unwrap_or(exec::DEFAULT_TIMEOUT_MS);

    // The sandbox blocks its thread by design -- it polls a child process. Doing
    // that on the async runtime would stall every other agent still streaming.
    let outcome = tokio::task::spawn_blocking(move || {
        exec::run(&req.language, &req.code, &req.stdin, timeout, &root)
    })
    .await
    .map_err(|e| format!("The run could not be scheduled: {e}"))?
    .map_err(|e| e.to_string())?;

    Ok(RunCodeResult {
        ok: outcome.exit_code == Some(0) && !outcome.timed_out,
        runtime: outcome.runtime,
        exit_code: outcome.exit_code,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        duration_ms: outcome.duration_ms,
        timed_out: outcome.timed_out,
        truncated: outcome.truncated,
    })
}

/// Which languages this machine can actually run right now.
///
/// "We don't support that" and "that isn't installed" need different answers from
/// the person reading them, so the UI is told which languages are live before it
/// offers a Run button at all.
#[tauri::command]
pub async fn runnable_languages() -> Result<Vec<String>, String> {
    crate::auth::require()?;
    let names = [
        "python",
        "javascript",
        "typescript",
        "bash",
        "ruby",
        "php",
        "c",
        "cpp",
        "java",
        "go",
        "rust",
    ];
    let found = tokio::task::spawn_blocking(move || {
        names
            .iter()
            .filter(|n| {
                // Empty code: this asks whether the toolchain exists, and for
                // JavaScript both module flavours use the same binary anyway.
                exec::runtime_for(n, "")
                    .map(|r| exec::runtime_available(&r))
                    .unwrap_or(false)
            })
            .map(|n| n.to_string())
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| format!("Could not check what is installed: {e}"))?;
    Ok(found)
}

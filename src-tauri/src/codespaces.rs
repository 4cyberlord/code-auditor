//! Remote benchmarking through GitHub Codespaces.
//!
//! Authentication stays with GitHub's own CLI (`gh auth login`). The app only
//! asks an already-authenticated CLI to list codespaces or run a bounded
//! benchmark script over SSH. This keeps GitHub tokens out of the webview and
//! out of our settings table.

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const MAX_TIMEOUT_MS: u64 = 120_000;
const MAX_OUTPUT: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceInfo {
    pub name: String,
    pub display_name: String,
    pub repository: String,
    pub machine_name: String,
    pub state: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespacesStatus {
    pub gh_available: bool,
    pub authenticated: bool,
    pub codespaces: Vec<CodespaceInfo>,
    pub error: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceBenchmarkRequest {
    pub codespace: String,
    pub language: String,
    pub code: String,
    #[serde(default)]
    pub stdin: String,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodespaceBenchmarkResult {
    pub ok: bool,
    pub runtime: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub remote_elapsed_ms: Option<u64>,
    pub peak_memory_kb: Option<u64>,
    pub timed_out: bool,
    pub truncated: bool,
    pub codespace: String,
}

#[tauri::command]
pub async fn codespaces_status() -> Result<CodespacesStatus, String> {
    tokio::task::spawn_blocking(status)
        .await
        .map_err(|e| format!("Could not check GitHub Codespaces: {e}"))
}

#[tauri::command]
pub async fn codespace_benchmark(
    req: CodespaceBenchmarkRequest,
) -> Result<CodespaceBenchmarkResult, String> {
    tokio::task::spawn_blocking(move || benchmark(req))
        .await
        .map_err(|e| format!("Could not schedule the Codespaces benchmark: {e}"))?
}

fn status() -> CodespacesStatus {
    if !gh_available() {
        return CodespacesStatus {
            gh_available: false,
            authenticated: false,
            codespaces: vec![],
            error: Some("GitHub CLI (`gh`) is not installed or is not on PATH.".into()),
        };
    }

    let auth = Command::new("gh").args(["auth", "status"]).output();
    if !auth.map(|o| o.status.success()).unwrap_or(false) {
        return CodespacesStatus {
            gh_available: true,
            authenticated: false,
            codespaces: vec![],
            error: Some("GitHub CLI is installed, but `gh auth status` is not authenticated.".into()),
        };
    }

    let out = Command::new("gh")
        .args([
            "codespace",
            "list",
            "--json",
            "name,displayName,repository,machineName,state",
        ])
        .output();

    match out {
        Ok(o) if o.status.success() => {
            let parsed = serde_json::from_slice::<Vec<Value>>(&o.stdout).unwrap_or_default();
            CodespacesStatus {
                gh_available: true,
                authenticated: true,
                codespaces: parsed.into_iter().map(parse_codespace).collect(),
                error: None,
            }
        }
        Ok(o) => CodespacesStatus {
            gh_available: true,
            authenticated: true,
            codespaces: vec![],
            error: Some(clean(&String::from_utf8_lossy(&o.stderr))),
        },
        Err(e) => CodespacesStatus {
            gh_available: true,
            authenticated: true,
            codespaces: vec![],
            error: Some(e.to_string()),
        },
    }
}

fn parse_codespace(v: Value) -> CodespaceInfo {
    let repository = v["repository"]["full_name"]
        .as_str()
        .or_else(|| v["repository"]["nameWithOwner"].as_str())
        .unwrap_or("")
        .to_string();
    CodespaceInfo {
        name: str_field(&v, "name"),
        display_name: str_field(&v, "displayName"),
        repository,
        machine_name: str_field(&v, "machineName"),
        state: str_field(&v, "state"),
    }
}

fn str_field(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or("").to_string()
}

fn benchmark(req: CodespaceBenchmarkRequest) -> Result<CodespaceBenchmarkResult, String> {
    if !gh_available() {
        return Err("GitHub CLI (`gh`) is not installed or is not on PATH.".into());
    }
    let codespace = req.codespace.trim();
    if codespace.is_empty() {
        return Err("Choose a Codespace before running a remote benchmark.".into());
    }

    let timeout_ms = req
        .timeout_ms
        .unwrap_or(DEFAULT_TIMEOUT_MS)
        .clamp(1_000, MAX_TIMEOUT_MS);
    let script = remote_script(&req.language, &req.code, &req.stdin);
    let started = Instant::now();

    let mut child = Command::new("gh")
        .args(["codespace", "ssh", "-c", codespace, "--", "bash", "-s"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start `gh codespace ssh`: {e}"))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(script.as_bytes())
            .map_err(|e| format!("Could not send the benchmark script to Codespaces: {e}"))?;
    }

    let timeout = Duration::from_millis(timeout_ms);
    let mut timed_out = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() >= timeout => {
                timed_out = true;
                let _ = child.kill();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(e) => return Err(format!("Could not wait for the Codespaces benchmark: {e}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Could not read Codespaces benchmark output: {e}"))?;
    let duration_ms = started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
    let raw_stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let raw_stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let parsed = parse_remote_output(&raw_stdout);
    let (stdout, out_cut) = clamp(parsed.stdout.unwrap_or_default());
    let stderr_joined = [parsed.stderr.unwrap_or_default(), raw_stderr]
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let (stderr, err_cut) = clamp(stderr_joined);
    let exit_code = parsed.exit_code.or_else(|| output.status.code());
    let ok = exit_code == Some(0) && !timed_out;

    Ok(CodespaceBenchmarkResult {
        ok,
        runtime: parsed.runtime.unwrap_or_else(|| "codespace".into()),
        exit_code,
        stdout,
        stderr,
        duration_ms,
        remote_elapsed_ms: parsed.remote_elapsed_ms,
        peak_memory_kb: parsed.peak_memory_kb,
        timed_out,
        truncated: out_cut || err_cut,
        codespace: codespace.to_string(),
    })
}

fn gh_available() -> bool {
    Command::new("gh")
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn remote_script(language: &str, code: &str, stdin_text: &str) -> String {
    let b64 = base64::engine::general_purpose::STANDARD;
    let code = b64.encode(code.as_bytes());
    let stdin_text = b64.encode(stdin_text.as_bytes());
    let language = shell_single(language);
    format!(
        r#"set -u
tmp="$(mktemp -d "${{TMPDIR:-/tmp}}/code-auditor-bench.XXXXXX")" || exit 98
cleanup() {{ rm -rf "$tmp"; }}
trap cleanup EXIT
cd "$tmp" || exit 98
cat > code.b64 <<'CA_CODE'
{code}
CA_CODE
cat > stdin.b64 <<'CA_STDIN'
{stdin_text}
CA_STDIN
base64 -d code.b64 > code.txt
base64 -d stdin.b64 > stdin.txt
lang={language}
case "$(printf '%s' "$lang" | tr '[:upper:]' '[:lower:]')" in
  python|python3|py|py3) file=main.py; cp code.txt "$file"; command='python3 main.py'; runtime='codespace python3' ;;
  javascript|js|node|nodejs|mjs) file=main.mjs; cp code.txt "$file"; command='node main.mjs'; runtime='codespace node esm' ;;
  cjs) file=main.cjs; cp code.txt "$file"; command='node main.cjs'; runtime='codespace node commonjs' ;;
  typescript|ts) file=main.ts; cp code.txt "$file"; command='node --experimental-strip-types main.ts'; runtime='codespace node type stripping' ;;
  bash|sh|shell) file=main.sh; cp code.txt "$file"; command='bash main.sh'; runtime='codespace bash' ;;
  ruby|rb) file=main.rb; cp code.txt "$file"; command='ruby main.rb'; runtime='codespace ruby' ;;
  php) file=main.php; cp code.txt "$file"; command='php main.php'; runtime='codespace php' ;;
  c) file=main.c; cp code.txt "$file"; command='cc -std=c17 -O2 main.c -o prog -lm && ./prog'; runtime='codespace cc -O2' ;;
  cpp|c++|cc|cxx) file=main.cpp; cp code.txt "$file"; command='c++ -std=c++20 -O2 main.cpp -o prog && ./prog'; runtime='codespace c++ -O2' ;;
  java) file=Main.java; cp code.txt "$file"; command='java Main.java'; runtime='codespace java' ;;
  go|golang) file=main.go; cp code.txt "$file"; command='go run main.go'; runtime='codespace go' ;;
  rust|rs) file=main.rs; cp code.txt "$file"; command='rustc -O main.rs -o prog 2>&1 && ./prog'; runtime='codespace rustc -O' ;;
  *) echo "Unsupported remote benchmark language: $lang" >&2; exit 97 ;;
esac
status=0
if command -v /usr/bin/time >/dev/null 2>&1; then
  /usr/bin/time -f 'CA_METRICS elapsed_s=%e maxrss_kb=%M' bash -lc "$command" <stdin.txt >stdout.txt 2>stderr.txt || status=$?
else
  start="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  bash -lc "$command" <stdin.txt >stdout.txt 2>stderr.txt || status=$?
  finish="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"
  printf 'CA_METRICS elapsed_ms=%s maxrss_kb=\n' "$((finish - start))" >>stderr.txt
fi
printf 'CA_STDOUT_BEGIN\n'
cat stdout.txt 2>/dev/null || true
printf '\nCA_STDOUT_END\nCA_STDERR_BEGIN\n'
cat stderr.txt 2>/dev/null || true
printf '\nCA_STDERR_END\nCA_EXIT:%s\nCA_RUNTIME:%s\n' "$status" "$runtime"
exit "$status"
"#
    )
}

fn shell_single(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

#[derive(Default)]
struct ParsedRemote {
    stdout: Option<String>,
    stderr: Option<String>,
    exit_code: Option<i32>,
    runtime: Option<String>,
    remote_elapsed_ms: Option<u64>,
    peak_memory_kb: Option<u64>,
}

fn parse_remote_output(raw: &str) -> ParsedRemote {
    let mut parsed = ParsedRemote {
        stdout: between(raw, "CA_STDOUT_BEGIN\n", "\nCA_STDOUT_END"),
        stderr: between(raw, "CA_STDERR_BEGIN\n", "\nCA_STDERR_END"),
        ..Default::default()
    };
    for line in raw.lines() {
        if let Some(rest) = line.strip_prefix("CA_EXIT:") {
            parsed.exit_code = rest.trim().parse().ok();
        } else if let Some(rest) = line.strip_prefix("CA_RUNTIME:") {
            parsed.runtime = Some(rest.trim().to_string()).filter(|s| !s.is_empty());
        }
    }
    if let Some(stderr) = &parsed.stderr {
        for line in stderr.lines() {
            if let Some(rest) = line.strip_prefix("CA_METRICS ") {
                for part in rest.split_whitespace() {
                    if let Some(v) = part.strip_prefix("elapsed_s=") {
                        parsed.remote_elapsed_ms = v
                            .parse::<f64>()
                            .ok()
                            .map(|s| (s * 1000.0).round().max(0.0) as u64);
                    } else if let Some(v) = part.strip_prefix("elapsed_ms=") {
                        parsed.remote_elapsed_ms = v.parse().ok();
                    } else if let Some(v) = part.strip_prefix("maxrss_kb=") {
                        parsed.peak_memory_kb = v.parse().ok();
                    }
                }
            }
        }
    }
    parsed
}

fn between(raw: &str, start: &str, end: &str) -> Option<String> {
    let from = raw.find(start)? + start.len();
    let to = raw[from..].find(end)? + from;
    Some(raw[from..to].to_string())
}

fn clamp(raw: String) -> (String, bool) {
    if raw.len() <= MAX_OUTPUT {
        return (raw, false);
    }
    let head = MAX_OUTPUT * 2 / 3;
    let tail = MAX_OUTPUT - head;
    (
        format!(
            "{}\n\n... {} bytes dropped ...\n\n{}",
            &raw[..head],
            raw.len().saturating_sub(MAX_OUTPUT),
            &raw[raw.len() - tail..]
        ),
        true,
    )
}

fn clean(s: &str) -> String {
    s.trim().lines().take(6).collect::<Vec<_>>().join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_output_parser_reads_metrics() {
        let raw = "CA_STDOUT_BEGIN\nPASS one\nCA_STDOUT_END\nCA_STDERR_BEGIN\nCA_METRICS elapsed_s=0.01 maxrss_kb=9120\nCA_STDERR_END\nCA_EXIT:0\nCA_RUNTIME:codespace python3\n";
        let p = parse_remote_output(raw);
        assert_eq!(p.stdout.as_deref(), Some("PASS one"));
        assert_eq!(p.exit_code, Some(0));
        assert_eq!(p.remote_elapsed_ms, Some(10));
        assert_eq!(p.peak_memory_kb, Some(9120));
        assert_eq!(p.runtime.as_deref(), Some("codespace python3"));
    }
}

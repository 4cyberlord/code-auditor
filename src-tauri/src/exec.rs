//! Running the code a model wrote.
//!
//! Section 24 calls this the differentiator, and it is: an answer that has been
//! executed is a different kind of claim than an answer that merely looks right,
//! and four models agreeing on the same wrong output is exactly the failure the
//! consensus engine cannot catch on its own.
//!
//! It is also the most dangerous thing in the app. Everything here runs text that
//! a language model produced, on the user's own machine. Two rules follow, and
//! neither is negotiable:
//!
//!   * nothing runs without a person pressing Run. There is no auto-execute on a
//!     finished answer, however confident the panel is;
//!   * every run is bounded before it starts where the OS reliably supports it,
//!     and watched while it runs where macOS only gives us a practical runtime
//!     signal.
//!
//! Deliberately built on `std` alone, with no tokio and no Tauri types in the
//! core. That is what lets the whole thing be compiled and exercised by a plain
//! `rustc --test` harness, which matters more here than anywhere else in the
//! codebase: a sandbox nobody has watched contain a runaway process is not a
//! sandbox, it is a hope.

use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// How much output to keep from one run.
///
/// A loop printing to stdout produces gigabytes in seconds, and the interesting
/// part is almost always the first page and the last. Everything between is
/// dropped rather than buffered.
pub const MAX_OUTPUT: usize = 64 * 1024;

/// Ceiling on the wall-clock limit a caller may ask for.
pub const MAX_TIMEOUT_MS: u64 = 60_000;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

/// Address space cap, in kilobytes.
///
/// Four gigabytes rather than one, because this bounds *virtual* address space
/// and two of the runtimes here reserve enormous amounts of it up front without
/// ever touching most of it -- the JVM and the Go runtime both do. A 1 GiB cap
/// stopped runaway allocation and also stopped Java starting at all.
const MEMORY_KB: u64 = 4 * 1_024 * 1_024; // 4 GiB

/// Resident memory watchdog, in kilobytes.
///
/// macOS does not reliably enforce the virtual-memory `ulimit` for the programs
/// this runner starts. RSS is the practical signal that a process is consuming
/// real machine memory, so the wait loop samples the process group and kills it
/// when the resident footprint crosses this line.
const RESIDENT_MEMORY_KB: u64 = 768 * 1_024; // 768 MiB

/// Largest file the code may write, in 512-byte blocks (2 GiB would be `ulimit`'s
/// default of unlimited; this is 64 MiB).
const FILE_BLOCKS: u64 = 131_072;

// --------------------------------------------------------------------- runtime

/// One way of running one language.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Runtime {
    /// The binary that must exist for this to work at all.
    pub program: &'static str,
    /// What the code is written to inside the scratch directory.
    pub file: &'static str,
    /// The shell line that runs it, relative to the scratch directory.
    ///
    /// A string rather than a program plus arguments, because half of these are
    /// two steps: compiled languages have to build before they can run, and
    /// `cc main.c -o prog && ./prog` is the honest shape of that. The failure
    /// mode is the same either way -- a compile error arrives on stderr with a
    /// non-zero exit, which is exactly what the pane should show.
    pub command: &'static str,
    /// Shown in the UI so it is obvious what actually ran.
    pub label: &'static str,
}

/// Maps whatever a model called the language onto something runnable.
///
/// Models label the same language half a dozen ways -- "Python", "python3",
/// "py", and a fenced block that just says "```". Matching loosely here is the
/// difference between a Run button that works and one that reports "unsupported"
/// at the thing everyone writes.
/// Whether a piece of JavaScript is written as a CommonJS module.
///
/// This matters more than it sounds. Node decides between CommonJS and ES
/// modules by file extension, and the two are mutually exclusive: `require()` is
/// a syntax error in `.mjs`, `import` is one in `.cjs`. Writing everything to
/// `main.mjs` meant every answer using `require('fs')` -- which is most of what
/// models emit for Node -- died on line 1 with a message about module scope
/// rather than anything to do with the problem.
///
/// So the extension follows the code. Explicit ESM syntax wins when both appear,
/// because a file with a real `import` cannot be CommonJS at all.
pub fn is_commonjs(code: &str) -> bool {
    let esm = regex_lite_contains(
        code,
        &["import ", "import(", "export ", "export{", "export default"],
    );
    if esm {
        return false;
    }
    regex_lite_contains(
        code,
        &[
            "require(",
            "module.exports",
            "exports.",
            "__dirname",
            "__filename",
        ],
    )
}

/// Substring search that ignores matches inside a line comment.
///
/// A model explaining `// you could use require() here` should not change how
/// the file is interpreted.
fn regex_lite_contains(code: &str, needles: &[&str]) -> bool {
    code.lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .any(|l| needles.iter().any(|n| l.contains(n)))
}

pub fn runtime_for(language: &str, code: &str) -> Option<Runtime> {
    let l = language.trim().to_lowercase();
    let l = l.trim_start_matches('.').trim();

    Some(match l {
        "python" | "python3" | "py" | "py3" => Runtime {
            program: "python3",
            file: "main.py",
            command: "python3 main.py",
            label: "python3",
        },
        "javascript" | "js" | "node" | "nodejs" | "mjs" | "cjs" => {
            if is_commonjs(code) {
                Runtime {
                    program: "node",
                    file: "main.cjs",
                    command: "node main.cjs",
                    label: "node (commonjs)",
                }
            } else {
                Runtime {
                    program: "node",
                    file: "main.mjs",
                    command: "node main.mjs",
                    label: "node (esm)",
                }
            }
        }
        "typescript" | "ts" => Runtime {
            program: "node",
            file: "main.ts",
            command: "node --experimental-strip-types main.ts",
            label: "node (type stripping)",
        },
        "bash" | "sh" | "shell" | "zsh" | "console" => Runtime {
            program: "bash",
            file: "main.sh",
            command: "bash main.sh",
            label: "bash",
        },
        "ruby" | "rb" => Runtime {
            program: "ruby",
            file: "main.rb",
            command: "ruby main.rb",
            label: "ruby",
        },
        "php" => Runtime {
            program: "php",
            file: "main.php",
            command: "php main.php",
            label: "php",
        },
        // Compiled languages. Two steps in one shell line, so a build failure
        // lands on stderr with a non-zero exit exactly like a runtime one.
        "c" => Runtime {
            program: "cc",
            file: "main.c",
            command: "cc -std=c17 -O1 main.c -o prog -lm && ./prog",
            label: "cc",
        },
        "cpp" | "c++" | "cc" | "cxx" => Runtime {
            program: "c++",
            file: "main.cpp",
            command: "c++ -std=c++20 -O1 main.cpp -o prog && ./prog",
            label: "c++",
        },
        "java" => Runtime {
            program: "java",
            file: "Main.java",
            // Single-file source mode: no javac step, no class-name juggling.
            command: "java Main.java",
            label: "java",
        },
        "go" | "golang" => Runtime {
            program: "go",
            file: "main.go",
            command: "go run main.go",
            label: "go",
        },
        "rust" | "rs" => Runtime {
            program: "rustc",
            file: "main.rs",
            command: "rustc -O main.rs -o prog 2>&1 && ./prog",
            label: "rustc",
        },
        _ => return None,
    })
}

/// Whether the interpreter is actually installed.
///
/// Reported separately from "we do not support that language", because the two
/// need completely different responses from the person reading it: one is a
/// missing feature, the other is `brew install`.
pub fn runtime_available(r: &Runtime) -> bool {
    Command::new("sh")
        .arg("-c")
        .arg(format!("command -v {} >/dev/null 2>&1", r.program))
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

// ----------------------------------------------------------------------- limits

/// The shell prelude that bounds a run before the interpreter starts.
///
/// `ulimit` is applied by the shell to itself and inherited by everything it
/// execs, so the limits are in force before a single line of model-written code
/// is parsed. Setting them after the fact would leave a window, and the whole
/// point is that there is no window.
///
/// There is deliberately no `ulimit -u` here, and it is worth writing down why:
/// that limit counts every process belonging to the *user*, not the ones this
/// run started. Capping it at anything below a desktop session's ordinary
/// process count makes the very first `fork` fail -- which is how a perfectly
/// good Run button came back as `bash: fork: Resource temporarily unavailable`
/// on a real machine while passing every test in a container that happened to be
/// running fewer processes than the cap. A fork bomb is contained here by the
/// wall-clock deadline and the process-group kill instead, which do not depend
/// on what else the user happens to have open.
pub fn limit_prelude(cpu_seconds: u64) -> String {
    format!(
        "ulimit -t {cpu_seconds} 2>/dev/null; \
         ulimit -v {MEMORY_KB} 2>/dev/null; \
         ulimit -f {FILE_BLOCKS} 2>/dev/null; \
         ulimit -c 0 2>/dev/null;"
    )
}

/// Keeps the head and the tail, drops the middle, and says so.
///
/// Truncating only the tail loses the exception that ended the program, which is
/// usually the one line worth reading.
pub fn clamp_output(raw: &str, max: usize) -> (String, bool) {
    if raw.len() <= max {
        return (raw.to_string(), false);
    }
    let head = max * 2 / 3;
    let tail = max - head;

    let head_end = floor_char_boundary(raw, head);
    let tail_start = ceil_char_boundary(raw, raw.len() - tail);
    let dropped = tail_start - head_end;

    (
        format!(
            "{}\n\n... {} bytes dropped ...\n\n{}",
            &raw[..head_end],
            dropped,
            &raw[tail_start..]
        ),
        true,
    )
}

/// `str::floor_char_boundary` is still unstable, and slicing a multi-byte
/// character in half panics -- on output we do not control, from code we did not
/// write. Worth the twelve lines.
fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i.min(s.len())
}

// ------------------------------------------------------------------- execution

#[derive(Debug, Clone)]
pub struct ExecOutcome {
    pub runtime: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
    pub truncated: bool,
}

#[derive(Debug)]
pub enum ExecError {
    UnknownLanguage(String),
    RuntimeMissing { program: String, label: String },
    Io(String),
}

impl std::fmt::Display for ExecError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ExecError::UnknownLanguage(l) => write!(
                f,
                "There's no runner for {l} yet. Python, JavaScript, TypeScript, bash, Ruby, PHP, C, C++, Java, Go and Rust all work."
            ),
            ExecError::RuntimeMissing { program, label } => write!(
                f,
                "{label} isn't installed on this machine, so there's nothing to run the code with. Installing {program} would fix it."
            ),
            ExecError::Io(e) => write!(f, "Couldn't start the run: {e}"),
        }
    }
}

/// Runs `code` and returns what happened.
///
/// Blocking on purpose: the caller decides which thread to burn. The Tauri
/// command hands it to `spawn_blocking` so the UI keeps streaming.
pub fn run(
    language: &str,
    code: &str,
    stdin_text: &str,
    timeout_ms: u64,
    scratch_root: &Path,
) -> Result<ExecOutcome, ExecError> {
    let rt = runtime_for(language, code)
        .ok_or_else(|| ExecError::UnknownLanguage(language.to_string()))?;
    if !runtime_available(&rt) {
        return Err(ExecError::RuntimeMissing {
            program: rt.program.to_string(),
            label: rt.label.to_string(),
        });
    }

    let timeout = Duration::from_millis(timeout_ms.clamp(1, MAX_TIMEOUT_MS));

    // A directory per run, deleted afterwards. Anything the code writes lands
    // here and nowhere near the user's files.
    let dir = scratch_root.join(format!("run-{}", unique_suffix()));
    std::fs::create_dir_all(&dir).map_err(|e| ExecError::Io(e.to_string()))?;
    let guard = ScratchDir(dir.clone());

    std::fs::write(dir.join(rt.file), code).map_err(|e| ExecError::Io(e.to_string()))?;

    // CPU seconds sit just above the wall clock: the wall-clock kill is the one
    // we rely on, and a CPU limit below it would turn every slow-but-legitimate
    // run into a confusing SIGXCPU.
    let cpu_seconds = (timeout.as_secs() + 2).max(2);

    // Output goes to files, not pipes.
    //
    // Pipes cost two reader threads and buy a deadlock: a child that fills the
    // buffer blocks before the deadline can fire, and -- found by test -- a
    // backgrounded grandchild inherits the write end and holds it open long
    // after the program itself exited, so a run that took 3ms appeared to hang
    // for thirty seconds. Unblocking that meant killing the process group, which
    // then made correctness depend on a signal actually landing.
    //
    // Files have none of those properties. Nothing can block us, an orphan
    // holding the descriptor is harmless, `ulimit -f` already caps how much can
    // be written, and it all lands in a directory that is deleted anyway. The
    // cost is that output is not streamed -- acceptable for a verification run,
    // which is judged when it finishes.
    std::fs::write(dir.join("stdin.txt"), stdin_text).map_err(|e| ExecError::Io(e.to_string()))?;
    let command_line = format!(
        "{} {{ {} ; }} <stdin.txt >stdout.txt 2>stderr.txt",
        limit_prelude(cpu_seconds),
        rt.command
    );

    let started = Instant::now();
    let mut builder = Command::new("bash");
    builder
        .arg("-c")
        .arg(&command_line)
        .current_dir(&dir)
        .env_clear()
        .envs(sandbox_env(&dir))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    // Its own process group, so a timeout can kill everything the code started
    // and not just the shell that started it. Without this the child shares our
    // group, and there is no group to signal that is not also us.
    #[cfg(unix)]
    builder.process_group(0);

    let mut child = builder.spawn().map_err(|e| ExecError::Io(e.to_string()))?;

    let mut timed_out = false;
    let mut memory_exceeded = false;
    let mut last_memory_check = started;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {
                if last_memory_check.elapsed() >= Duration::from_millis(100) {
                    last_memory_check = Instant::now();
                    #[cfg(unix)]
                    if process_group_rss_kb(child.id()) > RESIDENT_MEMORY_KB {
                        memory_exceeded = true;
                        kill_group(&mut child);
                        break child.wait().ok();
                    }
                }
                if started.elapsed() >= timeout {
                    timed_out = true;
                    // The whole group, not just the shell. With no process cap
                    // in force this is the only thing standing between a runaway
                    // `fork` loop and the machine, so it kills everything the run
                    // started rather than just the shell that started it.
                    kill_group(&mut child);
                    break child.wait().ok();
                }
                std::thread::sleep(Duration::from_millis(15));
            }
            Err(_) => break None,
        }
    };

    // Sweep the group even on a clean exit. Nothing should outlive a
    // verification run, and a backgrounded `sleep 30` is exactly the thing a
    // model writes without meaning anything by it. Best-effort on purpose:
    // nothing here depends on the signal landing any more, so a platform that
    // refuses it costs tidiness rather than correctness.
    kill_group(&mut child);

    let exit_code = status.and_then(|s| s.code());
    let stdout_raw = read_capped(&dir.join("stdout.txt"));
    let mut stderr_raw = read_capped(&dir.join("stderr.txt"));
    if memory_exceeded {
        if !stderr_raw.is_empty() && !stderr_raw.ends_with('\n') {
            stderr_raw.push('\n');
        }
        stderr_raw.push_str("Code Auditor stopped the run after it exceeded the memory limit.\n");
    } else if exit_code == Some(137) || stderr_raw.contains("Killed: 9") {
        if !stderr_raw.is_empty() && !stderr_raw.ends_with('\n') {
            stderr_raw.push('\n');
        }
        stderr_raw.push_str(
            "The run was killed, most likely by the OS after hitting a resource limit.\n",
        );
    }
    let (stdout, out_cut) = clamp_output(&stdout_raw, MAX_OUTPUT);
    let (stderr, err_cut) = clamp_output(&stderr_raw, MAX_OUTPUT);

    drop(guard);

    Ok(ExecOutcome {
        runtime: rt.label.to_string(),
        exit_code,
        stdout,
        stderr,
        duration_ms: started.elapsed().as_millis() as u64,
        timed_out,
        truncated: out_cut || err_cut,
    })
}

/// The environment the code sees.
///
/// Cleared and rebuilt rather than filtered, so nothing leaks in by being
/// forgotten. `HOME` points at the scratch directory: a program that writes a
/// dotfile, or a package manager that caches, touches a folder that is about to
/// be deleted rather than the user's real home.
fn sandbox_env(dir: &Path) -> HashMap<String, String> {
    let mut env = HashMap::new();
    env.insert(
        "PATH".into(),
        "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin".into(),
    );
    env.insert("HOME".into(), dir.display().to_string());
    env.insert("TMPDIR".into(), dir.display().to_string());
    env.insert("LANG".into(), "en_US.UTF-8".into());
    // Announced to the code, so a script can tell it is being verified.
    env.insert("CODE_AUDITOR_SANDBOX".into(), "1".into());
    env
}

/// Reads a captured stream, keeping the two ends that matter.
///
/// `ulimit -f` already stops the file growing without bound, but "bounded" there
/// still means megabytes. The tail is read as well as the head because the last
/// thing a crashing program prints is the exception, and truncating from the
/// front alone throws away the only line worth reading.
fn read_capped(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};

    let window = (MAX_OUTPUT * 2) as u64;
    let Ok(mut f) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);

    if len <= window * 2 {
        let mut buf = Vec::new();
        let _ = f.take(window * 2).read_to_end(&mut buf);
        return String::from_utf8_lossy(&buf).into_owned();
    }

    let mut head = vec![0u8; window as usize];
    let read_head = f.read(&mut head).unwrap_or(0);
    head.truncate(read_head);

    let mut tail = Vec::new();
    if f.seek(SeekFrom::End(-(window as i64))).is_ok() {
        let _ = f.take(window).read_to_end(&mut tail);
    }

    format!(
        "{}\n\n... {} bytes dropped ...\n\n{}",
        String::from_utf8_lossy(&head),
        len - read_head as u64 - tail.len() as u64,
        String::from_utf8_lossy(&tail)
    )
}

#[cfg(unix)]
fn kill_group(child: &mut std::process::Child) {
    // A negative pid signals the whole process group, which is why the child was
    // given one of its own. Shelling out to `kill` rather than taking a `libc`
    // dependency keeps this module compilable by a bare `rustc --test`, which is
    // the only reason any of it has actually been watched working.
    let pid = child.id();
    let _ = Command::new("kill")
        .args(["-9", &format!("-{pid}")])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
}

#[cfg(unix)]
fn process_group_rss_kb(pgid: u32) -> u64 {
    let pids = process_group_pids(pgid);
    if !pids.is_empty() {
        let list = pids.join(",");
        let Ok(out) = Command::new("ps")
            .args(["-o", "rss=", "-p", &list])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
        else {
            return 0;
        };
        return sum_rss(&out.stdout);
    }

    let Ok(out) = Command::new("ps")
        .args(["-o", "rss=", "-g", &pgid.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    else {
        return 0;
    };

    sum_rss(&out.stdout)
}

#[cfg(unix)]
fn process_group_pids(pgid: u32) -> Vec<String> {
    let Ok(out) = Command::new("pgrep")
        .args(["-g", &pgid.to_string()])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(unix)]
fn sum_rss(out: &[u8]) -> u64 {
    String::from_utf8_lossy(out)
        .lines()
        .filter_map(|line| line.trim().parse::<u64>().ok())
        .sum()
}

#[cfg(not(unix))]
fn kill_group(child: &mut std::process::Child) {
    let _ = child.kill();
}

/// Deletes the scratch directory however the run ended, panic included.
struct ScratchDir(PathBuf);

impl Drop for ScratchDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn unique_suffix() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let t = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{t:x}-{n:x}-{}", std::process::id())
}

// ------------------------------------------------------- what this does NOT do
//
// Worth stating plainly, because "sandbox" invites an assumption this does not
// earn. What is bounded here is *resource* consumption: wall clock, CPU, virtual
// address space, resident memory, file size, output volume, and a working
// directory that is deleted afterwards. A runaway cannot take the machine with
// it.
//
// What is NOT bounded, and is verified below so that nobody discovers it by
// accident:
//
//   * the filesystem. `HOME` and the working directory are redirected, but an
//     absolute path is not. Code run here can read `~/.ssh/id_rsa`, `~/.aws/
//     credentials`, or anything else the user can read;
//   * the network. It can open sockets and make requests.
//
// Closing those on macOS means `sandbox-exec` with a deny-by-default profile,
// which is both deprecated and impossible to exercise from this test harness --
// and untested security code is worse than none, because it is believed. Until
// that exists the honest position is that this bounds accidents, not malice, and
// the UI says so at the moment the person decides to press Run.

// ----------------------------------------------------------------- tests
//
// These drive the real executor against real hostile programs -- runaway
// loops, unbounded allocation, a screaming stdout, a backgrounded child that
// tries to outlive its parent. A sandbox whose containment nobody has watched
// hold is not a sandbox, it is a hope, and two of these found genuine bugs:
// the inherited-pipe hang and the pipe-buffer deadlock, both of which the
// current file-based design exists to avoid.
#[cfg(test)]
mod sandbox_tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir().join("ca-exec-tests");
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn run_ok(lang: &str, code: &str, stdin: &str, ms: u64) -> ExecOutcome {
        match run(lang, code, stdin, ms, &scratch()) {
            Ok(o) => o,
            Err(e) => panic!("run failed: {e}"),
        }
    }

    #[test]
    fn it_runs_python_and_returns_stdout() {
        let o = run_ok("python", "print('hello from the sandbox')", "", 5000);
        assert!(o.stdout.contains("hello from the sandbox"), "{o:?}");
        assert_eq!(o.exit_code, Some(0));
        assert!(!o.timed_out);
    }

    #[test]
    fn a_nonzero_exit_is_reported_not_swallowed() {
        let o = run_ok("python", "import sys; sys.exit(3)", "", 5000);
        assert_eq!(o.exit_code, Some(3), "{o:?}");
    }

    #[test]
    fn stderr_comes_back_separately_from_stdout() {
        let o = run_ok(
            "python",
            "import sys\nprint('out')\nprint('boom', file=sys.stderr)",
            "",
            5000,
        );
        assert!(o.stdout.contains("out"), "{o:?}");
        assert!(o.stderr.contains("boom"), "{o:?}");
    }

    #[test]
    fn a_traceback_survives_intact() {
        let o = run_ok("python", "raise ValueError('the bug')", "", 5000);
        assert!(o.stderr.contains("ValueError"), "{o:?}");
        assert!(o.stderr.contains("the bug"), "{o:?}");
        assert_ne!(o.exit_code, Some(0));
    }

    #[test]
    fn stdin_reaches_the_program() {
        let o = run_ok(
            "python",
            "import sys; print(sys.stdin.read().strip().upper())",
            "quiet",
            5000,
        );
        assert!(o.stdout.contains("QUIET"), "{o:?}");
    }

    #[test]
    fn a_program_that_ignores_stdin_is_not_a_failure() {
        // A closed pipe on the writing side must not be reported as a broken run.
        let o = run_ok("python", "print('done')", "some input nobody reads", 5000);
        assert_eq!(o.exit_code, Some(0), "{o:?}");
    }

    // ---------------------------------------------------- the containment claims

    #[test]
    fn an_infinite_loop_is_killed_at_the_deadline() {
        let started = std::time::Instant::now();
        let o = run_ok("python", "while True: pass", "", 1200);
        let took = started.elapsed().as_millis();
        assert!(o.timed_out, "{o:?}");
        assert!(took < 6000, "took {took}ms, so the deadline did not hold");
    }

    #[test]
    fn a_loop_that_screams_to_stdout_does_not_hang_the_reader() {
        // The deadlock this guards: a child fills the pipe buffer and blocks, while
        // the parent waits for exit before reading. Both wait forever.
        let started = std::time::Instant::now();
        let o = run_ok("python", "while True: print('x' * 500)", "", 1500);
        let took = started.elapsed().as_millis();
        // Either ending is correct: the deadline fires, or the program dies of a
        // broken pipe once we stop reading. What must not happen is a hang, and what
        // must not be kept is a gigabyte of x.
        assert!(took < 8000, "took {took}ms -- the pipe deadlocked");
        assert!(
            o.truncated,
            "output should have been clamped: {} bytes",
            o.stdout.len()
        );
        assert!(
            o.stdout.len() < MAX_OUTPUT * 2,
            "kept {} bytes",
            o.stdout.len()
        );
    }

    #[test]
    fn a_fork_loop_is_contained_by_the_deadline() {
        // With no process cap, the wall clock and the group kill are the whole
        // defence. On macOS the user's process ceiling may refuse the fork loop
        // before the deadline, which is also acceptable containment: the run
        // returns promptly and does not take the machine with it.
        let started = std::time::Instant::now();
        let o = run_ok(
            "bash",
            "while true; do sleep 5 & sleep 0.02; done",
            "",
            1500,
        );
        let fork_refused = o.exit_code != Some(0)
            && o.stderr.contains("fork")
            && o.stderr.contains("Resource temporarily unavailable");
        let memory_stopped = o.exit_code != Some(0) && o.stderr.contains("memory limit");
        assert!(o.timed_out || fork_refused || memory_stopped, "{o:?}");
        assert!(
            started.elapsed().as_millis() < 9000,
            "took {}ms -- the deadline did not hold",
            started.elapsed().as_millis()
        );
    }

    #[test]
    fn a_sleeping_child_cannot_outlive_the_run() {
        // The parent exits immediately; the grandchild sleeps. Only a process-group
        // kill catches this, which is the whole reason for process_group(0).
        let o = run_ok("bash", "sleep 30 & echo spawned; exit 0", "", 3000);
        assert!(o.stdout.contains("spawned"), "{o:?}");
        // The run itself must return promptly rather than waiting on the orphan.
        assert!(
            o.duration_ms < 3000,
            "waited {}ms for an orphan",
            o.duration_ms
        );
    }

    #[test]
    fn unbounded_allocation_fails_instead_of_taking_the_machine() {
        let o = run_ok(
            "python",
            "chunks = []\nwhile True:\n    chunks.append(bytearray(64 * 1024 * 1024))",
            "",
            8000,
        );
        assert_ne!(
            o.exit_code,
            Some(0),
            "an 8GB allocation should not succeed: {o:?}"
        );
        assert!(
            o.stderr.contains("memory limit") || o.stderr.contains("resource limit") || o.timed_out,
            "{o:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn process_group_rss_can_be_measured() {
        let mut child = Command::new("bash")
            .arg("-c")
            .arg("sleep 1")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        std::thread::sleep(Duration::from_millis(100));
        let rss = process_group_rss_kb(child.id());
        kill_group(&mut child);
        let _ = child.wait();
        assert!(rss > 0, "rss was {rss}");
    }

    #[test]
    fn the_scratch_directory_is_gone_afterwards() {
        // Its own root: the shared one is being created and deleted by the other
        // tests running alongside this, so counting entries there measures the test
        // harness rather than the code.
        let root = std::env::temp_dir().join("ca-exec-cleanup");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();

        let o = run(
            "python",
            "open('litter.txt','w').write('x'*100)",
            "",
            5000,
            &root,
        )
        .unwrap();
        assert_eq!(o.exit_code, Some(0), "{o:?}");

        let left: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .filter_map(|e| e.ok())
            .collect();
        assert!(
            left.is_empty(),
            "left behind: {:?}",
            left.iter().map(|e| e.file_name()).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_code_runs_in_its_own_directory_not_the_users() {
        let o = run_ok("python", "import os; print(os.getcwd())", "", 5000);
        assert!(o.stdout.contains("run-"), "cwd was {}", o.stdout.trim());
    }

    #[test]
    fn home_points_at_the_scratch_dir_not_the_real_one() {
        let o = run_ok(
            "python",
            "import os; print(os.environ.get('HOME'))",
            "",
            5000,
        );
        assert!(o.stdout.contains("run-"), "HOME was {}", o.stdout.trim());
    }

    #[test]
    fn the_host_environment_does_not_leak_in() {
        std::env::set_var("CA_SECRET_TOKEN", "hunter2");
        let o = run_ok(
            "python",
            "import os; print(os.environ.get('CA_SECRET_TOKEN', 'absent'))",
            "",
            5000,
        );
        assert!(
            o.stdout.contains("absent"),
            "the host env leaked: {}",
            o.stdout.trim()
        );
    }

    #[test]
    fn the_host_filesystem_is_readable_and_that_is_a_known_gap() {
        // Recorded, not celebrated. This test exists so the limitation is a fact
        // in the codebase rather than a surprise, and so that whoever adds a
        // real filesystem jail has a test that will flip and tell them it worked.
        let o = run_ok("python", "print(open('/etc/hosts').read()[:4])", "", 5000);
        assert_eq!(
            o.exit_code,
            Some(0),
            "if this now fails, the filesystem got jailed -- update the docs and flip this test"
        );
    }

    #[test]
    fn the_sandbox_announces_itself() {
        let o = run_ok(
            "python",
            "import os; print(os.environ.get('CODE_AUDITOR_SANDBOX'))",
            "",
            5000,
        );
        assert!(o.stdout.contains('1'), "{o:?}");
    }

    // ------------------------------------------------------------- other runtimes

    #[test]
    fn javascript_runs() {
        let o = run_ok("js", "console.log('node works')", "", 8000);
        assert!(o.stdout.contains("node works"), "{o:?}");
    }

    #[test]
    fn bash_runs() {
        let o = run_ok("bash", "echo shell works", "", 5000);
        assert!(o.stdout.contains("shell works"), "{o:?}");
    }

    // ------------------------------------------------------------- the pure parts

    #[test]
    fn commonjs_and_esm_get_the_extension_node_expects() {
        // The bug this exists for: `require(...)` written to main.mjs dies on
        // line 1 with a message about module scope, which reads like the answer
        // was wrong rather than like the runner was.
        assert_eq!(
            runtime_for("js", "const fs = require('fs');").unwrap().file,
            "main.cjs"
        );
        assert_eq!(
            runtime_for("js", "module.exports = {};").unwrap().file,
            "main.cjs"
        );
        assert_eq!(
            runtime_for("js", "import fs from 'fs';").unwrap().file,
            "main.mjs"
        );
        assert_eq!(
            runtime_for("js", "console.log(1)").unwrap().file,
            "main.mjs"
        );
        // Real `import` cannot be CommonJS, so it wins outright.
        assert_eq!(
            runtime_for("js", "import a from 'a';\nconst b = require('b');")
                .unwrap()
                .file,
            "main.mjs"
        );
        // A mention in a comment must not decide how the file is interpreted.
        assert_eq!(
            runtime_for("js", "// you could use require() here\nconsole.log(1)")
                .unwrap()
                .file,
            "main.mjs"
        );
    }

    #[test]
    fn compiled_languages_build_and_then_run() {
        for (lang, needle) in [
            ("cpp", "c++"),
            ("c", "cc "),
            ("rust", "rustc"),
            ("go", "go run"),
        ] {
            let rt = runtime_for(lang, "").unwrap_or_else(|| panic!("{lang} should be runnable"));
            assert!(rt.command.contains(needle), "{lang}: {}", rt.command);
        }
        // C, C++ and Rust compile to a binary and then execute it; that second
        // step is the part it would be easy to forget.
        assert!(runtime_for("cpp", "")
            .unwrap()
            .command
            .contains("&& ./prog"));
        assert!(runtime_for("c", "").unwrap().command.contains("&& ./prog"));
    }

    #[test]
    fn java_uses_a_file_name_the_compiler_will_accept() {
        // Single-file source mode still insists the public class match the file.
        assert_eq!(runtime_for("java", "").unwrap().file, "Main.java");
    }

    #[test]
    fn language_labels_are_matched_loosely() {
        for l in ["python", "Python", "PY", " python3 ", ".py"] {
            assert!(runtime_for(l, "").is_some(), "{l} should be runnable");
        }
        assert_eq!(runtime_for("js", "").unwrap().program, "node");
        assert_eq!(runtime_for("TypeScript", "").unwrap().program, "node");
        assert!(runtime_for("brainfuck", "").is_none());
        assert!(runtime_for("", "").is_none());
    }

    #[test]
    fn an_unknown_language_says_so_rather_than_guessing() {
        let e = run("brainfuck", "+++", "", 1000, &scratch()).unwrap_err();
        assert!(matches!(e, ExecError::UnknownLanguage(_)), "{e}");
        assert!(e.to_string().contains("no runner"), "{e}");
    }

    #[test]
    fn clamping_keeps_both_ends_and_says_what_it_dropped() {
        let raw = format!("{}{}{}", "A".repeat(100), "B".repeat(5000), "Z".repeat(100));
        let (out, cut) = clamp_output(&raw, 400);
        assert!(cut);
        assert!(out.starts_with("AAA"), "lost the head");
        assert!(
            out.ends_with("ZZZ"),
            "lost the tail -- that is where the exception is"
        );
        assert!(out.contains("bytes dropped"));
        assert!(out.len() < 600, "{}", out.len());
    }

    #[test]
    fn short_output_is_left_exactly_alone() {
        let (out, cut) = clamp_output("small", 400);
        assert_eq!(out, "small");
        assert!(!cut);
    }

    #[test]
    fn clamping_never_splits_a_character() {
        // Slicing a multi-byte char in half panics, on output we do not control.
        let raw = "é".repeat(4000);
        let (out, cut) = clamp_output(&raw, 401);
        assert!(cut);
        assert!(out.contains('é'));
    }

    #[test]
    fn the_limits_are_set_before_the_interpreter_starts() {
        let p = limit_prelude(7);
        for flag in ["-t 7", "-v ", "-f ", "-c 0"] {
            assert!(p.contains(flag), "missing {flag} in {p}");
        }
        assert!(
            RESIDENT_MEMORY_KB < MEMORY_KB,
            "resident watchdog should sit below the virtual-memory startup cap"
        );
        // Never again: this counts the user's processes, not the run's, so any
        // value low enough to be a guard is low enough to break every fork on a
        // real desktop.
        assert!(!p.contains("-u "), "ulimit -u must not come back: {p}");
    }

    #[test]
    fn a_timeout_request_cannot_exceed_the_ceiling() {
        let started = std::time::Instant::now();
        let o = run_ok("python", "while True: pass", "", u64::MAX);
        assert!(o.timed_out);
        assert!(started.elapsed().as_secs() <= MAX_TIMEOUT_MS / 1000 + 5);
    }
}

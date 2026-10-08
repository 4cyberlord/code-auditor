use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;
use tokio::time::{timeout, Duration};

const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const MAX_LIST_ENTRIES: usize = 500;
const MAX_BASH_BYTES: usize = 120_000;
const MAX_BASH_COMMAND_BYTES: usize = 16_384;
const MAX_MATCH_LINE_CHARS: usize = 400;

/// Keeps one minified line from swallowing the whole tool result. Counts
/// characters rather than bytes so a multi-byte char is never split.
fn truncate_line(line: &str) -> String {
    if line.chars().count() <= MAX_MATCH_LINE_CHARS {
        return line.to_string();
    }
    let head: String = line.chars().take(MAX_MATCH_LINE_CHARS).collect();
    format!("{head}…")
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingToolRequest {
    pub name: String,
    pub root: String,
    #[serde(default)]
    pub args: Value,
}

#[tauri::command]
pub async fn coding_tool_execute(req: CodingToolRequest) -> Result<String, String> {
    crate::auth::require()?;
    execute(req).await
}

async fn execute(req: CodingToolRequest) -> Result<String, String> {
    let root = canonical_root(&req.root)?;
    let name = req.name.trim().to_ascii_lowercase();
    let args = req
        .args
        .as_object()
        .ok_or("Tool arguments must be an object.")?;

    match name.as_str() {
        "read" => read_file(&root, path_arg(args)?),
        "glob" => list_tree(&root, optional_path_arg(args).unwrap_or(".")),
        "grep" => grep_tree(
            &root,
            optional_path_arg(args).unwrap_or("."),
            string_arg(args, &["pattern", "query", "search"])?,
        ),
        "bash" => run_bash(&root, string_arg(args, &["command", "cmd", "shell"])?).await,
        "edit" | "replace_in_file" => replace_in_file(
            &root,
            path_arg(args)?,
            string_arg(
                args,
                &[
                    "oldString",
                    "old_string",
                    "oldText",
                    "old_text",
                    "before",
                    "old",
                ],
            )?,
            string_arg(
                args,
                &[
                    "newString",
                    "new_string",
                    "newText",
                    "new_text",
                    "after",
                    "new",
                ],
            )?,
        ),
        "write" | "write_to_file" | "create_file" => write_file(
            &root,
            path_arg(args)?,
            string_arg(args, &["content", "contents", "text", "data"])?,
        ),
        "delete_file" => delete_file(&root, path_arg(args)?),
        "rename_file" | "move_file" => move_path(&root, source_arg(args)?, destination_arg(args)?),
        "copy_file" => copy_file(&root, source_arg(args)?, destination_arg(args)?),
        "create_folder" | "create_directory" => create_dir(&root, directory_arg(args)?),
        "delete_folder" | "delete_directory" => delete_dir(&root, directory_arg(args)?),
        "rename_folder" | "move_folder" => {
            move_path(&root, source_arg(args)?, destination_arg(args)?)
        }
        "copy_folder" => copy_dir(&root, source_arg(args)?, destination_arg(args)?),
        other => Err(format!("Unsupported coding tool: {other}")),
    }
}

fn canonical_root(root: &str) -> Result<PathBuf, String> {
    let p = PathBuf::from(root.trim());
    if root.trim().is_empty() {
        return Err("Set a project root before running coding tools.".into());
    }
    let p = p
        .canonicalize()
        .map_err(|e| format!("Could not open project root: {e}"))?;
    if !p.is_dir() {
        return Err("Project root must be a directory.".into());
    }
    Ok(p)
}

fn reject_symlink_components(root: &Path, path: &Path) -> Result<(), String> {
    let relative = path.strip_prefix(root)
        .map_err(|_| "Tool path is outside the configured project root.")?;
    let mut current = root.to_path_buf();
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if meta.file_type().is_symlink() =>
                return Err("Tool path contains a symbolic link; refusing access.".into()),
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(format!("Could not inspect path component: {e}")),
        }
    }
    Ok(())
}

fn resolve_existing(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = safe_join(root, value)?;
    reject_symlink_components(root, &path)?;
    path.canonicalize()
        .map_err(|e| format!("Path does not exist inside project: {value} ({e})"))
        .and_then(|p| ensure_inside(root, p))
}

fn resolve_target(root: &Path, value: &str) -> Result<PathBuf, String> {
    let path = safe_join(root, value)?;
    // Walk every existing ancestor, even when the immediate parent has not
    // been created. A symlink above a missing intermediate directory can
    // otherwise redirect create_dir_all and writes outside the project.
    let mut ancestor = path.parent().ok_or("Target has no parent.")?;
    loop {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                if meta.file_type().is_symlink() {
                    return Err("Target parent is a symlink; refusing path.".into());
                }
                let real = ancestor.canonicalize()
                    .map_err(|e| format!("Could not resolve target ancestor: {e}"))?;
                ensure_inside(root, real)?;
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                ancestor = ancestor.parent().ok_or("Target has no existing ancestor.")?;
            }
            Err(e) => return Err(format!("Could not inspect target ancestor: {e}")),
        }
    }
    // Reject any existing symlink in the lexical path, not only the target.
    reject_symlink_components(root, &path)?;
    // Reject target symlinks, including broken links whose exists() is false.
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.file_type().is_symlink() =>
            Err("Target is a symlink; refusing to write through it.".into()),
        Ok(_) => Ok(path),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(path),
        Err(e) => Err(format!("Could not inspect target: {e}")),
    }
}

fn safe_join(root: &Path, value: &str) -> Result<PathBuf, String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("Path argument is empty.".into());
    }
    let rel = Path::new(raw);
    if rel.is_absolute() {
        let canon = rel
            .canonicalize()
            .map_err(|e| format!("Absolute path must already exist inside project: {e}"))?;
        return ensure_inside(root, canon);
    }
    if rel
        .components()
        .any(|c| matches!(c, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("Path traversal is not allowed.".into());
    }
    Ok(root.join(rel))
}

fn ensure_inside(root: &Path, path: PathBuf) -> Result<PathBuf, String> {
    if path.starts_with(root) {
        Ok(path)
    } else {
        Err("Tool path is outside the configured project root.".into())
    }
}

fn string_arg<'a>(
    args: &'a serde_json::Map<String, Value>,
    keys: &[&str],
) -> Result<&'a str, String> {
    for key in keys {
        if let Some(value) = args
            .get(*key)
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
        {
            return Ok(value);
        }
    }
    Err(format!("Missing required argument: {}", keys[0]))
}

fn path_arg(args: &serde_json::Map<String, Value>) -> Result<&str, String> {
    string_arg(args, &["filePath", "file_path", "path", "filename", "file"])
}

fn optional_path_arg(args: &serde_json::Map<String, Value>) -> Option<&str> {
    args.get("path")
        .or_else(|| args.get("directory"))
        .or_else(|| args.get("dir"))
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
}

fn directory_arg(args: &serde_json::Map<String, Value>) -> Result<&str, String> {
    string_arg(
        args,
        &[
            "directory",
            "dir",
            "folder",
            "folderPath",
            "folder_path",
            "path",
        ],
    )
}

fn source_arg(args: &serde_json::Map<String, Value>) -> Result<&str, String> {
    string_arg(
        args,
        &["source", "src", "from", "oldPath", "old_path", "path"],
    )
}

fn destination_arg(args: &serde_json::Map<String, Value>) -> Result<&str, String> {
    string_arg(
        args,
        &[
            "destination",
            "dest",
            "to",
            "target",
            "targetPath",
            "target_path",
            "newPath",
            "new_path",
        ],
    )
}

fn read_file(root: &Path, path: &str) -> Result<String, String> {
    let path = resolve_existing(root, path)?;
    // O_NOFOLLOW prevents a last-component symlink swap between path
    // validation and open. This does not yet protect ancestor components;
    // complete race resistance requires descriptor-relative traversal.
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(target_os = "macos")]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(&path).map_err(|e| format!("Could not open file: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("Read target is not a file.".into());
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("File is too large to read safely ({} bytes).", meta.len()));
    }
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("Could not read file: {e}"))?;
    if bytes.len() as u64 > MAX_READ_BYTES {
        return Err("File grew beyond the read size limit.".into());
    }
    String::from_utf8(bytes).map_err(|e| format!("File is not valid UTF-8: {e}"))
}

fn write_file(root: &Path, path: &str, content: &str) -> Result<String, String> {
    let path = resolve_target(root, path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create parent directory: {e}"))?;
    }
    fs::write(&path, content).map_err(|e| format!("Could not write file: {e}"))?;
    Ok(format!("Wrote {}", display_rel(root, &path)))
}

fn replace_in_file(root: &Path, path: &str, old: &str, new: &str) -> Result<String, String> {
    let path = resolve_existing(root, path)?;
    let current = fs::read_to_string(&path).map_err(|e| format!("Could not read file: {e}"))?;
    if !current.contains(old) {
        return Err("Old text was not found in the target file.".into());
    }
    let next = current.replacen(old, new, 1);
    fs::write(&path, next).map_err(|e| format!("Could not write edit: {e}"))?;
    Ok(format!("Edited {}", display_rel(root, &path)))
}

fn delete_file(root: &Path, path: &str) -> Result<String, String> {
    let path = resolve_existing(root, path)?;
    if !path.is_file() {
        return Err("Delete target is not a file.".into());
    }
    fs::remove_file(&path).map_err(|e| format!("Could not delete file: {e}"))?;
    Ok(format!("Deleted {}", display_rel(root, &path)))
}

fn create_dir(root: &Path, path: &str) -> Result<String, String> {
    let path = resolve_target(root, path)?;
    fs::create_dir_all(&path).map_err(|e| format!("Could not create folder: {e}"))?;
    Ok(format!("Created folder {}", display_rel(root, &path)))
}

fn delete_dir(root: &Path, path: &str) -> Result<String, String> {
    let path = resolve_existing(root, path)?;
    if path == root {
        return Err("Refusing to delete the project root.".into());
    }
    if !path.is_dir() {
        return Err("Delete target is not a folder.".into());
    }
    fs::remove_dir_all(&path).map_err(|e| format!("Could not delete folder: {e}"))?;
    Ok(format!("Deleted folder {}", display_rel(root, &path)))
}

fn move_path(root: &Path, source: &str, destination: &str) -> Result<String, String> {
    let source = resolve_existing(root, source)?;
    let destination = resolve_target(root, destination)?;
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create destination parent: {e}"))?;
    }
    fs::rename(&source, &destination).map_err(|e| format!("Could not move path: {e}"))?;
    Ok(format!(
        "Moved {} to {}",
        display_rel(root, &source),
        display_rel(root, &destination)
    ))
}

fn copy_file(root: &Path, source: &str, destination: &str) -> Result<String, String> {
    let source = resolve_existing(root, source)?;
    let destination = resolve_target(root, destination)?;
    if !source.is_file() {
        return Err("Copy source is not a file.".into());
    }
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Could not create destination parent: {e}"))?;
    }
    fs::copy(&source, &destination).map_err(|e| format!("Could not copy file: {e}"))?;
    Ok(format!(
        "Copied {} to {}",
        display_rel(root, &source),
        display_rel(root, &destination)
    ))
}

fn copy_dir(root: &Path, source: &str, destination: &str) -> Result<String, String> {
    let source = resolve_existing(root, source)?;
    let destination = resolve_target(root, destination)?;
    if !source.is_dir() {
        return Err("Copy source is not a folder.".into());
    }
    // A destination inside the source tree would be discovered again while
    // traversing and recursively copied without a natural stopping point.
    if destination.starts_with(&source) {
        return Err("Cannot copy a folder into itself or one of its descendants.".into());
    }
    copy_dir_recursive(&source, &destination)?;
    Ok(format!(
        "Copied folder {} to {}",
        display_rel(root, &source),
        display_rel(root, &destination)
    ))
}

fn copy_dir_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    fs::create_dir_all(destination)
        .map_err(|e| format!("Could not create destination folder: {e}"))?;
    for entry in fs::read_dir(source).map_err(|e| format!("Could not read source folder: {e}"))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dest = destination.join(entry.file_name());
        // Do not traverse a symlink encountered inside the tree. Otherwise an
        // innocent-looking copy_folder could read files outside the project.
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err(format!("Refusing to copy a symbolic link: {}", src.display()));
        }
        if dest.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            return Err(format!("Refusing to overwrite a symbolic link: {}", dest.display()));
        }
        if kind.is_dir() {
            copy_dir_recursive(&src, &dest)?;
        } else {
            fs::copy(&src, &dest).map_err(|e| format!("Could not copy file: {e}"))?;
        }
    }
    Ok(())
}

fn list_tree(root: &Path, path: &str) -> Result<String, String> {
    let base = resolve_existing(root, path)?;
    if !base.is_dir() {
        return Err("Glob target is not a folder.".into());
    }
    let mut out = Vec::new();
    visit(&base, root, &mut out)?;
    if out.is_empty() {
        return Ok("(folder is empty)".into());
    }
    let mut text = out.join("\n");
    if out.len() >= MAX_LIST_ENTRIES {
        text.push_str(&format!(
            "\n[listing truncated at {MAX_LIST_ENTRIES} entries]"
        ));
    }
    Ok(text)
}

fn visit(dir: &Path, root: &Path, out: &mut Vec<String>) -> Result<(), String> {
    if out.len() >= MAX_LIST_ENTRIES {
        return Ok(());
    }
    for entry in fs::read_dir(dir).map_err(|e| format!("Could not list folder: {e}"))? {
        // Re-checked per entry, not just per directory: one flat folder with
        // 50k files would otherwise blow straight past the cap.
        if out.len() >= MAX_LIST_ENTRIES {
            return Ok(());
        }
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        // Never traverse directory symlinks during discovery. They may point
        // outside the project even if the initially selected directory is safe.
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() { continue; }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == "node_modules" || name == ".git" || name == "target" || name == ".next" {
            continue;
        }
        out.push(display_rel(root, &path));
        if path.is_dir() {
            visit(&path, root, out)?;
        }
    }
    Ok(())
}

fn grep_tree(root: &Path, path: &str, pattern: &str) -> Result<String, String> {
    let base = resolve_existing(root, path)?;
    let mut matches = Vec::new();
    grep_visit(&base, root, pattern, &mut matches)?;
    if matches.is_empty() {
        // An empty string reads as a failed tool to the model, which then
        // retries the same search. Say plainly that the search ran.
        return Ok(format!("No matches for {pattern:?}."));
    }
    let mut text = matches.join("\n");
    if matches.len() >= MAX_LIST_ENTRIES {
        text.push_str(&format!(
            "\n[results truncated at {MAX_LIST_ENTRIES} matches]"
        ));
    }
    Ok(text)
}

fn grep_visit(
    path: &Path,
    root: &Path,
    pattern: &str,
    out: &mut Vec<String>,
) -> Result<(), String> {
    if out.len() >= MAX_LIST_ENTRIES {
        return Ok(());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(|e| format!("Could not search folder: {e}"))? {
            if out.len() >= MAX_LIST_ENTRIES {
                return Ok(());
            }
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_symlink() || name == "node_modules" || name == ".git" || name == "target" || name == ".next" {
                continue;
            }
            grep_visit(&entry.path(), root, pattern, out)?;
        }
        return Ok(());
    }
    let Ok(meta) = fs::metadata(path) else {
        return Ok(());
    };
    if !meta.is_file() || meta.len() > MAX_READ_BYTES {
        return Ok(());
    }
    let Ok(text) = fs::read_to_string(path) else {
        return Ok(());
    };
    for (i, line) in text.lines().enumerate() {
        // A single minified bundle can match on every line, so the cap has to
        // bind inside the file too, not only between files.
        if out.len() >= MAX_LIST_ENTRIES {
            return Ok(());
        }
        if line.contains(pattern) {
            out.push(format!(
                "{}:{}: {}",
                display_rel(root, path),
                i + 1,
                truncate_line(line.trim())
            ));
        }
    }
    Ok(())
}

/// The coding model's shell is NOT sandboxed by setting current_dir(root).
/// Default-deny until an explicit operator opt-in. This does not claim to
/// confine an opted-in shell: use a real isolated runner for untrusted commands.
fn shell_enabled() -> bool {
    matches!(
        std::env::var("COUNCIL_EDITOR_ALLOW_UNSANDBOXED_SHELL").as_deref(),
        Ok("1")
    )
}

fn validate_shell_command(command: &str) -> Result<(), String> {
    if command.trim().is_empty() { return Err("Shell command is empty.".into()); }
    if command.len() > MAX_BASH_COMMAND_BYTES {
        return Err(format!("Shell command exceeds {MAX_BASH_COMMAND_BYTES} bytes."));
    }
    if command.as_bytes().contains(&0) { return Err("Shell command contains a null byte.".into()); }
    Ok(())
}

/// Explicit execution policy for the Coding Intelligence shell.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ShellPolicy {
    Disabled,
    ContainerRestricted,
    TrustedUnrestricted,
}

fn shell_policy(mode: Option<&str>, allow_unsafe: bool) -> ShellPolicy {
    // A restricted-mode request must never silently fall back to an unrestricted
    // shell, even if the operator enabled the latter separately.
    if mode == Some("restricted") {
        ShellPolicy::ContainerRestricted
    } else if allow_unsafe {
        ShellPolicy::TrustedUnrestricted
    } else {
        ShellPolicy::Disabled
    }
}

/// Restricted execution uses an OCI container engine, never macOS
/// sandbox-exec. The container image is pinned by deployment configuration;
/// it must be pulled explicitly beforehand. No image downloads at runtime.
fn restricted_docker_args(root: &Path, command: &str, name: &str) -> Result<Vec<String>, String> {
    validate_shell_command(command)?;
    let path = root.to_str().ok_or("Project path must be valid UTF-8.")?;
    if !root.is_absolute() || !root.is_dir() || path.contains(',') || path.contains(':') {
        return Err("Invalid project path for Docker bind mount.".into());
    }
    if !name.starts_with("council-coding-")
        || !name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') {
        return Err("Invalid container name.".into());
    }
    let image = "alpine:3.20";
    let mount = format!("type=bind,source={path},target=/workspace");
    Ok(vec![
        "run", "--rm", "--init",
        "--name", name,
        "--pull", "never",
        "--network", "none",
        "--read-only",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        "--pids-limit", "64",
        "--ulimit", "nofile=256:256",
        "--ulimit", "fsize=8388608:8388608",
        "--memory", "512m",
        "--memory-swap", "512m",
        "--cpus", "1",
        "--tmpfs", "/tmp:rw,nosuid,noexec,size=64m",
        "--user", "1000:1000",
        "--mount", mount.as_str(),
        "--workdir", "/workspace",
        image, "/bin/sh", "-lc", command
    ].into_iter().map(str::to_string).collect())
}

async fn run_restricted_docker(root: &Path, command: &str) -> Result<String, String> {
    let name = format!("council-coding-{}", uuid::Uuid::new_v4().simple());
    let args = restricted_docker_args(root, command, &name)?;
    // Docker Desktop must already be installed and running. No fallback.
    // Docker Desktop also uses /opt/homebrew/bin/docker on Apple Silicon.
    let docker = if Path::new("/usr/local/bin/docker").is_file() {
        "/usr/local/bin/docker"
    } else if Path::new("/opt/homebrew/bin/docker").is_file() {
        "/opt/homebrew/bin/docker"
    } else {
        return Err("Restricted execution requires an installed Docker CLI and Docker Desktop; refusing to run.".into());
    };
    let mut child = Command::new(docker);
    child.args(&args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let output = match timeout(Duration::from_secs(120), child.output()).await {
        Ok(value) => value.map_err(|e| format!("Container execution unavailable: {e}"))?,
        Err(_) => {
            // Kill by container name, not only the Docker client process.
            let _ = timeout(Duration::from_secs(10),
                Command::new(docker).arg("rm").arg("-f").arg(&name).output()
            ).await;
            return Err("Restricted command timed out; container cleanup requested.".into());
        }
    };
    let text = format!("{}{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        return Err(format!("Restricted container exited with {}: {}", output.status, truncate_line(&text)));
    }
    Ok(if text.trim().is_empty() { "(command completed with no output)".into() }
       else { text.chars().take(MAX_BASH_BYTES).collect() })
}

async fn run_bash(root: &Path, command: &str) -> Result<String, String> {
    let mode = std::env::var("COUNCIL_EDITOR_SHELL_MODE").ok();
    match shell_policy(mode.as_deref(), shell_enabled()) {
        ShellPolicy::Disabled => {
            return Err("Shell execution is disabled by default. Trusted local users may opt into unsandboxed execution with COUNCIL_EDITOR_ALLOW_UNSANDBOXED_SHELL=1. A human must approve each command.".into());
        }
        ShellPolicy::ContainerRestricted => return run_restricted_docker(root, command).await,
        ShellPolicy::TrustedUnrestricted => {}
    }
    validate_shell_command(command)?;
    let mut shell = Command::new("sh");
    shell.arg("-lc").arg(command);
    // Do not forward API tokens or app credentials to model-requested subprocesses.
    shell.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin");
    // Put the shell in its own process group on macOS. Terminate the group
    // on timeout so ordinary children cannot outlive the command's deadline.
    #[cfg(target_os = "macos")]
    shell.process_group(0);
    let child = shell
        .current_dir(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Could not start command: {e}"))?;
    #[cfg(target_os = "macos")]
    let group = child.id();
    let output = match timeout(Duration::from_secs(120), child.wait_with_output()).await {
        Ok(result) => result.map_err(|e| format!("Could not run command: {e}"))?,
        Err(_) => {
            #[cfg(target_os = "macos")]
            if let Some(pid) = group {
                // Negative PID targets the process group created above.
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
            }
            return Err("Command timed out after 120 seconds; process group terminated.".into());
        }
    };
    let mut text = String::new();
    if !output.stdout.is_empty() {
        text.push_str(&String::from_utf8_lossy(&output.stdout));
    }
    if !output.stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&output.stderr));
    }
    if text.len() > MAX_BASH_BYTES {
        text.truncate(MAX_BASH_BYTES);
        text.push_str("\n[output truncated]");
    }
    if !output.status.success() {
        return Err(format!(
            "Command exited with status {}.\n{}",
            output.status, text
        ));
    }
    Ok(if text.trim().is_empty() {
        "(command completed with no output)".into()
    } else {
        text
    })
}

fn display_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

#[cfg(test)]
mod security_tests {
    use super::*;

    #[test]
    fn shell_policy_never_falls_back_from_restricted_to_unsafe() {
        assert_eq!(shell_policy(None, false), ShellPolicy::Disabled);
        assert_eq!(shell_policy(Some("restricted"), false), ShellPolicy::ContainerRestricted);
        assert_eq!(shell_policy(Some("restricted"), true), ShellPolicy::ContainerRestricted);
        assert_eq!(shell_policy(None, true), ShellPolicy::TrustedUnrestricted);
    }

    #[test]
    fn rejects_invalid_and_oversized_shell_commands() {
        assert!(validate_shell_command("").is_err());
        assert!(validate_shell_command("  ").is_err());
        assert!(validate_shell_command(&String::from_utf8(vec![0]).unwrap()).is_err());
        assert!(validate_shell_command(&"x".repeat(MAX_BASH_COMMAND_BYTES + 1)).is_err());
        assert!(validate_shell_command("printf ok").is_ok());
    }

    #[test]
    fn restricted_container_has_explicit_isolation_flags() {
        let root = std::env::temp_dir().canonicalize().unwrap();
        let args = restricted_docker_args(&root, "printf ok", "council-coding-abc").unwrap();
        for flag in ["--network", "none", "--read-only", "--cap-drop", "ALL", "--pids-limit",
                     "--memory", "--cpus", "--pull", "never", "--security-opt", "no-new-privileges"] {
            assert!(args.iter().any(|arg| arg == flag), "missing {flag}");
        }
        assert!(args.iter().any(|arg| arg.contains("target=/workspace")));
        assert!(args.windows(2).any(|w| w == ["--ulimit", "nofile=256:256"]));
        assert!(args.windows(2).any(|w| w == ["--ulimit", "fsize=8388608:8388608"]));
        assert!(!args.iter().any(|arg| arg == "--privileged"));

        assert!(restricted_docker_args(&root, "echo ok", "malicious").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinks_even_when_they_point_inside_project() {
        use std::os::unix::fs::symlink;
        let base = std::env::temp_dir().join(format!("council-internal-link-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(base.join("real")).unwrap();
        fs::write(base.join("real/file.txt"), "ok").unwrap();
        symlink(base.join("real"), base.join("alias")).unwrap();
        let root = base.canonicalize().unwrap();
        assert!(resolve_existing(&root, "alias/file.txt").is_err());
        assert!(resolve_target(&root, "alias/new.txt").is_err());
        assert!(resolve_existing(&root, "real/file.txt").is_ok());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = Path::new("/tmp/project");
        assert!(safe_join(root, "../outside").is_err());
        assert!(safe_join(root, "src/../../outside").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlink_inside_copied_tree() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!("council-coding-security-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("destination");
        fs::create_dir_all(&source).unwrap();
        symlink("/etc", source.join("outside")).unwrap();
        let result = copy_dir_recursive(&source, &target);
        assert!(result.is_err(), "copying a tree containing symlinks must fail");
        fs::remove_dir_all(root).unwrap();
    }
}

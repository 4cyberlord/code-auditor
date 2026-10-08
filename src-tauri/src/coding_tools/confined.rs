//! Descriptor-relative filesystem boundary for Coding Intelligence on macOS.
//! Every operation starts from a pinned project directory fd and never follows
//! a symlink in any path component. No path-based recursive std::fs operations.
use super::{destination_arg, directory_arg, path_arg, safe_join, source_arg, string_arg, truncate_line,
    MAX_LIST_ENTRIES, MAX_MATCH_LINE_CHARS, MAX_READ_BYTES};
use serde_json::{Map, Value};
use std::ffi::{CStr, CString, OsString};
use std::fs::File;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::{Component, Path, PathBuf};

const MAX_TREE_DEPTH: usize = 32;
const MAX_TREE_OPERATIONS: usize = 10_000;
const MAX_COPY_BYTES: u64 = 64 * 1024 * 1024;

fn io_error(action: &str) -> String {
    format!("{}: {}", action, std::io::Error::last_os_error())
}

fn c_name(bytes: &[u8]) -> Result<CString, String> {
    CString::new(bytes).map_err(|_| "Null byte in project path.".into())
}

fn duplicate(fd: RawFd) -> Result<OwnedFd, String> {
    let raw = unsafe { libc::dup(fd) };
    if raw < 0 { return Err(io_error("Could not duplicate project directory")); }
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

fn open_root(root: &Path) -> Result<OwnedFd, String> {
    let path = c_name(root.as_os_str().as_bytes())?;
    let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io_error("Could not open project root safely")); }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn relative(root: &Path, user_path: &str) -> Result<PathBuf, String> {
    let joined = safe_join(root, user_path)?;
    joined.strip_prefix(root).map(|p| p.to_path_buf())
        .map_err(|_| "Path outside project root.".into())
}

fn names(path: &Path) -> Result<Vec<CString>, String> {
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => parts.push(c_name(part.as_bytes())?),
            Component::CurDir => {}
            _ => return Err("Path traversal or absolute path denied.".into()),
        }
    }
    Ok(parts)
}

fn open_child_dir(parent: RawFd, name: &CStr) -> Result<OwnedFd, String> {
    let fd = unsafe { libc::openat(parent, name.as_ptr(),
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC) };
    if fd < 0 { return Err(io_error("Unsafe or inaccessible project directory")); }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn ensure_child_dir(parent: RawFd, name: &CStr) -> Result<OwnedFd, String> {
    let created = unsafe { libc::mkdirat(parent, name.as_ptr(), 0o755) };
    if created < 0 && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists {
        return Err(io_error("Could not create project directory"));
    }
    open_child_dir(parent, name)
}

fn open_dir(root: RawFd, path: &Path, create: bool) -> Result<OwnedFd, String> {
    let mut dir = duplicate(root)?;
    for part in names(path)? {
        dir = if create { ensure_child_dir(dir.as_raw_fd(), &part)? }
              else { open_child_dir(dir.as_raw_fd(), &part)? };
    }
    Ok(dir)
}

fn parent_and_name(root: RawFd, path: &Path, create_parents: bool) -> Result<(OwnedFd, CString), String> {
    let mut parts = names(path)?;
    let name = parts.pop().ok_or("Refusing to operate on project root.")?;
    let mut dir = duplicate(root)?;
    for part in parts {
        dir = if create_parents { ensure_child_dir(dir.as_raw_fd(), &part)? }
              else { open_child_dir(dir.as_raw_fd(), &part)? };
    }
    Ok((dir, name))
}

fn kind(parent: RawFd, name: &CStr) -> Result<libc::mode_t, String> {
    let mut stat = std::mem::MaybeUninit::<libc::stat>::uninit();
    let result = unsafe { libc::fstatat(parent, name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW) };
    if result < 0 { return Err(io_error("Could not inspect project entry")); }
    Ok(unsafe { stat.assume_init().st_mode } & libc::S_IFMT)
}

fn open_file(parent: RawFd, name: &CStr, write: bool) -> Result<File, String> {
    // O_NONBLOCK avoids hanging on FIFO/device entries before fstat.
    // No O_TRUNC: verify regular-file type on the open fd before truncation.
    let flags = if write { libc::O_WRONLY | libc::O_CREAT } else { libc::O_RDONLY };
    let fd = unsafe { libc::openat(parent, name.as_ptr(),
        flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK, 0o644 as libc::c_uint) };
    if fd < 0 { return Err(io_error("Could not open confined project file")); }
    let file = unsafe { File::from_raw_fd(fd) };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Project entry is not a regular file.".into());
    }
    Ok(file)
}

fn read_at(root: RawFd, path: &Path) -> Result<String, String> {
    let (parent, name) = parent_and_name(root, path, false)?;
    let file = open_file(parent.as_raw_fd(), &name, false)?;
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    if size > MAX_READ_BYTES { return Err("File exceeds the 2 MiB read limit.".into()); }
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_READ_BYTES { return Err("File grew beyond the read limit.".into()); }
    String::from_utf8(bytes).map_err(|e| format!("File is not UTF-8: {e}"))
}

fn write_at(root: RawFd, path: &Path, content: &str) -> Result<(), String> {
    let (parent, name) = parent_and_name(root, path, true)?;
    let mut file = open_file(parent.as_raw_fd(), &name, true)?;
    file.set_len(0).map_err(|e| format!("Could not truncate file: {e}"))?;
    file.write_all(content.as_bytes()).map_err(|e| format!("Could not write file: {e}"))
}

fn unlink_file(root: RawFd, path: &Path) -> Result<(), String> {
    let (parent, name) = parent_and_name(root, path, false)?;
    if kind(parent.as_raw_fd(), &name)? != libc::S_IFREG {
        return Err("Delete target must be a regular file.".into());
    }
    if unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), 0) } < 0 {
        return Err(io_error("Could not delete project file"));
    }
    Ok(())
}

fn move_at(root: RawFd, from: &Path, to: &Path) -> Result<(), String> {
    let (source_dir, source_name) = parent_and_name(root, from, false)?;
    let (target_dir, target_name) = parent_and_name(root, to, true)?;
    let source_kind = kind(source_dir.as_raw_fd(), &source_name)?;
    if source_kind != libc::S_IFREG && source_kind != libc::S_IFDIR {
        return Err("Move source is not a regular file or folder.".into());
    }
    if let Ok(target_kind) = kind(target_dir.as_raw_fd(), &target_name) {
        if target_kind == libc::S_IFLNK { return Err("Move destination is a symlink.".into()); }
    }
    if unsafe { libc::renameat(source_dir.as_raw_fd(), source_name.as_ptr(),
                               target_dir.as_raw_fd(), target_name.as_ptr()) } < 0 {
        return Err(io_error("Could not move project entry"));
    }
    Ok(())
}

fn copy_regular(source_parent: RawFd, source_name: &CStr, target_parent: RawFd, target_name: &CStr) -> Result<(), String> {
    let mut source = open_file(source_parent, source_name, false)?;
    if source.metadata().map_err(|e| e.to_string())?.len() > MAX_COPY_BYTES {
        return Err("Copy source exceeds 64 MiB limit.".into());
    }
    let mut destination = open_file(target_parent, target_name, true)?;
    destination.set_len(0).map_err(|e| e.to_string())?;
    let mut bytes = 0u64;
    let mut buf = [0u8; 8192];
    loop {
        let n = source.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 { break; }
        bytes += n as u64;
        if bytes > MAX_COPY_BYTES { return Err("Copy source grew beyond 64 MiB.".into()); }
        destination.write_all(&buf[..n]).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn entries(dir: RawFd) -> Result<Vec<OsString>, String> {
    let copied = unsafe { libc::dup(dir) };
    if copied < 0 { return Err(io_error("Could not duplicate directory for listing")); }
    let stream = unsafe { libc::fdopendir(copied) };
    if stream.is_null() {
        unsafe { libc::close(copied); }
        return Err(io_error("Could not read confined directory"));
    }
    let mut result = Vec::new();
    loop {
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() { break; }
        let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
        if bytes == b"." || bytes == b".." { continue; }
        result.push(OsString::from_vec(bytes.to_vec()));
        if result.len() > MAX_TREE_OPERATIONS {
            unsafe { libc::closedir(stream); }
            return Err("Directory exceeds safe traversal limit.".into());
        }
    }
    unsafe { libc::closedir(stream); }
    Ok(result)
}

fn copy_dir_contents(source: RawFd, target: RawFd, depth: usize, count: &mut usize) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH { return Err("Folder copy exceeds safe depth.".into()); }
    for name in entries(source)? {
        *count += 1;
        if *count > MAX_TREE_OPERATIONS { return Err("Folder copy exceeds safe entry limit.".into()); }
        let c = c_name(name.as_bytes())?;
        match kind(source, &c)? {
            libc::S_IFDIR => {
                let src = open_child_dir(source, &c)?;
                let dst = ensure_child_dir(target, &c)?;
                copy_dir_contents(src.as_raw_fd(), dst.as_raw_fd(), depth + 1, count)?;
            }
            libc::S_IFREG => copy_regular(source, &c, target, &c)?,
            _ => return Err("Refusing to copy symbolic links or special files.".into()),
        }
    }
    Ok(())
}

fn remove_dir_contents(dir: RawFd, depth: usize, count: &mut usize) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH { return Err("Folder deletion exceeds safe depth.".into()); }
    for name in entries(dir)? {
        *count += 1;
        if *count > MAX_TREE_OPERATIONS { return Err("Folder deletion exceeds safe entry limit.".into()); }
        let c = c_name(name.as_bytes())?;
        match kind(dir, &c)? {
            libc::S_IFDIR => {
                let child = open_child_dir(dir, &c)?;
                remove_dir_contents(child.as_raw_fd(), depth + 1, count)?;
                if unsafe { libc::unlinkat(dir, c.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
                    return Err(io_error("Could not remove project subdirectory"));
                }
            }
            libc::S_IFREG | libc::S_IFLNK => {
                // Unlinking a symlink does not follow it.
                if unsafe { libc::unlinkat(dir, c.as_ptr(), 0) } < 0 {
                    return Err(io_error("Could not remove project entry"));
                }
            }
            _ => return Err("Refusing to delete special filesystem entries.".into()),
        }
    }
    Ok(())
}

fn ignore(name: &str) -> bool {
    matches!(name, ".git" | "node_modules" | "target" | ".next")
}

fn visit_dir(dir: RawFd, rel: &Path, out: &mut Vec<String>, depth: usize) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH { return Err("Listing exceeds safe depth.".into()); }
    for name in entries(dir)? {
        if out.len() >= MAX_LIST_ENTRIES { break; }
        let display = name.to_string_lossy();
        if ignore(&display) { continue; }
        let c = c_name(name.as_bytes())?;
        let entry_kind = kind(dir, &c)?;
        if entry_kind == libc::S_IFLNK { continue; }
        let child_path = rel.join(&name);
        out.push(child_path.to_string_lossy().to_string());
        if entry_kind == libc::S_IFDIR {
            let child = open_child_dir(dir, &c)?;
            visit_dir(child.as_raw_fd(), &child_path, out, depth + 1)?;
        }
    }
    Ok(())
}

fn grep_regular(parent: RawFd, name: &CStr, rel: &Path, pattern: &str, out: &mut Vec<String>) -> Result<(), String> {
    let file = open_file(parent, name, false)?;
    if file.metadata().map_err(|e| e.to_string())?.len() > MAX_READ_BYTES { return Ok(()); }
    let mut bytes = Vec::new();
    file.take(MAX_READ_BYTES + 1).read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_READ_BYTES { return Ok(()); }
    let Ok(text) = String::from_utf8(bytes) else { return Ok(()); };
    for (i, line) in text.lines().enumerate() {
        if out.len() >= MAX_LIST_ENTRIES { break; }
        if line.contains(pattern) {
            out.push(format!("{}:{}: {}", rel.display(), i + 1, truncate_line(line.trim())));
        }
    }
    Ok(())
}

fn grep_dir(dir: RawFd, rel: &Path, pattern: &str, out: &mut Vec<String>, depth: usize) -> Result<(), String> {
    if depth > MAX_TREE_DEPTH { return Err("Search exceeds safe depth.".into()); }
    for name in entries(dir)? {
        if out.len() >= MAX_LIST_ENTRIES { break; }
        let display = name.to_string_lossy();
        if ignore(&display) { continue; }
        let c = c_name(name.as_bytes())?;
        let child_rel = rel.join(&name);
        match kind(dir, &c)? {
            libc::S_IFDIR => {
                let child = open_child_dir(dir, &c)?;
                grep_dir(child.as_raw_fd(), &child_rel, pattern, out, depth + 1)?;
            }
            libc::S_IFREG => grep_regular(dir, &c, &child_rel, pattern, out)?,
            _ => {}
        }
    }
    Ok(())
}

fn summarize(root: &Path, rel: &Path) -> String {
    root.join(rel).strip_prefix(root).unwrap_or(rel).to_string_lossy().to_string()
}

pub(super) fn execute_file_tool(root: &Path, name: &str, args: &Map<String, Value>) -> Result<String, String> {
    let fd = open_root(root)?;
    let root_fd = fd.as_raw_fd();
    let path = |value: &str| relative(root, value);
    match name {
        "read" => read_at(root_fd, &path(path_arg(args)?)?),
        "write" | "write_to_file" | "create_file" => {
            let rel = path(path_arg(args)?)?;
            let content = string_arg(args, &["content", "contents", "text", "data"])?;
            write_at(root_fd, &rel, content)?;
            Ok(format!("Wrote {}", summarize(root, &rel)))
        }
        "edit" | "replace_in_file" => {
            let rel = path(path_arg(args)?)?;
            let old = string_arg(args, &["oldString", "old_string", "oldText", "old_text", "before", "old"])?;
            let new = string_arg(args, &["newString", "new_string", "newText", "new_text", "after", "new"])?;
            let content = read_at(root_fd, &rel)?;
            if !content.contains(old) { return Err("Old text was not found in target file.".into()); }
            write_at(root_fd, &rel, &content.replacen(old, new, 1))?;
            Ok(format!("Edited {}", summarize(root, &rel)))
        }
        "delete_file" => {
            let rel = path(path_arg(args)?)?;
            unlink_file(root_fd, &rel)?;
            Ok(format!("Deleted {}", summarize(root, &rel)))
        }
        "create_folder" | "create_directory" => {
            let rel = path(directory_arg(args)?)?;
            open_dir(root_fd, &rel, true)?;
            Ok(format!("Created folder {}", summarize(root, &rel)))
        }
        "delete_folder" | "delete_directory" => {
            let rel = path(directory_arg(args)?)?;
            let (parent, child_name) = parent_and_name(root_fd, &rel, false)?;
            let child = open_child_dir(parent.as_raw_fd(), &child_name)?;
            remove_dir_contents(child.as_raw_fd(), 0, &mut 0)?;
            if unsafe { libc::unlinkat(parent.as_raw_fd(), child_name.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
                return Err(io_error("Could not delete project folder"));
            }
            Ok(format!("Deleted folder {}", summarize(root, &rel)))
        }
        "move_file" | "rename_file" | "move_folder" | "rename_folder" => {
            let from = path(source_arg(args)?)?;
            let to = path(destination_arg(args)?)?;
            move_at(root_fd, &from, &to)?;
            Ok(format!("Moved {} to {}", summarize(root, &from), summarize(root, &to)))
        }
        "copy_file" => {
            let from = path(source_arg(args)?)?;
            let to = path(destination_arg(args)?)?;
            let (src_dir, src_name) = parent_and_name(root_fd, &from, false)?;
            let (dst_dir, dst_name) = parent_and_name(root_fd, &to, true)?;
            copy_regular(src_dir.as_raw_fd(), &src_name, dst_dir.as_raw_fd(), &dst_name)?;
            Ok(format!("Copied {} to {}", summarize(root, &from), summarize(root, &to)))
        }
        "copy_folder" => {
            let from = path(source_arg(args)?)?;
            let to = path(destination_arg(args)?)?;
            if to.starts_with(&from) { return Err("Cannot copy folder into itself.".into()); }
            let source = open_dir(root_fd, &from, false)?;
            let target = open_dir(root_fd, &to, true)?;
            copy_dir_contents(source.as_raw_fd(), target.as_raw_fd(), 0, &mut 0)?;
            Ok(format!("Copied folder {} to {}", summarize(root, &from), summarize(root, &to)))
        }
        "glob" => {
            let rel = path(super::optional_path_arg(args).unwrap_or("."))?;
            let dir = open_dir(root_fd, &rel, false)?;
            let mut out = Vec::new();
            visit_dir(dir.as_raw_fd(), &rel, &mut out, 0)?;
            if out.is_empty() { return Ok("(folder is empty)".into()); }
            let truncated = out.len() >= MAX_LIST_ENTRIES;
            let mut text = out.join("\n");
            if truncated { text.push_str(&format!("\n[listing truncated at {MAX_LIST_ENTRIES} entries]")); }
            Ok(text)
        }
        "grep" => {
            let rel = path(super::optional_path_arg(args).unwrap_or("."))?;
            let pattern = string_arg(args, &["pattern", "query", "search"])?;
            let mut out = Vec::new();
            if rel.as_os_str().is_empty() {
                grep_dir(root_fd, &rel, pattern, &mut out, 0)?;
            } else {
                let (parent, child_name) = parent_and_name(root_fd, &rel, false)?;
                match kind(parent.as_raw_fd(), &child_name)? {
                    libc::S_IFDIR => {
                        let dir = open_child_dir(parent.as_raw_fd(), &child_name)?;
                        grep_dir(dir.as_raw_fd(), &rel, pattern, &mut out, 0)?;
                    }
                    libc::S_IFREG => grep_regular(parent.as_raw_fd(), &child_name, &rel, pattern, &mut out)?,
                    _ => return Err("Cannot search symbolic links or special files.".into()),
                }
            }
            if out.is_empty() { return Ok(format!("No matches for {pattern:?}.")); }
            let truncated = out.len() >= MAX_LIST_ENTRIES;
            let mut text = out.join("\n");
            if truncated { text.push_str(&format!("\n[results truncated at {MAX_LIST_ENTRIES} matches]")); }
            Ok(text)
        }
        _ => Err(format!("Unsupported coding tool: {name}")),
    }
}

#[cfg(test)]
mod security_tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::symlink;

    fn temp() -> (PathBuf, PathBuf) {
        let base = std::env::temp_dir().join(format!("council-confined-{}", uuid::Uuid::new_v4()));
        let root = base.join("project");
        std::fs::create_dir_all(&root).unwrap();
        (base, root.canonicalize().unwrap())
    }
    fn call(root: &Path, name: &str, args: Value) -> Result<String, String> {
        execute_file_tool(root, name, args.as_object().unwrap())
    }

    #[test]
    fn descriptor_relative_crud_and_recursive_operations() {
        let (base, root) = temp();
        call(&root, "write", json!({"path":"a/b/file.txt","content":"hello world"})).unwrap();
        assert_eq!(call(&root, "read", json!({"path":"a/b/file.txt"})).unwrap(), "hello world");
        call(&root, "edit", json!({"path":"a/b/file.txt","old":"world","new":"macos"})).unwrap();
        assert!(call(&root, "grep", json!({"pattern":"macos"})).unwrap().contains("a/b/file.txt"));
        assert!(call(&root, "glob", json!({"path":"a"})).unwrap().contains("a/b/file.txt"));
        call(&root, "copy_file", json!({"source":"a/b/file.txt","destination":"a/c/copy.txt"})).unwrap();
        call(&root, "rename_file", json!({"source":"a/c/copy.txt","destination":"a/c/renamed.txt"})).unwrap();
        call(&root, "copy_folder", json!({"source":"a/b","destination":"backup"})).unwrap();
        assert_eq!(call(&root, "read", json!({"path":"backup/file.txt"})).unwrap(), "hello macos");
        call(&root, "delete_file", json!({"path":"a/c/renamed.txt"})).unwrap();
        call(&root, "delete_folder", json!({"path":"a"})).unwrap();
        assert!(!root.join("a").exists());
        assert!(call(&root, "delete_folder", json!({"path":"."})).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn symlinks_cannot_escape_for_any_operation() {
        let (base, root) = temp();
        let outside = base.join("private");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), "private").unwrap();
        symlink(&outside, root.join("escape")).unwrap();
        for (tool, args) in [
            ("read", json!({"path":"escape/secret"})),
            ("write", json!({"path":"escape/created","content":"bad"})),
            ("edit", json!({"path":"escape/secret","old":"private","new":"bad"})),
            ("delete_file", json!({"path":"escape/secret"})),
            ("create_folder", json!({"path":"escape/subdir"})),
            ("delete_folder", json!({"path":"escape"})),
            ("rename_file", json!({"source":"escape/secret","destination":"moved"})),
            ("copy_file", json!({"source":"escape/secret","destination":"copied"})),
            ("copy_folder", json!({"source":"escape","destination":"copied"})),
            ("glob", json!({"path":"escape"})),
            ("grep", json!({"path":"escape","pattern":"private"})),
        ] {
            assert!(call(&root, tool, args).is_err(), "symlink escape allowed for {tool}");
        }
        assert_eq!(std::fs::read_to_string(outside.join("secret")).unwrap(), "private");
        assert!(!outside.join("created").exists());
        assert!(!outside.join("subdir").exists());
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn copied_tree_rejects_symlinks_and_root_deletion() {
        let (base, root) = temp();
        call(&root, "create_folder", json!({"path":"tree"})).unwrap();
        symlink("/etc", root.join("tree/link")).unwrap();
        assert!(call(&root, "copy_folder", json!({"source":"tree","destination":"copy"})).is_err());
        assert!(call(&root, "delete_file", json!({"path":"tree/link"})).is_err());
        assert!(call(&root, "copy_folder", json!({"source":"tree","destination":"tree/nested"})).is_err());
        assert!(call(&root, "delete_folder", json!({"path":"."})).is_err());
        std::fs::remove_dir_all(base).unwrap();
    }
}

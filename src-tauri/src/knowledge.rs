//! The knowledge library on disk.
//!
//! Records are markdown files in one folder, one file per record, named by the
//! record's id. That is the whole storage design, and it is deliberate: a
//! library you can open in any editor, keep in a git repo, and back up by
//! copying a folder is worth more than one that only exists behind an API.
//!
//! Writing is local and immediate; publishing to the database the cloud worker
//! reads is a separate, deliberate step (`scripts/seed-knowledge.mjs`). So a
//! half-written thought never reaches a running job, and nothing you type is
//! waiting on a network.
//!
//! Only `.md` files directly inside the folder are considered, and an id is
//! restricted to a slug, so a record can never be written outside the folder
//! it belongs to.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

#[derive(Debug, Serialize, Deserialize)]
pub struct KnowledgeFile {
    /// The record id, which is also the file stem.
    pub id: String,
    /// The subfolder this record lives in, empty for the top level.
    ///
    /// A collection *is* a folder: "AWS" in the sidebar is `Knowledge/AWS` on
    /// disk. That way organising the library in the app and organising it in
    /// Finder are the same act, and neither can drift from the other.
    pub category: String,
    pub markdown: String,
    pub path: String,
    /// Milliseconds since the epoch, for "last edited" in the list.
    #[serde(rename = "updatedAt")]
    pub updated_at: f64,
}

/// Named for a person, not for a bundle identifier.
///
/// This folder is meant to be opened, edited and backed up by hand, so it is
/// somewhere a human would look: "Council Editor / Knowledge" rather than
/// "com.charles.councileditor/knowledge". Application Support rather than
/// Documents deliberately — Documents costs a macOS permission prompt the first
/// time an app writes there, and a consent dialog is a strange thing to meet on
/// the way to saving a note.
fn library_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("No HOME in the environment")?;
    let support = PathBuf::from(&home).join("Library").join("Application Support");
    let dir = support.join("Council Editor").join("Knowledge");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create {}: {e}", dir.display()))?;

    // Anything written under the old bundle-id path moves across once. A
    // rename would be invisible to someone who had already found the folder;
    // copying the files means nothing is lost either way.
    let legacy = support.join("com.charles.councileditor").join("knowledge");
    if legacy.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&legacy) {
            for entry in entries.flatten() {
                let from = entry.path();
                if from.extension().and_then(|x| x.to_str()) != Some("md") {
                    continue;
                }
                let Some(name) = from.file_name() else { continue };
                let to = dir.join(name);
                if !to.exists() {
                    let _ = std::fs::copy(&from, &to);
                }
            }
        }
    }
    Ok(dir)
}

/// A slug, and nothing else. This is what keeps an id from becoming a path.
fn safe_id(id: &str) -> Result<String, String> {
    let trimmed = id.trim().to_lowercase();
    if trimmed.is_empty() {
        return Err("A record needs an id.".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("An id may only contain letters, numbers, hyphens and underscores.".into());
    }
    Ok(trimmed)
}

fn modified_ms(path: &std::path::Path) -> f64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

/// A collection name: one folder, never a path.
fn safe_category(category: &str) -> Result<String, String> {
    let trimmed = category.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    if trimmed.contains('/') || trimmed.contains('\\') || trimmed.starts_with('.') {
        return Err("A collection is a single folder name.".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_' || c == '+' || c == '&')
    {
        return Err("A collection name may only contain letters, numbers, spaces and - _ + &.".into());
    }
    Ok(trimmed.to_string())
}

fn read_records_in(dir: &std::path::Path, category: &str, out: &mut Vec<KnowledgeFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|x| x.to_str()) else {
            continue;
        };
        // A file whose name is not a usable id is left alone rather than
        // renamed: it is someone's file, in someone's folder.
        let Ok(id) = safe_id(stem) else { continue };
        let Ok(markdown) = std::fs::read_to_string(&path) else {
            continue;
        };
        out.push(KnowledgeFile {
            id,
            category: category.to_string(),
            markdown,
            path: path.to_string_lossy().into_owned(),
            updated_at: modified_ms(&path),
        });
    }
}

#[tauri::command]
pub async fn knowledge_list() -> Result<Vec<KnowledgeFile>, String> {
    crate::auth::require()?;
    let dir = library_dir()?;
    let mut out = Vec::new();
    read_records_in(&dir, "", &mut out);

    // One level of subfolder, and one only. Deeper nesting turns a library into
    // a filing system, and the thing being organised here is a few dozen notes.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let Some(name) = path.file_name().and_then(|x| x.to_str()) else {
                continue;
            };
            let Ok(category) = safe_category(name) else { continue };
            if category.is_empty() {
                continue;
            }
            read_records_in(&path, &category, &mut out);
        }
    }

    out.sort_by(|a, b| b.updated_at.partial_cmp(&a.updated_at).unwrap_or(std::cmp::Ordering::Equal));
    Ok(out)
}

#[tauri::command]
pub async fn knowledge_save(
    id: String,
    markdown: String,
    category: Option<String>,
    previous_id: Option<String>,
    previous_category: Option<String>,
) -> Result<KnowledgeFile, String> {
    crate::auth::require()?;
    let id = safe_id(&id)?;
    let category = safe_category(category.as_deref().unwrap_or(""))?;
    if markdown.trim().is_empty() {
        return Err("Nothing to save: the record is empty.".into());
    }
    let dir = library_dir()?;
    let folder = if category.is_empty() { dir.clone() } else { dir.join(&category) };
    std::fs::create_dir_all(&folder).map_err(|e| format!("Could not create {}: {e}", folder.display()))?;
    let path = folder.join(format!("{id}.md"));
    std::fs::write(&path, &markdown).map_err(|e| format!("Could not write {}: {e}", path.display()))?;

    // A renamed id, or a record moved to another collection, moves the file
    // rather than leaving a duplicate behind under the old name — which is what
    // "rename" and "move" mean to the person doing them.
    let old_id = previous_id.as_deref().map(safe_id).transpose()?;
    let old_category = safe_category(previous_category.as_deref().unwrap_or(""))?;
    if let Some(old_id) = old_id {
        let moved = old_id != id || old_category != category;
        if moved {
            let old_folder = if old_category.is_empty() { dir.clone() } else { dir.join(&old_category) };
            let _ = std::fs::remove_file(old_folder.join(format!("{old_id}.md")));
            // An emptied collection folder goes with it, so the sidebar does
            // not keep a heading with nothing under it.
            if !old_category.is_empty() {
                let _ = std::fs::remove_dir(old_folder);
            }
        }
    }

    Ok(KnowledgeFile {
        id,
        category,
        markdown,
        path: path.to_string_lossy().into_owned(),
        updated_at: modified_ms(&path),
    })
}

#[tauri::command]
pub async fn knowledge_delete(id: String, category: Option<String>) -> Result<(), String> {
    crate::auth::require()?;
    let id = safe_id(&id)?;
    let category = safe_category(category.as_deref().unwrap_or(""))?;
    let dir = library_dir()?;
    let folder = if category.is_empty() { dir } else { dir.join(&category) };
    let path = folder.join(format!("{id}.md"));
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        // Already gone is the state the caller wanted.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not delete {}: {e}", path.display())),
    }
}

/// Where the library lives, so the app can say it and open it in Finder.
#[tauri::command]
pub async fn knowledge_folder() -> Result<String, String> {
    crate::auth::require()?;
    Ok(library_dir()?.to_string_lossy().into_owned())
}

/// Publish the library to the database the cloud worker reads.
///
/// The app parses the markdown — it already does, to show the list — so what
/// travels is records rather than files, and the server validates them again
/// before writing. Deliberate, not automatic: a note you are still writing
/// should not reach a running job because you paused typing.
#[tauri::command]
pub async fn knowledge_publish(db: tauri::State<'_, crate::db::Db>, records: Value) -> Result<Value, String> {
    crate::auth::require()?;
    crate::server_api::call(db.inner(), "knowledge.publish", serde_json::json!({ "records": records })).await
}

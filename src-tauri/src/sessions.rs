//! Sessions: the container a screenshot belongs to.
//!
//! A capture on its own is not a problem statement. Three screenshots of the same
//! bug — the code, the terminal, the browser — are one question, and the session
//! is what says so. Everything downstream (history, the learning system, Project
//! Brain) hangs off this table, which is why it comes before the vision work.
//!
//! Ids cross the bridge as strings. The webview has no use for a typed UUID, and
//! parsing at the boundary means a malformed id fails here with a clear message
//! rather than somewhere deeper as a type error.

use crate::db::Db;
use serde::{Deserialize, Serialize};
use uuid::Uuid;

fn parse_id(id: &str, what: &str) -> Result<Uuid, String> {
    Uuid::parse_str(id).map_err(|_| format!("\"{id}\" is not a valid {what} id."))
}

// ------------------------------------------------------------------- records

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub title: String,
    pub note: String,
    pub context: String,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    /// Denormalised for the sidebar, which would otherwise need a query per row.
    pub screenshot_count: i64,
    pub run_count: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Screenshot {
    pub id: String,
    pub session_id: String,
    pub position: i32,
    pub local_path: Option<String>,
    pub storage_path: Option<String>,
    pub file_name: String,
    pub bytes: i32,
    pub mime: String,
    pub captured_at: String,
    /// True once the image itself has been destroyed. The row survives so history
    /// still reads correctly with the sensitive part gone.
    pub purged: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewScreenshot {
    pub session_id: String,
    /// Where the bytes now live. The row is written after the upload succeeds,
    /// so a screenshot in the table is a screenshot that can be fetched back.
    pub storage_bucket: String,
    pub storage_path: String,
    pub file_name: String,
    pub bytes: i32,
    pub mime: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

/// One agent's answer, as the store already holds it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponseIn {
    pub provider: String,
    pub model: String,
    pub attempt_id: String,
    pub status: String,
    pub body: String,
    pub final_kind: Option<String>,
    pub final_language: Option<String>,
    pub final_answer: Option<String>,
    pub final_code: Option<String>,
    pub final_claims: Vec<String>,
    pub complexity: Option<String>,
    pub confidence: Option<f32>,
    pub well_formed: bool,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerdictIn {
    pub verdict: String,
    pub headline: Option<String>,
    pub detail: Option<String>,
    pub reliability: Option<String>,
    pub camps: serde_json::Value,
    pub outliers: Vec<String>,
    pub representative: Option<String>,
    pub judge_provider: Option<String>,
    pub judge_text: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveJob {
    pub id: String,
    pub session_id: String,
    pub mode: String,
    pub status: String,
    pub progress_phase: String,
    pub settings_snapshot: serde_json::Value,
    pub error: Option<String>,
    pub result_summary: String,
    pub created_at: String,
    pub claimed_at: String,
    pub started_at: String,
    pub finished_at: String,
    pub updated_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveJobEvent {
    pub id: String,
    pub job_id: String,
    pub level: String,
    pub phase: String,
    pub message: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SolveJobImage {
    pub id: String,
    pub job_id: String,
    pub session_id: String,
    pub position: i32,
    pub storage_bucket: String,
    pub storage_path: String,
    pub file_name: String,
    pub bytes: i32,
    pub mime: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CouncilReportSummary {
    pub id: String,
    pub job_id: String,
    pub session_id: String,
    pub winner: Option<String>,
    pub synthesis: String,
    pub markdown: String,
    pub report: serde_json::Value,
    pub created_at: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSolveJobImage {
    pub storage_bucket: String,
    pub storage_path: String,
    pub file_name: String,
    pub bytes: i32,
    pub mime: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSolveJob {
    pub submission_id: String,
    pub session_id: String,
    pub settings_snapshot: serde_json::Value,
    pub images: Vec<NewSolveJobImage>,
}

// ------------------------------------------------------------------ sessions

#[tauri::command]
pub async fn session_list(
    db: tauri::State<'_, Db>,
    status: String,
) -> Result<Vec<Session>, String> {
    crate::server_api::call(
        db.inner(),
        "sessions.list",
        serde_json::json!({ "status": status }),
    )
    .await
}

#[tauri::command]
pub async fn session_create(db: tauri::State<'_, Db>, title: String) -> Result<String, String> {
    #[derive(serde::Deserialize)]
    struct Created {
        id: String,
    }
    let made: Created = crate::server_api::call(
        db.inner(),
        "sessions.create",
        serde_json::json!({ "title": title.trim() }),
    )
    .await?;
    Ok(made.id)
}

/// One command for every editable text field, rather than three near-identical
/// ones. `field` is checked against a fixed list, so it can never become a hole
/// through which arbitrary column names reach the query.
#[tauri::command]
pub async fn session_update(
    db: tauri::State<'_, Db>,
    id: String,
    field: String,
    value: String,
) -> Result<(), String> {
    let uid = parse_id(&id, "session")?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "sessions.update",
        serde_json::json!({ "id": uid.to_string(), "field": field, "value": value }),
    )
    .await?;
    Ok(())
}

/// Archive and restore are the same operation in two directions, so they are one
/// command. Archiving is reversible by design: a session you might want back is
/// not a session you should have to delete.
#[tauri::command]
pub async fn session_set_status(
    db: tauri::State<'_, Db>,
    id: String,
    status: String,
) -> Result<(), String> {
    if status != "active" && status != "archived" {
        return Err(format!("\"{status}\" is not a session status."));
    }
    let uid = parse_id(&id, "session")?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "sessions.setStatus",
        serde_json::json!({ "id": uid.to_string(), "status": status }),
    )
    .await?;
    Ok(())
}

/// Deletes the session and everything under it. Screenshot *files* are not
/// touched here — the caller decides that separately, because losing a session
/// record and losing the pictures are different kinds of loss.
#[tauri::command]
pub async fn session_delete(db: tauri::State<'_, Db>, id: String) -> Result<Vec<String>, String> {
    let uid = parse_id(&id, "session")?;
    crate::server_api::call(
        db.inner(),
        "sessions.delete",
        serde_json::json!({ "id": uid.to_string() }),
    )
    .await
}

// --------------------------------------------------------------- screenshots

#[tauri::command]
pub async fn screenshot_list(
    db: tauri::State<'_, Db>,
    session_id: String,
) -> Result<Vec<Screenshot>, String> {
    let sid = parse_id(&session_id, "session")?;
    crate::server_api::call(
        db.inner(),
        "screenshots.list",
        serde_json::json!({ "sessionId": sid.to_string() }),
    )
    .await
}

#[tauri::command]
pub async fn screenshot_add(
    db: tauri::State<'_, Db>,
    shot: NewScreenshot,
) -> Result<String, String> {
    let sid = parse_id(&shot.session_id, "session")?;
    #[derive(serde::Deserialize)]
    struct Added {
        id: String,
    }
    let added: Added = crate::server_api::call(
        db.inner(),
        "screenshots.add",
        serde_json::json!({
            "sessionId": sid.to_string(),
            "storageBucket": shot.storage_bucket,
            "storagePath": shot.storage_path,
            "fileName": shot.file_name,
            "bytes": shot.bytes,
            "mime": shot.mime,
            "width": shot.width,
            "height": shot.height,
        }),
    )
    .await?;
    Ok(added.id)
}

#[tauri::command]
pub async fn screenshot_remove(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    let uid = parse_id(&id, "screenshot")?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "screenshots.remove",
        serde_json::json!({ "id": uid.to_string() }),
    )
    .await?;
    Ok(())
}

/// Rewrites positions to match the given order.
///
/// Runs in a transaction because `(session_id, position)` is unique: swapping two
/// rows passes through a state where both hold the same position. The constraint
/// is declared deferrable so that intermediate state is legal until commit.
#[tauri::command]
pub async fn screenshot_reorder(
    db: tauri::State<'_, Db>,
    session_id: String,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let sid = parse_id(&session_id, "session")?;
    let ids: Vec<Uuid> = ordered_ids
        .iter()
        .map(|i| parse_id(i, "screenshot"))
        .collect::<Result<_, _>>()?;
    let _: serde_json::Value = crate::server_api::call(
        db.inner(),
        "screenshots.reorder",
        serde_json::json!({
            "sessionId": sid.to_string(),
            "ids": ids.iter().map(|i| i.to_string()).collect::<Vec<_>>(),
        }),
    )
    .await?;
    Ok(())
}

/// Destroys the images while keeping the rows.
///
/// Returns the local paths so the caller can delete the files it owns. This is
/// the "delete the pictures once I am done" case: the session stays readable,
/// the sensitive part does not.
#[tauri::command]
pub async fn screenshots_purge(
    db: tauri::State<'_, Db>,
    session_id: String,
) -> Result<Vec<String>, String> {
    let sid = parse_id(&session_id, "session")?;
    crate::server_api::call(
        db.inner(),
        "screenshots.purge",
        serde_json::json!({ "sessionId": sid.to_string() }),
    )
    .await
}

// ---------------------------------------------------------------------- runs

/// Persists a finished run: what was asked, what every agent said, and the
/// verdict. Written in one transaction so history never contains a run whose
/// answers are half saved.
#[tauri::command]
pub async fn run_save(
    db: tauri::State<'_, Db>,
    session_id: String,
    mode: String,
    asked: String,
    // How the agents were given the problem: images | extract | both. Plain
    // comments rather than doc comments: `///` on a parameter is a hard error.
    context_mode: String,
    // The cross-checked reading the agents worked from, when there was one.
    extracted_context: String,
    // None when no vision pass ran; Some(false) when the two readers disagreed.
    extraction_agreed: Option<bool>,
    responses: Vec<ResponseIn>,
    verdict: Option<VerdictIn>,
) -> Result<String, String> {
    let sid = parse_id(&session_id, "session")?;
    let answered = responses.len();
    let had_verdict = verdict.is_some();
    #[derive(serde::Deserialize)]
    struct Saved {
        id: String,
    }
    // One call, one transaction. The Postgres function writes the run, its
    // answers and its verdict together or not at all — the same guarantee
    // the local `begin`/`commit` gave, which is why this is an rpc rather
    // than three inserts over HTTP.
    let saved: Saved = crate::server_api::call(
        db.inner(),
        "runs.save",
        serde_json::json!({
            "sessionId": sid.to_string(),
            "mode": mode,
            "asked": asked,
            "contextMode": context_mode,
            "extractedContext": extracted_context,
            "extractionAgreed": extraction_agreed,
            "responses": responses,
            "verdict": verdict,
        }),
    )
    .await?;

    crate::trace(&format!(
        "run saved {} ({answered} answer(s), {} verdict) for session {sid}",
        saved.id,
        if had_verdict { "with" } else { "no" }
    ));
    Ok(saved.id)
}

// ------------------------------------------------------------- solve jobs

// ------------------------------------------------------------------- history

/// One past run, as the sidebar lists it.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub session_id: String,
    pub mode: String,
    pub asked: String,
    pub started_at: String,
    pub finished_at: String,
    pub answered: i64,
    pub verdict: Option<String>,
    pub reliability: Option<String>,
}

/// What one model said, read back out of the run it said it in.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredResponse {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub attempt_id: String,
    pub status: String,
    pub body: String,
    pub final_kind: Option<String>,
    pub final_language: Option<String>,
    pub final_answer: Option<String>,
    pub final_code: Option<String>,
    pub final_claims: Vec<String>,
    pub complexity: Option<String>,
    pub confidence: Option<f32>,
    pub well_formed: bool,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub elapsed_ms: Option<i64>,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredVerdict {
    pub verdict: String,
    pub headline: Option<String>,
    pub detail: Option<String>,
    pub reliability: Option<String>,
    pub outliers: Vec<String>,
    pub representative: Option<String>,
    pub judge_provider: Option<String>,
    pub judge_text: Option<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDetail {
    pub run: RunSummary,
    pub responses: Vec<StoredResponse>,
    pub verdict: Option<StoredVerdict>,
}

/// Every run this session has finished, newest first.
///
/// `run_save` has been writing these since the first version of the app. Nothing
/// ever read them back, so a finished run was visible for exactly as long as the
/// panes held it and then existed only in the database. This is the missing half.
#[tauri::command]
pub async fn run_list(
    db: tauri::State<'_, Db>,
    session_id: String,
) -> Result<Vec<RunSummary>, String> {
    let sid = parse_id(&session_id, "session")?;
    crate::server_api::call(
        db.inner(),
        "runs.list",
        serde_json::json!({ "sessionId": sid.to_string() }),
    )
    .await
}

/// One run in full: every model's answer as it was stored, plus the verdict.
#[tauri::command]
pub async fn run_get(db: tauri::State<'_, Db>, run_id: String) -> Result<RunDetail, String> {
    let rid = parse_id(&run_id, "run")?;
    crate::server_api::call(
        db.inner(),
        "runs.get",
        serde_json::json!({ "runId": rid.to_string() }),
    )
    .await
}

#[tauri::command]
pub async fn solve_job_create(
    db: tauri::State<'_, Db>,
    job: NewSolveJob,
) -> Result<String, String> {
    if job.images.is_empty() {
        return Err("A solve job needs at least one screenshot.".into());
    }
    let sid = parse_id(&job.session_id, "session")?;
    let submission = parse_id(&job.submission_id, "submission")?;
    #[derive(serde::Deserialize)]
    struct Queued {
        id: String,
    }
    let queued: Queued = crate::server_api::call(
        db.inner(),
        "jobs.create",
        serde_json::json!({
            "sessionId": sid.to_string(),
            "submissionId": submission.to_string(),
            "settingsSnapshot": job.settings_snapshot,
            "images": job.images,
        }),
    )
    .await?;
    Ok(queued.id)
}

#[tauri::command]
pub async fn solve_job_list(
    db: tauri::State<'_, Db>,
    status: String,
) -> Result<Vec<SolveJob>, String> {
    crate::server_api::call(
        db.inner(),
        "jobs.list",
        serde_json::json!({ "status": status }),
    )
    .await
}

#[tauri::command]
pub async fn solve_job_event_list(
    db: tauri::State<'_, Db>,
    job_id: String,
) -> Result<Vec<SolveJobEvent>, String> {
    let jid = parse_id(&job_id, "solve job")?;
    crate::server_api::call(
        db.inner(),
        "jobs.events",
        serde_json::json!({ "jobId": jid.to_string() }),
    )
    .await
}

#[tauri::command]
pub async fn solve_job_image_list(
    db: tauri::State<'_, Db>,
    job_id: String,
) -> Result<Vec<SolveJobImage>, String> {
    let jid = parse_id(&job_id, "solve job")?;
    crate::server_api::call(
        db.inner(),
        "jobs.images",
        serde_json::json!({ "jobId": jid.to_string() }),
    )
    .await
}

#[tauri::command]
pub async fn council_report_get(
    db: tauri::State<'_, Db>,
    job_id: String,
) -> Result<Option<CouncilReportSummary>, String> {
    let jid = parse_id(&job_id, "solve job")?;
    crate::server_api::call(
        db.inner(),
        "reports.get",
        serde_json::json!({ "jobId": jid.to_string() }),
    )
    .await
}

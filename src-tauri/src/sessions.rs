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

use crate::db::{pool, Db};
use serde::{Deserialize, Serialize};
use sqlx::Row;
use uuid::Uuid;

fn parse_id(id: &str, what: &str) -> Result<Uuid, String> {
    Uuid::parse_str(id).map_err(|_| format!("\"{id}\" is not a valid {what} id."))
}

// ------------------------------------------------------------------- records

#[derive(Serialize)]
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

#[derive(Serialize)]
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
#[derive(Deserialize)]
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

#[derive(Deserialize)]
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

#[derive(Serialize)]
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

#[derive(Serialize)]
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

#[derive(Serialize)]
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

fn ts(row: &sqlx::postgres::PgRow, col: &str) -> String {
    row.try_get::<chrono::DateTime<chrono::Utc>, _>(col)
        .map(|t| t.to_rfc3339())
        .unwrap_or_default()
}

fn ts_opt(row: &sqlx::postgres::PgRow, col: &str) -> String {
    row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>(col)
        .ok()
        .flatten()
        .map(|t| t.to_rfc3339())
        .unwrap_or_default()
}

// ------------------------------------------------------------------ sessions

#[tauri::command]
pub async fn session_list(db: tauri::State<'_, Db>, status: String) -> Result<Vec<Session>, String> {
    let p = pool(&db).await?;
    let rows = sqlx::query(
        "select s.id, s.title, s.note, s.context, s.status, s.created_at, s.updated_at,
                (select count(*) from screenshots x where x.session_id = s.id) as shots,
                (select count(*) from runs r where r.session_id = s.id) as runs
           from sessions s
          where s.status = $1
          order by s.updated_at desc",
    )
    .bind(&status)
    .fetch_all(&p)
    .await
    .map_err(|e| format!("Could not list sessions: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| Session {
            id: r.get::<Uuid, _>("id").to_string(),
            title: r.get("title"),
            note: r.get("note"),
            context: r.get("context"),
            status: r.get("status"),
            created_at: ts(r, "created_at"),
            updated_at: ts(r, "updated_at"),
            screenshot_count: r.try_get("shots").unwrap_or(0),
            run_count: r.try_get("runs").unwrap_or(0),
        })
        .collect())
}

#[tauri::command]
pub async fn session_create(db: tauri::State<'_, Db>, title: String) -> Result<String, String> {
    let p = pool(&db).await?;
    let title = if title.trim().is_empty() {
        "Untitled session".to_string()
    } else {
        title.trim().to_string()
    };
    let row = sqlx::query("insert into sessions (title) values ($1) returning id")
        .bind(&title)
        .fetch_one(&p)
        .await
        .map_err(|e| format!("Could not create the session: {e}"))?;
    Ok(row.get::<Uuid, _>("id").to_string())
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
    let sql = match field.as_str() {
        "title" => "update sessions set title = $1 where id = $2",
        "note" => "update sessions set note = $1 where id = $2",
        "context" => "update sessions set context = $1 where id = $2",
        other => return Err(format!("\"{other}\" is not an editable session field.")),
    };
    let p = pool(&db).await?;
    sqlx::query(sql)
        .bind(&value)
        .bind(uid)
        .execute(&p)
        .await
        .map_err(|e| format!("Could not update the session: {e}"))?;
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
    let p = pool(&db).await?;
    sqlx::query("update sessions set status = $1 where id = $2")
        .bind(&status)
        .bind(uid)
        .execute(&p)
        .await
        .map_err(|e| format!("Could not change the session status: {e}"))?;
    Ok(())
}

/// Deletes the session and everything under it. Screenshot *files* are not
/// touched here — the caller decides that separately, because losing a session
/// record and losing the pictures are different kinds of loss.
#[tauri::command]
pub async fn session_delete(db: tauri::State<'_, Db>, id: String) -> Result<Vec<String>, String> {
    let uid = parse_id(&id, "session")?;
    let p = pool(&db).await?;

    // Hand back the paths so the caller can remove the files if it wants to.
    let rows = sqlx::query(
        "select local_path from screenshots
          where session_id = $1 and local_path is not null and purged_at is null",
    )
    .bind(uid)
    .fetch_all(&p)
    .await
    .map_err(|e| format!("Could not read the session's screenshots: {e}"))?;

    let paths: Vec<String> = rows
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>("local_path").ok().flatten())
        .collect();

    sqlx::query("delete from sessions where id = $1")
        .bind(uid)
        .execute(&p)
        .await
        .map_err(|e| format!("Could not delete the session: {e}"))?;

    Ok(paths)
}

// --------------------------------------------------------------- screenshots

#[tauri::command]
pub async fn screenshot_list(
    db: tauri::State<'_, Db>,
    session_id: String,
) -> Result<Vec<Screenshot>, String> {
    let sid = parse_id(&session_id, "session")?;
    let p = pool(&db).await?;
    let rows = sqlx::query(
        "select id, session_id, position, local_path, storage_path, file_name,
                bytes, mime, captured_at, purged_at
           from screenshots where session_id = $1 order by position",
    )
    .bind(sid)
    .fetch_all(&p)
    .await
    .map_err(|e| format!("Could not list screenshots: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| Screenshot {
            id: r.get::<Uuid, _>("id").to_string(),
            session_id: r.get::<Uuid, _>("session_id").to_string(),
            position: r.get("position"),
            local_path: r.try_get("local_path").ok().flatten(),
            storage_path: r.try_get("storage_path").ok().flatten(),
            file_name: r.get("file_name"),
            bytes: r.try_get("bytes").unwrap_or(0),
            mime: r.get("mime"),
            captured_at: ts(r, "captured_at"),
            purged: r
                .try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("purged_at")
                .ok()
                .flatten()
                .is_some(),
        })
        .collect())
}

#[tauri::command]
pub async fn screenshot_add(
    db: tauri::State<'_, Db>,
    shot: NewScreenshot,
) -> Result<String, String> {
    let sid = parse_id(&shot.session_id, "session")?;
    let p = pool(&db).await?;

    // Append. Computed in SQL rather than read-then-write, so two captures
    // landing at once cannot be handed the same position.
    // `local_path` is deliberately left null. The file on this machine is a
    // staging area that lives for a second between the capture and the upload,
    // and a path to something already deleted is a row that lies about where the
    // bytes are.
    let row = sqlx::query(
        "insert into screenshots
             (session_id, position, storage_bucket, storage_path, uploaded_at,
              file_name, bytes, mime, width, height)
         values ($1,
                 coalesce((select max(position) + 1 from screenshots where session_id = $1), 0),
                 $2, $3, now(), $4, $5, $6, $7, $8)
         returning id",
    )
    .bind(sid)
    .bind(&shot.storage_bucket)
    .bind(&shot.storage_path)
    .bind(&shot.file_name)
    .bind(shot.bytes)
    .bind(&shot.mime)
    .bind(shot.width)
    .bind(shot.height)
    .fetch_one(&p)
    .await
    .map_err(|e| format!("Could not attach the screenshot: {e}"))?;

    Ok(row.get::<Uuid, _>("id").to_string())
}

#[tauri::command]
pub async fn screenshot_remove(db: tauri::State<'_, Db>, id: String) -> Result<(), String> {
    let uid = parse_id(&id, "screenshot")?;
    let p = pool(&db).await?;
    sqlx::query("delete from screenshots where id = $1")
        .bind(uid)
        .execute(&p)
        .await
        .map_err(|e| format!("Could not remove the screenshot: {e}"))?;
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

    let p = pool(&db).await?;
    let mut tx = p.begin().await.map_err(|e| e.to_string())?;

    sqlx::query("set constraints all deferred")
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;

    for (position, id) in ids.iter().enumerate() {
        sqlx::query("update screenshots set position = $1 where id = $2 and session_id = $3")
            .bind(position as i32)
            .bind(id)
            .bind(sid)
            .execute(&mut *tx)
            .await
            .map_err(|e| format!("Could not reorder: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Could not save the new order: {e}"))?;
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
    let p = pool(&db).await?;

    // Read the paths before nulling them: `returning` cannot hand back a column
    // the same statement has just cleared.
    let rows = sqlx::query(
        "select local_path from screenshots
          where session_id = $1 and local_path is not null and purged_at is null",
    )
    .bind(sid)
    .fetch_all(&p)
    .await
    .map_err(|e| format!("Could not read the screenshots: {e}"))?;

    let paths: Vec<String> = rows
        .iter()
        .filter_map(|r| r.try_get::<Option<String>, _>("local_path").ok().flatten())
        .collect();

    sqlx::query(
        "update screenshots set purged_at = now(), local_path = null, storage_path = null
          where session_id = $1 and purged_at is null",
    )
    .bind(sid)
    .execute(&p)
    .await
    .map_err(|e| format!("Could not purge the screenshots: {e}"))?;

    Ok(paths)
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
    let p = pool(&db).await?;
    let mut tx = p.begin().await.map_err(|e| e.to_string())?;

    let run_row = sqlx::query(
        "insert into runs
             (session_id, mode, asked, context_mode, extracted_context,
              extraction_agreed, finished_at)
         values ($1, $2, $3, $4, $5, $6, now()) returning id",
    )
    .bind(sid)
    .bind(&mode)
    .bind(&asked)
    .bind(&context_mode)
    .bind(&extracted_context)
    .bind(extraction_agreed)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| format!("Could not record the run: {e}"))?;
    let run_id: Uuid = run_row.get("id");

    for r in &responses {
        sqlx::query(
            "insert into agent_responses
                 (run_id, provider, model, attempt_id, status, body, final_kind,
                  final_language, final_answer, final_code, final_claims, complexity,
                  confidence, well_formed, input_tokens, output_tokens, elapsed_ms, error)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)",
        )
        .bind(run_id)
        .bind(&r.provider)
        .bind(&r.model)
        .bind(&r.attempt_id)
        .bind(&r.status)
        .bind(&r.body)
        .bind(&r.final_kind)
        .bind(&r.final_language)
        .bind(&r.final_answer)
        .bind(&r.final_code)
        .bind(&r.final_claims)
        .bind(&r.complexity)
        .bind(r.confidence)
        .bind(r.well_formed)
        .bind(r.input_tokens)
        .bind(r.output_tokens)
        .bind(r.elapsed_ms)
        .bind(&r.error)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Could not save {}'s answer: {e}", r.provider))?;
    }

    if let Some(v) = &verdict {
        sqlx::query(
            "insert into verdicts
                 (run_id, verdict, headline, detail, reliability, camps, outliers,
                  representative, judge_provider, judge_text)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        )
        .bind(run_id)
        .bind(&v.verdict)
        .bind(&v.headline)
        .bind(&v.detail)
        .bind(&v.reliability)
        .bind(&v.camps)
        .bind(&v.outliers)
        .bind(&v.representative)
        .bind(&v.judge_provider)
        .bind(&v.judge_text)
        .execute(&mut *tx)
        .await
        .map_err(|e| format!("Could not save the verdict: {e}"))?;
    }

    tx.commit()
        .await
        .map_err(|e| format!("Could not commit the run: {e}"))?;

    // The other half of the record. Uploads were already traced, so without this
    // the log could show a screenshot safely stored and say nothing about
    // whether the answers to it survived — which is the half that cannot be
    // recaptured by pressing the shortcut again.
    crate::trace(&format!(
        "run saved {run_id} ({answered} answer(s), {} verdict) for session {sid}",
        if had_verdict { "with" } else { "no" }
    ));

    Ok(run_id.to_string())
}

// ------------------------------------------------------------- solve jobs

#[tauri::command]
pub async fn solve_job_list(
    db: tauri::State<'_, Db>,
    status: String,
) -> Result<Vec<SolveJob>, String> {
    if ![
        "queued",
        "running",
        "needs_attention",
        "failed",
        "completed",
        "cancelled",
        "all",
    ]
    .contains(&status.as_str())
    {
        return Err(format!("\"{status}\" is not a solve job status."));
    }

    let p = pool(&db).await?;
    let rows = if status == "all" {
        sqlx::query(
            "select id, session_id, mode, status, progress_phase, settings_snapshot,
                    error, result_summary, created_at, claimed_at, started_at,
                    finished_at, updated_at
               from solve_jobs order by created_at desc limit 100",
        )
        .fetch_all(&p)
        .await
    } else {
        sqlx::query(
            "select id, session_id, mode, status, progress_phase, settings_snapshot,
                    error, result_summary, created_at, claimed_at, started_at,
                    finished_at, updated_at
               from solve_jobs where status = $1 order by created_at desc limit 100",
        )
        .bind(&status)
        .fetch_all(&p)
        .await
    }
    .map_err(|e| format!("Could not list solve jobs: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| SolveJob {
            id: r.get::<Uuid, _>("id").to_string(),
            session_id: r.get::<Uuid, _>("session_id").to_string(),
            mode: r.get("mode"),
            status: r.get("status"),
            progress_phase: r.get("progress_phase"),
            settings_snapshot: r
                .try_get("settings_snapshot")
                .unwrap_or_else(|_| serde_json::json!({})),
            error: r.try_get("error").ok().flatten(),
            result_summary: r.get("result_summary"),
            created_at: ts(r, "created_at"),
            claimed_at: ts_opt(r, "claimed_at"),
            started_at: ts_opt(r, "started_at"),
            finished_at: ts_opt(r, "finished_at"),
            updated_at: ts(r, "updated_at"),
        })
        .collect())
}

#[tauri::command]
pub async fn solve_job_event_list(
    db: tauri::State<'_, Db>,
    job_id: String,
) -> Result<Vec<SolveJobEvent>, String> {
    let jid = parse_id(&job_id, "solve job")?;
    let p = pool(&db).await?;
    let rows = sqlx::query(
        "select id, job_id, level, phase, message, payload, created_at
           from solve_job_events where job_id = $1 order by created_at",
    )
    .bind(jid)
    .fetch_all(&p)
    .await
    .map_err(|e| format!("Could not list solve job events: {e}"))?;

    Ok(rows
        .iter()
        .map(|r| SolveJobEvent {
            id: r.get::<Uuid, _>("id").to_string(),
            job_id: r.get::<Uuid, _>("job_id").to_string(),
            level: r.get("level"),
            phase: r.get("phase"),
            message: r.get("message"),
            payload: r.try_get("payload").unwrap_or_else(|_| serde_json::json!({})),
            created_at: ts(r, "created_at"),
        })
        .collect())
}

#[tauri::command]
pub async fn council_report_get(
    db: tauri::State<'_, Db>,
    job_id: String,
) -> Result<Option<CouncilReportSummary>, String> {
    let jid = parse_id(&job_id, "solve job")?;
    let p = pool(&db).await?;
    let row = sqlx::query(
        "select id, job_id, session_id, winner, synthesis, markdown, report, created_at
           from council_reports where job_id = $1",
    )
    .bind(jid)
    .fetch_optional(&p)
    .await
    .map_err(|e| format!("Could not load the council report: {e}"))?;

    Ok(row.map(|r| CouncilReportSummary {
        id: r.get::<Uuid, _>("id").to_string(),
        job_id: r.get::<Uuid, _>("job_id").to_string(),
        session_id: r.get::<Uuid, _>("session_id").to_string(),
        winner: r.try_get("winner").ok().flatten(),
        synthesis: r.get("synthesis"),
        markdown: r.get("markdown"),
        report: r.try_get("report").unwrap_or_else(|_| serde_json::json!({})),
        created_at: ts(&r, "created_at"),
    }))
}

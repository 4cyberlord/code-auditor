//! Streaming fan-out to the model providers.
//!
//! Every network call happens here in Rust rather than in the webview. Two reasons:
//! the API keys never leave the process boundary, and we sidestep browser CORS
//! entirely (Anthropic in particular refuses direct browser calls without an
//! explicit opt-in header).
//!
//! Each provider speaks SSE but with a different envelope, so `stream_sse` handles
//! the transport and a small per-provider extractor pulls the text out of each chunk.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::secrets;

pub const EV_DELTA: &str = "agent://delta";
pub const EV_DONE: &str = "agent://done";
pub const EV_ERROR: &str = "agent://error";

// ---------------------------------------------------------------- run registry

/// The registry slot is `runId::agentId` so that `cancel_run` can still sweep a
/// whole run by prefix, but the value carries the *attempt* id. `runId::agentId`
/// repeats across reruns of the same pane, so it cannot on its own tell one
/// attempt from the next.
#[derive(Clone, Default)]
pub struct RunRegistry(Arc<Mutex<HashMap<String, (String, CancellationToken)>>>);

impl RunRegistry {
    /// A poisoned lock here only means some earlier task panicked mid-update; the
    /// map itself stays a valid `HashMap`, and taking it over is far better than
    /// propagating the panic (release builds use `panic = "abort"`, so an unwrap
    /// on a poisoned lock would take the whole app down).
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, (String, CancellationToken)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Claims the pane for `attempt`, cancelling whatever held it. Without the
    /// cancel, the superseded request keeps streaming and two responses
    /// interleave into one pane.
    fn insert(&self, key: String, attempt: String) -> CancellationToken {
        let token = CancellationToken::new();
        if let Some((_, previous)) = self.map().insert(key, (attempt, token.clone())) {
            previous.cancel();
        }
        token
    }

    /// Clears the slot only if it still holds this attempt. An unconditional
    /// remove lets a superseded task evict the token of the attempt that
    /// replaced it, after which Stop silently does nothing for that pane.
    fn finish(&self, key: &str, attempt: &str) {
        let mut map = self.map();
        if map.get(key).is_some_and(|(a, _)| a == attempt) {
            map.remove(key);
        }
    }

    fn cancel_prefix(&self, prefix: &str) {
        for (k, (_, token)) in self.map().iter() {
            if k.starts_with(prefix) {
                token.cancel();
            }
        }
    }
}

// ------------------------------------------------------------------- payloads

pub use crate::platform_base::ImageInput;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    pub run_id: String,
    pub agent_id: String,
    /// Unique per launch, including reruns of the same pane within a run. This is
    /// the identity every guard on both sides of the bridge keys on.
    #[serde(default)]
    pub attempt_id: String,
    /// "openai" | "moonshot" | "anthropic" | "gemini"
    pub provider: String,
    pub model: String,
    pub system_prompt: String,
    pub user_text: String,
    #[serde(default)]
    pub images: Vec<ImageInput>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: f32,
    /// Override the provider's default host (self-hosted / proxy / region).
    #[serde(default)]
    pub base_url: Option<String>,
    /// "chat" (default) rides the chat-completions wire. "responses" is the
    /// OpenAI Responses API — a different route on the same router, which the
    /// probe now discovers so callers stop paying for a 4xx that tells them
    /// exactly that.
    #[serde(default)]
    pub endpoint: Option<String>,
}

fn default_max_tokens() -> u32 {
    8192
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQwenRequest {
    pub model: String,
    /// Full chat-completions URL, for example http://127.0.0.1:8787/v1/chat/completions.
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    pub system_prompt: String,
    pub user_text: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: f32,
    #[serde(default)]
    pub messages: Option<Vec<Value>>,
    #[serde(default)]
    pub tools: Option<Vec<Value>>,
    /// Planning requests are read-only; execute requests are mutation tasks.
    #[serde(default)]
    pub mode: Option<String>,
    /// Identifies this run to the bridge so it can be stopped mid-flight. The
    /// bridge tracks it under `x-bridge-run-id`; `cancel_local_qwen` sends the
    /// same value back to tear the upstream call down.
    #[serde(default)]
    pub run_id: Option<String>,
    /// Per-request override for the model's reasoning pass. `None` leaves the
    /// bridge to fall back to its own `WIRO_ENABLE_THINKING` default; `Some`
    /// forwards the caller's choice so a UI toggle can turn reasoning on or off
    /// without restarting the bridge.
    #[serde(default)]
    pub enable_thinking: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQwenCancelRequest {
    /// Bridge root, e.g. http://127.0.0.1:8787/v1 — the same value the chat URL
    /// is derived from.
    pub base_url: String,
    pub run_id: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQwenInspectRequest {
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQwenInspectResult {
    pub health: Value,
    pub models: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQwenToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WiroTurnInfo {
    pub task_id: Option<String>,
    pub elapsed_seconds: Option<f64>,
    pub total_cost: Option<f64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalQwenResponse {
    pub content: String,
    pub tool_calls: Vec<LocalQwenToolCall>,
    /// The model's reasoning for this turn. The bridge forwards it as
    /// `reasoning_content` when EXPOSE_REASONING is on; dropping it here left
    /// the UI with tool calls and no account of why they were chosen.
    #[serde(default)]
    pub reasoning: String,
    /// Upstream task metadata for this turn (id, elapsed, cost), when the
    /// bridge reports it. Shown in the run log so spend is never invisible.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wiro: Option<WiroTurnInfo>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingModelStepRequest {
    /// "openai" | "moonshot" | "tokenrouter"; direct Anthropic/Gemini tools are
    /// intentionally not claimed here until their native tool wires are mapped.
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    #[serde(default)]
    pub temperature: f32,
    pub messages: Vec<Value>,
    #[serde(default)]
    pub tools: Vec<Value>,
}

fn local_qwen_api_key(override_key: Option<&str>) -> String {
    let saved_key = secrets::read_api_key("coding_bridge").ok();
    override_key
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| saved_key.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or("local")
        .to_string()
}

#[tauri::command]
pub async fn run_coding_model_step(req: CodingModelStepRequest) -> Result<LocalQwenResponse, String> {
    crate::auth::require()?;
    let provider = req.provider.trim();
    if !matches!(provider, "openai" | "moonshot" | "tokenrouter") {
        return Err(format!(
            "{provider} is not available for Coding yet. Choose a TokenRouter, OpenAI, or Moonshot chat model."
        ));
    }
    let model = req.model.trim();
    if model.is_empty() {
        return Err("Choose a coding model before running.".into());
    }
    if req.messages.is_empty() {
        return Err("Coding model request must include messages.".into());
    }

    let key = secrets::read_api_key(provider)?;
    let base = req.base_url.clone().filter(|b| !b.trim().is_empty()).unwrap_or_else(|| {
        match provider {
            "openai" => "https://api.openai.com/v1".into(),
            "tokenrouter" => "https://api.tokenrouter.com/v1".into(),
            _ => "https://api.moonshot.ai/v1".into(),
        }
    });
    let mut body = json!({
        "model": model,
        "messages": req.messages,
        "stream": false
    });
    if provider == "openai" {
        body["max_completion_tokens"] = json!(req.max_tokens);
    } else {
        body["max_tokens"] = json!(req.max_tokens);
    }
    if req.temperature > 0.0 {
        body["temperature"] = json!(req.temperature);
    }
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(req.tools);
        body["tool_choice"] = json!("auto");
    }

    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let client = http_client()?;
    let key_c = key.clone();
    let body_c = body.clone();
    let sent = send_governed(
        || client.post(&url).header("Authorization", format!("Bearer {key_c}")).json(&body_c).timeout(ONCE_TIMEOUT),
        provider == GATEWAY,
    )
    .await
    .map_err(|e| format!("{provider}: {}", transport_detail(&e)))?;
    let status = sent.status();
    let text = sent.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{provider} {status}: {}", truncate(&explain(&text), 600)));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("{provider}: response was not JSON ({e})"))?;
    Ok(parse_local_qwen_response(&v))
}

#[tauri::command]
pub async fn inspect_local_qwen(req: LocalQwenInspectRequest) -> Result<LocalQwenInspectResult, String> {
    crate::auth::require()?;
    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Qwen base URL is empty.".into());
    }
    let api_key = local_qwen_api_key(req.api_key.as_deref());
    let client = http_client()?;

    let get_json = |url: String| {
        client
            .get(url)
            .header("Authorization", format!("Bearer {api_key}"))
            .timeout(ONCE_TIMEOUT)
    };

    let health_resp = get_json(format!("{base}/health"))
        .send()
        .await
        .map_err(|e| format!("qwen health: {}", transport_detail(&e)))?;
    let health_status = health_resp.status();
    let health_text = health_resp.text().await.unwrap_or_default();
    if !health_status.is_success() {
        return Err(format!(
            "qwen health {}: {}",
            health_status,
            truncate(&explain(&health_text), 600)
        ));
    }

    let models_resp = get_json(format!("{base}/models"))
        .send()
        .await
        .map_err(|e| format!("qwen models: {}", transport_detail(&e)))?;
    let models_status = models_resp.status();
    let models_text = models_resp.text().await.unwrap_or_default();
    if !models_status.is_success() {
        return Err(format!(
            "qwen models {}: {}",
            models_status,
            truncate(&explain(&models_text), 600)
        ));
    }

    Ok(LocalQwenInspectResult {
        health: serde_json::from_str(&health_text)
            .map_err(|e| format!("qwen health: response was not JSON ({e})"))?,
        models: serde_json::from_str(&models_text)
            .map_err(|e| format!("qwen models: response was not JSON ({e})"))?,
    })
}

#[tauri::command]
pub async fn run_local_qwen(req: LocalQwenRequest) -> Result<String, String> {
    let response = run_local_qwen_step(req).await?;
    if !response.content.trim().is_empty() {
        return Ok(response.content);
    }
    if !response.tool_calls.is_empty() {
        return Err("qwen returned tool calls, but this caller expected a final text response.".into());
    }
    Err("qwen returned an empty response.".into())
}

#[tauri::command]
pub async fn run_local_qwen_step(req: LocalQwenRequest) -> Result<LocalQwenResponse, String> {
    crate::auth::require()?;
    let url = req.base_url.trim();
    if url.is_empty() {
        return Err("Qwen URL is empty.".into());
    }

    let messages = req.messages.unwrap_or_else(|| {
        vec![
            json!({ "role": "system", "content": req.system_prompt }),
            json!({ "role": "user", "content": req.user_text }),
        ]
    });
    let mut body = json!({
        "model": req.model,
        "temperature": req.temperature,
        "max_tokens": req.max_tokens,
        "messages": messages
    });
    if let Some(tools) = req.tools.filter(|tools| !tools.is_empty()) {
        body["tools"] = Value::Array(tools);
        body["tool_choice"] = json!("auto");
    }
    if let Some(mode) = req.mode.as_deref().map(str::trim).filter(|mode| !mode.is_empty()) {
        body["metadata"] = json!({ "mode": mode });
    }
    // Forward the reasoning choice only when the caller made one, so the bridge
    // keeps its own default otherwise.
    if let Some(enable_thinking) = req.enable_thinking {
        body["enable_thinking"] = json!(enable_thinking);
    }
    let api_key = local_qwen_api_key(req.api_key.as_deref());

    let mut request = http_client()?
        .post(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .json(&body)
        .timeout(BRIDGE_TIMEOUT);
    if let Some(run_id) = req.run_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        request = request.header("x-bridge-run-id", run_id);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                // The generic transport wording sends people looking for a
                // network fault. Past BRIDGE_TIMEOUT the bridge's own deadline
                // has already come and gone, and dropping this request tells
                // the bridge to cancel the run and kill the upstream task —
                // so nothing keeps billing. The bridge terminal is where the
                // upstream error is, not the connection.
                format!(
                    "qwen: the bridge did not answer within {}s. The run was cancelled and its \
                     upstream task killed — check the bridge terminal for the upstream error.",
                    BRIDGE_TIMEOUT.as_secs()
                )
            } else {
                format!("qwen: {}", transport_detail(&e))
            }
        })?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("qwen {}: {}", status, truncate(&explain(&text), 600)));
    }
    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("qwen: response was not JSON ({e})"))?;
    Ok(parse_local_qwen_response(&v))
}

/// Asks the bridge to stop a run. Deliberately forgiving: a run that already
/// finished, or a bridge too old to know the endpoint, both mean "there is
/// nothing left to stop", which is what the caller wanted.
#[tauri::command]
pub async fn cancel_local_qwen(req: LocalQwenCancelRequest) -> Result<bool, String> {
    crate::auth::require()?;
    let base = req.base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("Qwen base URL is empty.".into());
    }
    let run_id = req.run_id.trim();
    if run_id.is_empty() {
        return Err("Run id is empty.".into());
    }
    let api_key = local_qwen_api_key(req.api_key.as_deref());

    let resp = http_client()?
        .post(format!("{base}/cancel"))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("x-bridge-run-id", run_id)
        .json(&json!({ "id": run_id }))
        // A stop that itself hangs is worse than no stop at all.
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| format!("qwen cancel: {}", transport_detail(&e)))?;

    if resp.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("This bridge does not support stopping a run; update it.".into());
    }
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("qwen cancel {}: {}", status, truncate(&explain(&text), 300)));
    }
    Ok(serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| v["stopped"].as_bool())
        .unwrap_or(true))
}

fn parse_local_qwen_response(v: &Value) -> LocalQwenResponse {
    let message = &v["choices"][0]["message"];
    let content = message["content"].as_str().unwrap_or_default().to_string();
    // Different OpenAI-compatible servers name this differently; take whichever
    // one is present rather than binding to the bridge's current choice.
    let reasoning = message["reasoning_content"]
        .as_str()
        .or_else(|| message["reasoning"].as_str())
        .unwrap_or_default()
        .to_string();
    let tool_calls = message["tool_calls"]
        .as_array()
        .map(|calls| {
            calls
                .iter()
                .filter_map(|call| {
                    let function = &call["function"];
                    let name = function["name"].as_str()?.to_string();
                    let id = call["id"].as_str().unwrap_or("tool-call").to_string();
                    let raw_args = function["arguments"].as_str().unwrap_or("{}");
                    let arguments = serde_json::from_str(raw_args).unwrap_or_else(|_| json!({ "raw": raw_args }));
                    Some(LocalQwenToolCall { id, name, arguments })
                })
                .collect()
        })
        .unwrap_or_default();
    let w = &v["wiro"];
    let wiro = if w.is_object() {
        Some(WiroTurnInfo {
            task_id: w["taskId"].as_str().map(str::to_string),
            elapsed_seconds: w["elapsedSeconds"].as_f64(),
            total_cost: w["totalCost"].as_f64(),
        })
    } else {
        None
    };
    LocalQwenResponse { content, tool_calls, reasoning, wiro }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    run_id: String,
    agent_id: String,
    attempt_id: String,
    delta: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    run_id: String,
    agent_id: String,
    attempt_id: String,
    text: String,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    elapsed_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    run_id: String,
    agent_id: String,
    attempt_id: String,
    message: String,
}

// ------------------------------------------------------------------- commands

#[tauri::command]
pub async fn run_agent(
    app: AppHandle,
    registry: State<'_, RunRegistry>,
    req: RunRequest,
) -> Result<(), String> {
    let key = format!("{}::{}", req.run_id, req.agent_id);
    let token = registry.insert(key.clone(), req.attempt_id.clone());
    let registry = (*registry).clone();

    tauri::async_runtime::spawn(async move {
        let run_id = req.run_id.clone();
        let agent_id = req.agent_id.clone();
        let attempt_id = req.attempt_id.clone();
        let started = Instant::now();

        let result = execute(&app, &req, token).await;

        registry.finish(&key, &attempt_id);

        match result {
            Ok(Some((text, usage))) => {
                let _ = app.emit(
                    EV_DONE,
                    DonePayload {
                        run_id,
                        agent_id,
                        attempt_id,
                        text,
                        input_tokens: usage.0,
                        output_tokens: usage.1,
                        elapsed_ms: started.elapsed().as_millis() as u64,
                    },
                );
            }
            // None == cancelled; the UI already knows, stay quiet.
            Ok(None) => {}
            Err(message) => {
                let _ = app.emit(
                    EV_ERROR,
                    ErrorPayload { run_id, agent_id, attempt_id, message },
                );
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_run(registry: State<'_, RunRegistry>, run_id: String) {
    registry.cancel_prefix(&format!("{run_id}::"));
}

/// A one-shot judge call has no incremental output, so there is nothing on screen
/// to show it is alive and no cancel button wired to it. Bound it instead of
/// letting the UI sit on "Judging…" indefinitely.
const ONCE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

/// The coding bridge is not one model call: it runs a control loop of up to
/// eight sequential upstream turns behind a single HTTP request. Held to
/// ONCE_TIMEOUT it reliably loses the race, and the user is shown "operation
/// timed out" with no sign of what the run had actually done.
///
/// The bridge bounds itself with MAX_RUN_SECONDS and returns what it has, and
/// a client that disconnects makes it cancel the run and kill the upstream
/// task. This timeout sits above the bridge's configured run budget, so the
/// bridge's own explanation is what usually arrives — this is the backstop.
const BRIDGE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(1650);

/// One-shot, non-streaming call. Used by the consensus judge.
#[tauri::command]
pub async fn run_once(req: RunRequest) -> Result<String, String> {
    if req.endpoint.as_deref() == Some("responses") {
        return run_once_responses(&req).await;
    }

    let (url, headers, body) = build_request(&req, false)?;
    let client = http_client()?;
    let build = || {
        let mut rb = client.post(&url).json(&body).timeout(ONCE_TIMEOUT);
        for (k, v) in &headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        rb
    };
    let resp = send_governed(build, req.provider == GATEWAY)
        .await
        .map_err(|e| format!("{}: {}", req.provider, transport_detail(&e)))?;
    let status = resp.status();
    let text = resp
        .text()
        .await
        .map_err(|e| format!("{}: {e}", req.provider))?;
    if !status.is_success() {
        return Err(format!(
            "{} {}: {}",
            req.provider,
            status,
            truncate(&explain(&text), 600)
        ));
    }
    let v: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let out = extract_whole(&req.provider, &v);
    if out.trim().is_empty() {
        return Err(format!("{} returned an empty response.", req.provider));
    }
    Ok(out)
}

async fn run_once_responses(req: &RunRequest) -> Result<String, String> {
    let base = req
        .base_url
        .clone()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "https://api.tokenrouter.com/v1".into());
    let url = format!("{}/responses", base.trim_end_matches('/'));
    let key = secrets::read_api_key(&req.provider)?;
    let body = build_responses_body(req);
    let client = http_client()?;
    let build = || {
        client
            .post(&url)
            .header("Authorization", format!("Bearer {key}"))
            .json(&body)
            .timeout(ONCE_TIMEOUT)
    };
    let resp = send_governed(build, req.provider == GATEWAY)
        .await
        .map_err(|e| format!("{}: {}", req.provider, transport_detail(&e)))?;
    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{} {}: {}", req.provider, status, truncate(&explain(&body_text), 600)));
    }
    parse_responses_text(&req.provider, &body_text).map(|(text, _)| text)
}

// -------------------------------------------------------------------- runtime

type Usage = (Option<u64>, Option<u64>);

async fn execute(
    app: &AppHandle,
    req: &RunRequest,
    token: CancellationToken,
) -> Result<Option<(String, Usage)>, String> {
    let endpoint = req.endpoint.as_deref().unwrap_or("chat");
    if endpoint == "responses" {
        return execute_responses(app, req, &token).await;
    }

    let (url, headers, body) = build_request(req, true)?;
    let client = http_client()?;

    // Rebuilt per attempt: a RequestBuilder is consumed by `send`, and the
    // retry needs a fresh one rather than a clone of a spent request.
    let build = || {
        let mut rb = client.post(&url).json(&body);
        for (k, v) in &headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        rb
    };

    let resp = tokio::select! {
        _ = token.cancelled() => return Ok(None),
        r = send_governed(build, req.provider == GATEWAY) => {
            r.map_err(|e| format!("{}: {}", req.provider, transport_detail(&e)))?
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        // A "wrong wire" answer from the gateway is configuration, not model
        // failure: say which wire it wants, since the classifier downstream
        // keys on these words to offer the endpoint override.
        if body.contains("/v1/responses") || body.contains("v1/responses") {
            return Err(format!(
                "{}: this model is served on the Responses API (/v1/responses), not chat-completions. {}",
                req.provider,
                truncate(&explain(&body), 300)
            ));
        }
        return Err(format!("{} {}: {}", req.provider, status, truncate(&explain(&body), 600)));
    }

    let mut stream = resp.bytes_stream();
    // Buffered as bytes, not as a String. A chunk boundary can land in the middle
    // of a multi-byte character — common the moment a model emits an em dash, an
    // accent or a box-drawing glyph — and decoding each chunk on its own turns
    // that character into U+FFFD. Frames always end on an ASCII newline, so
    // decoding a whole frame is safe.
    let mut buffer: Vec<u8> = Vec::new();
    let mut full = String::new();
    let mut usage: Usage = (None, None);

    loop {
        let chunk = tokio::select! {
            _ = token.cancelled() => return Ok(None),
            c = stream.next() => c,
        };
        let Some(chunk) = chunk else { break };
        let chunk = chunk.map_err(|e| format!("{}: stream ended early ({e})", req.provider))?;
        buffer.extend_from_slice(&chunk);

        // SSE frames are separated by a blank line; hold back the trailing partial.
        while let Some(idx) = find_frame_end(&buffer) {
            let rest = buffer.split_off(idx);
            let frame = String::from_utf8_lossy(&buffer).into_owned();
            buffer = rest;
            let lead = buffer
                .iter()
                .take_while(|b| matches!(b, b'\r' | b'\n'))
                .count();
            buffer.drain(..lead);

            for line in frame.lines() {
                let Some(data) = line.strip_prefix("data:") else { continue };
                let data = data.trim();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<Value>(data) else { continue };

                // Providers can fail *inside* a 200 response (overloaded, content
                // filter, quota). Without this the stream just stops and the user
                // gets a blank pane with no reason for it.
                if let Some(msg) = stream_error(&v) {
                    return Err(format!("{}: {}", req.provider, truncate(&msg, 400)));
                }

                if let Some(u) = extract_usage(&req.provider, &v) {
                    if u.0.is_some() {
                        usage.0 = u.0;
                    }
                    if u.1.is_some() {
                        usage.1 = u.1;
                    }
                }

                let piece = extract_delta(&req.provider, &v);
                if !piece.is_empty() {
                    full.push_str(&piece);
                    let _ = app.emit(
                        EV_DELTA,
                        DeltaPayload {
                            run_id: req.run_id.clone(),
                            agent_id: req.agent_id.clone(),
                            attempt_id: req.attempt_id.clone(),
                            delta: piece,
                        },
                    );
                }
            }
        }
    }

    if full.trim().is_empty() {
        return Err(format!("{} returned an empty response.", req.provider));
    }
    Ok(Some((full, usage)))
}

fn find_frame_end(buf: &[u8]) -> Option<usize> {
    let find = |needle: &[u8]| buf.windows(needle.len()).position(|w| w == needle);
    match (find(b"\n\n"), find(b"\r\n\r\n")) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(a), None) => Some(a),
        (None, Some(b)) => Some(b),
        (None, None) => None,
    }
}

/// Executes against the OpenAI Responses API rather than chat-completions.
///
/// Codex lives here, and pretending it lives on the same wire as the rest is
/// what produced "empty 200" on chat-completions probes. The request shape is
/// different (instructions/input rather than messages), the response shape is
/// different (events or output[] rather than choices[]), and the endpoint is
/// different. Sharing an executor across shapes that differ is how a parser
/// quiet-swallows someone else's 200.
///
/// Buffered rather than streamed: TokenRouter forwards Responses in one
/// response body, and the pane's streaming UI is not worth contorting for a
/// single call that returns the whole answer at once. The caller still gets a
/// cancellation slot, so a Stop that lands mid-request cancels it.
async fn execute_responses(
    app: &AppHandle,
    req: &RunRequest,
    token: &CancellationToken,
) -> Result<Option<(String, Usage)>, String> {
    let base = req
        .base_url
        .clone()
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "https://api.tokenrouter.com/v1".into());
    let url = format!("{}/responses", base.trim_end_matches('/'));
    let key = secrets::read_api_key(&req.provider)?;
    let body = build_responses_body(req);

    let client = http_client()?;
    let build = || {
        client
            .post(&url)
            .header("Authorization", format!("Bearer {key}"))
            .json(&body)
    };

    let resp = tokio::select! {
        _ = token.cancelled() => return Ok(None),
        r = send_governed(build, req.provider == GATEWAY) => {
            r.map_err(|e| format!("{}: {}", req.provider, transport_detail(&e)))?
        }
    };

    let status = resp.status();
    let body_text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{} {}: {}", req.provider, status, truncate(&explain(&body_text), 600)));
    }

    let (out, usage) = parse_responses_text(&req.provider, &body_text)?;

    // Buffered: the whole answer arrives at once, but it still emits a delta so
    // the pane's pipeline updates the same way it does for a streamed reply.
    let _ = app.emit(
        EV_DELTA,
        DeltaPayload {
            run_id: req.run_id.clone(),
            agent_id: req.agent_id.clone(),
            attempt_id: req.attempt_id.clone(),
            delta: out.clone(),
        },
    );
    Ok(Some((out, usage)))
}

fn build_responses_body(req: &RunRequest) -> Value {
    // Input is a message whose content is a list of parts, and instructions
    // carries the system prompt. A bare top-level `input_text` item is not a
    // legal Responses item on TokenRouter; wrapping it as a user message keeps
    // text and images on the shape the endpoint accepts.
    let mut content = vec![json!({ "type": "input_text", "text": req.user_text })];
    for img in &req.images {
        content.push(json!({
            "type": "input_image",
            "image_url": format!("data:{};base64,{}", img.mime, img.data)
        }));
    }
    json!({
        "model": req.model,
        "instructions": req.system_prompt,
        "input": [{ "type": "message", "role": "user", "content": content }],
        "max_output_tokens": req.max_tokens,
        "temperature": req.temperature,
        "stream": false
    })
}

fn parse_responses_text(provider: &str, body_text: &str) -> Result<(String, Usage), String> {
    // The Responses API shape is output[] of typed blocks. Pull the text out of
    // whichever block carried it; a 200 with a different shape is reported like
    // any other 200 that lied about containing an answer.
    let v: Value = serde_json::from_str(body_text)
        .map_err(|e| format!("{provider}: response was not JSON ({e})"))?;

    let mut out = String::new();
    let mut usage: Usage = (None, None);
    if let Some(arr) = v["output"].as_array() {
        for item in arr {
            if item["type"] == "message" {
                if let Some(content) = item["content"].as_array() {
                    for part in content {
                        if part["type"] == "output_text" || part["type"] == "text" {
                            if let Some(t) = part["text"].as_str() {
                                out.push_str(t);
                            }
                        }
                    }
                }
            }
        }
    }
    // Usage can live at the top level or inside an output block. We accept both.
    if let Some(u) = v["usage"].as_object() {
        usage.0 = u.get("input_tokens").and_then(|x| x.as_u64());
        usage.1 = u.get("output_tokens").and_then(|x| x.as_u64());
    }

    if out.trim().is_empty() {
        return Err(format!("{provider}: responded, but the reply had no text content."));
    }
    Ok((out, usage))
}

/// A 24x24 solid red square, as PNG.
///
/// The smallest honest vision test there is. A model that can genuinely see the
/// attachment answers "red"; one that cannot either refuses, ignores the image
/// and guesses, or -- as observed through this gateway -- has its connection
/// dropped before it ever replies. 88 bytes, so testing costs nothing worth
/// counting.
const RED_SQUARE_PNG: &str = "iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR42mO4IydHFcQwatCoQaMGjRo0atCoQQNvEAD4u3YfaWxGoAAAAABJRU5ErkJggg==";

/// What one model did when we actually asked it something.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeResult {
    pub model: String,
    /// The only field the UI branches on: did a real request come back with text.
    pub ok: bool,
    pub ms: u64,
    /// Present when it failed, already rewritten into plain English.
    pub error: Option<String>,
    /// What it replied, trimmed. Proof rather than inference.
    pub reply: Option<String>,
    /// Whether it could actually read an attached image. None when not asked.
    pub vision: Option<bool>,
    /// Why the vision test came out the way it did.
    pub vision_note: Option<String>,
}

/// Tries each model with the smallest real request there is.
///
/// `GET /models` lists what a key is *entitled* to, which turns out not to be the
/// same question. A model can be listed and still refuse every request -- for
/// want of credit, for a regional restriction, because the upstream vendor is
/// down. The only way to know a model works is to use it, so this sends each one
/// a handful of tokens and reports what came back.
///
/// It costs real money, which is why it is a button and not something that
/// happens on startup. A few tokens across twenty models is a rounding error
/// against a single run of the panel, and it buys the difference between
/// configuring the app from a list and configuring it from evidence.
/// One probe result, emitted as it lands so the UI shows progress rather than
/// a frozen button until the last model answers.
pub const EV_PROBE: &str = "probe://result";

#[tauri::command]
pub async fn probe_models(
    app: AppHandle,
    models: Vec<String>,
    base_url: Option<String>,
    // Also send each model a tiny picture and see whether it can describe it.
    test_vision: Option<bool>,
    // Which wire each model speaks, if it is not the chat wire. A missing
    // entry is `chat`.
    endpoint_by_model: Option<std::collections::HashMap<String, String>>,
) -> Result<Vec<ProbeResult>, String> {
    let want_vision = test_vision.unwrap_or(false);
    let endpoint_by_model = endpoint_by_model.unwrap_or_default();
    let key = secrets::read_api_key("tokenrouter")?;
    let base = base_url
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "https://api.tokenrouter.com/v1".into());
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let responses_url = format!("{}/responses", base.trim_end_matches('/'));
    let client = http_client()?;

    // One at a time, through the governor. Sequentially, each probe finishes
    // before the next is admitted, and the badges flip one by one as the models
    // prove themselves.
    let mut out: Vec<ProbeResult> = Vec::with_capacity(models.len());

    for model in &models {
        let started = std::time::Instant::now();
        let endpoint = endpoint_by_model
            .get(model)
            .map(|s| s.as_str())
            .unwrap_or("chat");

        // Vision is asked separately from the text probe. On the responses
        // wire the image part is one of the inputs; on the chat wire it is one
        // of the messages. Only asked when the user chose it — the flag is a
        // RequestBudget question, not a curiosity.
        let vision = if want_vision {
            Some(probe_vision(&client, &url, &key, model).await)
        } else {
            None
        };

        // The prompt asks for the model's exact name: a reply that names it is
        // stronger evidence than a 200, and the name shows in the result so the
        // UI says what answered rather than merely that something did.
        //
        // max_tokens / max_output_tokens covers the whole response on both
        // surfaces — reasoning tokens included. A reasoning model asked for
        // its name can spend the whole budget thinking and return an empty
        // content field, which reads as "model broken" on a 200 when the probe
        // never gave it room to answer.
        let (body, target_url): (serde_json::Value, &str) = match endpoint {
            "responses" => (
                json!({
                    "model": model,
                    "instructions": "You are being probed to confirm this route is live.",
                    "input": [{
                        "type": "message",
                        "role": "user",
                        "content": [{ "type": "input_text", "text":
                            "Reply with your exact model name and nothing else." }]
                    }],
                    "max_output_tokens": 256,
                    "stream": false
                }),
                &responses_url,
            ),
            _ => (
                json!({
                    "model": model,
                    "messages": [{ "role": "user", "content":
                        "Reply with your exact model name and nothing else." }],
                    "max_tokens": 256,
                }),
                &url,
            ),
        };

        // Probes ride the governed path like every other gateway request.
        // send_governed's own retry-after handling is what turns a server-side
        // 429 into a wait rather than a failure.
        let url_c = target_url.to_string();
        let key_c = key.clone();
        let body_c = body.clone();
        let sent = send_governed(
            || client.post(&url_c).header("Authorization", format!("Bearer {key_c}")).json(&body_c),
            true,
        )
        .await;

        let ms = started.elapsed().as_millis() as u64;

        let result = match sent {
            Err(e) => ProbeResult {
                model: model.clone(),
                ok: false,
                ms,
                error: Some(format!("Could not reach the router: {}", transport_detail(&e))),
                reply: None,
                vision: vision.as_ref().map(|v| v.0),
                vision_note: vision.clone().map(|v| v.1),
            },
            Ok(resp) => {
                let status = resp.status();
                let text = resp.text().await.unwrap_or_default();
                if !status.is_success() {
                    ProbeResult {
                        model: model.clone(),
                        ok: false,
                        ms,
                        error: Some(truncate(&explain(&text), 300)),
                        reply: None,
                        vision: vision.as_ref().map(|v| v.0),
                        vision_note: vision.map(|v| v.1),
                    }
                } else {
                    // The two wires answer with different shapes. Chat has
                    // choices[0].message.content; Responses has output[] of typed
                    // blocks where the text sits in output_text parts. A 200 whose
                    // body matches neither is the routing-lie case.
                    let reply = if endpoint == "responses" {
                        serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|v| {
                                v["output"]
                                    .as_array()
                                    .map(|arr| {
                                        arr.iter()
                                            .filter(|item| item["type"] == "message")
                                            .filter_map(|item| item["content"].as_array())
                                            .flatten()
                                            .filter(|part| part["type"] == "output_text" || part["type"] == "text")
                                            .filter_map(|part| part["text"].as_str())
                                            .collect::<Vec<_>>()
                                            .join("")
                                    })
                                    .filter(|s| !s.is_empty())
                            })
                            .unwrap_or_default()
                    } else {
                        serde_json::from_str::<Value>(&text)
                            .ok()
                            .and_then(|v| {
                                v["choices"][0]["message"]["content"]
                                    .as_str()
                                    .map(|s| s.trim().to_string())
                            })
                            .unwrap_or_default()
                    };
                    let reply = reply.trim().to_string();

                    if reply.is_empty() {
                        ProbeResult {
                            model: model.clone(),
                            ok: false,
                            ms,
                            error: Some("Answered, but returned nothing at all.".into()),
                            reply: None,
                            vision: vision.as_ref().map(|v| v.0),
                            vision_note: vision.map(|v| v.1),
                        }
                    } else {
                        // Whether it said its own name is evidence, not a gate:
                        // plenty of healthy models fine-tuned off their base
                        // name will answer something else entirely, and that is
                        // still a live route.
                        let tail = model.rsplit('/').next().unwrap_or(model).to_lowercase();
                        let confirmed = reply.to_lowercase().contains(&tail);
                        ProbeResult {
                            model: model.clone(),
                            ok: true,
                            ms,
                            error: None,
                            reply: Some(if confirmed {
                                truncate(&reply, 80)
                            } else {
                                format!("replied \"{}\" (asked for {})", truncate(&reply, 60), model)
                            }),
                            vision: vision.as_ref().map(|v| v.0),
                            vision_note: vision.map(|v| v.1),
                        }
                    }
                }
            }
        };
        let _ = app.emit(EV_PROBE, &result);
        out.push(result);
    }

    Ok(out)
}

/// Shows one model a small red square and asks it what colour it is.
///
/// Three outcomes, and they mean different things. A reply containing "red" is
/// proof the whole route carries an image. A clean HTTP error is the model or the
/// gateway declining, with a reason worth reading. A dropped connection is what
/// this gateway appears to do when its OpenAI-compatible shim cannot translate an
/// `image_url` part for the backend behind it -- which is a property of the
/// route, not of the model, and is why Gemini can fail here while being natively
/// multimodal everywhere else.
async fn probe_vision(
    client: &reqwest::Client,
    url: &str,
    key: &str,
    model: &str,
) -> (bool, String) {
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": "What colour is this image? Reply with one word." },
                { "type": "image_url",
                  "image_url": { "url": format!("data:image/png;base64,{RED_SQUARE_PNG}") } }
            ]
        }],
        "max_tokens": 256,
    });

    let _ = admit_to_gateway().await;
    let sent = client
        .post(url)
        .header("Authorization", format!("Bearer {key}"))
        .json(&body)
        .timeout(std::time::Duration::from_secs(45))
        .send()
        .await;

    match sent {
        Err(e) => (false, format!("No image reply: {}", transport_detail(&e))),
        Ok(resp) => {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            if !status.is_success() {
                return (false, format!("{status}: {}", truncate(&explain(&text), 200)));
            }
            let reply = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| {
                    v["choices"][0]["message"]["content"]
                        .as_str()
                        .map(|s| s.trim().to_lowercase())
                })
                .unwrap_or_default();

            if reply.contains("red") {
                (true, format!("Read the test image correctly (\"{}\").", truncate(&reply, 40)))
            } else if reply.is_empty() {
                (false, "Accepted the image but replied with nothing.".into())
            } else {
                // It answered, but not with the right colour -- so it either could
                // not see the attachment or ignored it. Either way it must not be
                // trusted with a screenshot.
                (
                    false,
                    format!("Did not describe the image; said \"{}\".", truncate(&reply, 40)),
                )
            }
        }
    }
}

/// Asks the gateway what this key can actually reach.
///
/// The Settings fields for router model ids were free text with a hard-coded
/// datalist behind them, which quietly implied the app knew something it did not:
/// enabling a model on the router changed nothing here, because nothing ever
/// asked. OpenAI-compatible surfaces all expose `GET /v1/models`, and the answer
/// to that is the only authoritative list -- it reflects this key, this account
/// and today.
#[tauri::command]
pub async fn list_gateway_models(base_url: Option<String>) -> Result<Vec<String>, String> {
    let key = secrets::read_api_key("tokenrouter")?;
    let base = base_url
        .filter(|b| !b.trim().is_empty())
        .unwrap_or_else(|| "https://api.tokenrouter.com/v1".into());
    let url = format!("{}/models", base.trim_end_matches('/'));

    // The listing call also goes through the budget: before this it went out
    // immediately, so opening Settings on a fresh key cost one of five slots
    // the panes were about to need.
    let admitted = admit_to_gateway().await;
    let resp = http_client()?
        .get(&url)
        .header("Authorization", format!("Bearer {key}"))
        .send()
        .await
        .map_err(|e| format!("Could not reach {url}: {e}"))?;
    if resp.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        learn_from_429(admitted);
    }

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{status}: {}", truncate(&explain(&text), 400)));
    }

    let v: Value = serde_json::from_str(&text)
        .map_err(|e| format!("The model list came back in a shape we could not read: {e}"))?;

    // `{"data":[{"id":...}]}` is the OpenAI shape. A bare array, and a list of
    // plain strings, both turn up on compatible surfaces often enough to be worth
    // accepting rather than failing over.
    let rows = if v["data"].is_array() {
        v["data"].as_array().cloned().unwrap_or_default()
    } else if v.is_array() {
        v.as_array().cloned().unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut ids: Vec<String> = rows
        .iter()
        .filter_map(|r| {
            r.as_str()
                .map(|s| s.to_string())
                .or_else(|| r["id"].as_str().map(|s| s.to_string()))
        })
        .filter(|s| !s.trim().is_empty())
        .collect();

    ids.sort();
    ids.dedup();

    if ids.is_empty() {
        return Err("The router answered, but listed no models for this key.".into());
    }
    Ok(ids)
}

/// The real reason a request failed, not reqwest's summary of it.
///
/// `reqwest::Error` renders as "error sending request for url (...)" and keeps
/// everything useful in its source chain: whether the connection was refused,
/// reset, closed early, or timed out. Printing only the top of that chain tells
/// you a request failed and nothing whatsoever about why, which is exactly the
/// position two failing panes left us in.
fn transport_detail(e: &reqwest::Error) -> String {
    let mut parts = vec![e.to_string()];
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(inner) = src {
        let text = inner.to_string();
        // The chain repeats itself often enough to be worth filtering.
        if !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        src = std::error::Error::source(inner);
    }

    let joined = parts.join(" — ");
    let low = joined.to_lowercase();

    // The three that mean something a person can act on.
    if low.contains("connection closed") || low.contains("reset") || low.contains("broken pipe") {
        return format!(
            "{joined}\n\nThe router accepted the request and then dropped the connection.              That usually means it rejected the payload rather than the credentials — most              often a model that cannot take images being sent one."
        );
    }
    if low.contains("timed out") || low.contains("timeout") {
        return format!("{joined}\n\nNothing came back in time. Rerunning that pane often clears it.");
    }
    if low.contains("dns") || low.contains("resolve") {
        return format!("{joined}\n\nThe address did not resolve. Check the Base URL in Settings.");
    }
    joined
}

/// Sends a request, retrying once if the connection itself failed.
///
/// Only transport failures are retried, never HTTP statuses: a 403 means the
/// same thing the second time and asking again just spends money. A dropped
/// connection is different -- with four panes uploading images at once, one of
/// them losing its connection is common enough to be worth a second attempt
/// before reporting it as a failure.
async fn send_with_retry(
    build: impl Fn() -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, reqwest::Error> {
    match build().send().await {
        Ok(r) => Ok(r),
        Err(first) => {
            if first.is_status() {
                return Err(first);
            }
            tokio::time::sleep(std::time::Duration::from_millis(600)).await;
            build().send().await.map_err(|_| first)
        }
    }
}

// ------------------------------------------------------------ rate limiting

/// The gateway counts requests per minute, and this app makes a lot of them.
///
/// One run is six panes, a reader and a judge: eight requests, fired at once
/// because firing them at once is the entire point of a parallel panel. Against
/// a budget of five per minute that is not slow, it is *failed* -- three panes
/// come back `429 Too Many Requests` and the panel is missing three opinions for
/// no reason anybody can see.
///
/// Waiting is strictly better than failing. A pane that answers forty seconds
/// late is a pane that answered; a pane that 429s is a hole in the comparison.
/// So requests to the gateway queue here and go out at a legal pace instead of
/// racing each other into an error.
const RATE_WINDOW: std::time::Duration = std::time::Duration::from_secs(60);

/// The transport whose budget this is. Direct vendor calls have their own,
/// far larger, limits and must not be made to wait behind the gateway's.
const GATEWAY: &str = "tokenrouter";

struct Gate {
    /// When each still-counting request was admitted, oldest first.
    sent: tokio::sync::Mutex<std::collections::VecDeque<std::time::Instant>>,
    /// How many the window allows. Atomic because Settings can change it while
    /// requests are in flight, and because a 429 teaches us the real number.
    per_window: std::sync::atomic::AtomicUsize,
}

static GATE: std::sync::OnceLock<Gate> = std::sync::OnceLock::new();

fn gate() -> &'static Gate {
    GATE.get_or_init(|| Gate {
        sent: tokio::sync::Mutex::new(std::collections::VecDeque::new()),
        // Five is what the free tier allows, and being wrong low costs latency
        // while being wrong high costs failed panes.
        per_window: std::sync::atomic::AtomicUsize::new(5),
    })
}

/// Tells the governor how many requests a minute this key is allowed.
#[tauri::command]
pub fn set_gateway_rate(per_minute: u32) {
    gate()
        .per_window
        .store((per_minute.max(1)) as usize, std::sync::atomic::Ordering::Relaxed);
}

/// Waits until sending one more gateway request is within budget, and returns
/// how many requests the current window is already carrying.
///
/// The lock is taken to decide and released before sleeping, so a waiting task
/// never blocks the one whose slot is about to expire. Re-checked in a loop
/// rather than trusting the computed delay: several tasks can wake to the same
/// freed slot, and only one of them may have it.
async fn admit_to_gateway() -> usize {
    let gate = gate();
    loop {
        let max = gate
            .per_window
            .load(std::sync::atomic::Ordering::Relaxed)
            .max(1);
        let (wait, now_count) = {
            let mut q = gate.sent.lock().await;
            let now = std::time::Instant::now();
            while q
                .front()
                .is_some_and(|t| now.duration_since(*t) >= RATE_WINDOW)
            {
                q.pop_front();
            }
            if q.len() < max {
                q.push_back(now);
                (None, q.len())
            } else {
                // The oldest request is the one whose slot frees first. A little
                // past it rather than exactly on it: the gateway's clock is not
                // ours, and arriving a hair early is how you spend a retry.
                let oldest = *q.front().expect("full window has a front");
                (
                    Some(
                        RATE_WINDOW
                            .saturating_sub(now.duration_since(oldest))
                            .saturating_add(std::time::Duration::from_millis(250)),
                    ),
                    q.len(),
                )
            }
        };
        match wait {
            None => return now_count,
            Some(d) => tokio::time::sleep(d).await,
        }
    }
}

/// Believes a 429 over our own configuration.
///
/// The limit is a property of the key's plan, which the app cannot read and the
/// user should not have to look up. So when the gateway says we are over, the
/// budget drops to just under what was in flight and stays there. It only ever
/// ratchets down; raising it again is a deliberate act in Settings.
///
/// `served_now` is how many requests were admitted inside the current window
/// when the refusal landed. That is the server's own census: how many it
/// counted against the budget before saying no. Aligning to it is what fixes
/// "set to 10, server says 5, client never catches on" — the governor lowers
/// itself to the measured reality rather than insisting on the configured one.
fn learn_from_429(served_now: usize) {
    let gate = gate();
    let current = gate
        .per_window
        .load(std::sync::atomic::Ordering::Relaxed)
        .max(1);
    // Floor it at the number the server counted, capped by what we thought
    // anyway. Never raises on its own: raising back is a user action.
    let learned = served_now.min(current.saturating_sub(1)).max(1);
    if learned < current {
        gate.per_window
            .store(learned, std::sync::atomic::Ordering::Relaxed);
    }
}

/// How long a 429 asked us to wait. Prefers the server's own word; when it
/// says nothing, exponential with jitter is the shape that clears both
/// per-second and per-minute windows without a second process stampeding the
/// instant the first one wakes.
fn retry_after(resp: Option<&reqwest::Response>, attempt: u32) -> std::time::Duration {
    if let Some(r) = resp {
        if let Some(d) = r
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|s| *s <= 120)
            .map(std::time::Duration::from_secs)
        {
            return d;
        }
    }
    // attempt 0 => 2s, 1 => 4s, 2 => 8s, 3 => 16s, 4 => ~16s+jitter capped at
    // 30s, with up to a second of jitter so two queued requests do not wake
    // together.
    let base = std::time::Duration::from_secs(2u64.saturating_pow(attempt.min(4)));
    let jitter_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| (d.subsec_millis() % 1000) as u64)
        .unwrap_or(0);
    (base + std::time::Duration::from_millis(jitter_ms)).min(std::time::Duration::from_secs(30))
}

/// Sends through the gateway's budget, and waits out a 429 rather than reporting
/// it.
///
/// `is_gateway` is false for direct vendor calls, which then behave exactly as
/// they did before: no queue, no governor, no shared budget.
async fn send_governed(
    build: impl Fn() -> reqwest::RequestBuilder,
    is_gateway: bool,
) -> Result<reqwest::Response, reqwest::Error> {
    if !is_gateway {
        return send_with_retry(build).await;
    }

    // Five tries, so the odds that a window clears before we give up are high,
    // and the total worst-case wait is readable: ~1min on a 5/min plan. After
    // that the honest thing is still to show the user the 429 and let them
    // turn panes off rather than to keep a spinner going.
    for attempt in 0..5u32 {
        let admitted = admit_to_gateway().await;
        let resp = send_with_retry(&build).await?;
        if resp.status() != reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Ok(resp);
        }
        learn_from_429(admitted);
        if attempt == 4 {
            return Ok(resp);
        }
        tokio::time::sleep(retry_after(Some(&resp), attempt)).await;
        drop(resp);
    }
    unreachable!("the loop returns on its last iteration")
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(20))
        .user_agent(crate::deployment::USER_AGENT)
        // No overall timeout: reasoning models can think for minutes before the
        // first token arrives. Cancellation is user-driven instead.
        .build()
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------- request construction

fn build_request(
    req: &RunRequest,
    stream: bool,
) -> Result<(String, Vec<(String, String)>, Value), String> {
    let key = secrets::read_api_key(&req.provider)?;
    match req.provider.as_str() {
        "openai" | "moonshot" | "tokenrouter" => {
            let base = req.base_url.clone().unwrap_or_else(|| {
                match req.provider.as_str() {
                    "openai" => "https://api.openai.com/v1".into(),
                    "tokenrouter" => "https://api.tokenrouter.com/v1".into(),
                    _ => "https://api.moonshot.ai/v1".into(),
                }
            });
            let mut content = vec![json!({ "type": "text", "text": req.user_text })];
            for img in &req.images {
                content.push(json!({
                    "type": "image_url",
                    "image_url": { "url": format!("data:{};base64,{}", img.mime, img.data) }
                }));
            }
            let mut body = json!({
                "model": req.model,
                "messages": [
                    { "role": "system", "content": req.system_prompt },
                    { "role": "user", "content": content }
                ],
                "stream": stream
            });
            // OpenAI renamed the budget field for its reasoning models; Moonshot's
            // compatible surface still expects the original, and rejects unknown
            // keys. The gateway is grouped with Moonshot rather than OpenAI on
            // purpose: `max_completion_tokens` is specific to OpenAI's own API,
            // while `max_tokens` is the field every OpenAI-compatible surface
            // accepts, and an aggregator's whole job is to normalise for the
            // vendor behind it. Unconfirmed against their docs, which do not
            // publish this -- but a rejection names the offending field in the
            // response body, and that body is surfaced verbatim in the pane.
            if req.provider == "openai" {
                body["max_completion_tokens"] = json!(req.max_tokens);
            } else {
                body["max_tokens"] = json!(req.max_tokens);
            }
            // Both surfaces need this opt-in to report usage on a streamed call;
            // without it the token counters stay blank for the whole run.
            if stream {
                body["stream_options"] = json!({ "include_usage": true });
            }
            // Reasoning models reject an explicit temperature; only send it when
            // the caller asked for something other than the default.
            if req.temperature > 0.0 {
                body["temperature"] = json!(req.temperature);
            }
            Ok((
                format!("{}/chat/completions", base.trim_end_matches('/')),
                vec![("Authorization".into(), format!("Bearer {key}"))],
                body,
            ))
        }
        "anthropic" => {
            let base = req
                .base_url
                .clone()
                .unwrap_or_else(|| "https://api.anthropic.com/v1".into());
            let mut content = Vec::new();
            for img in &req.images {
                content.push(json!({
                    "type": "image",
                    "source": { "type": "base64", "media_type": img.mime, "data": img.data }
                }));
            }
            content.push(json!({ "type": "text", "text": req.user_text }));
            let body = json!({
                "model": req.model,
                "system": req.system_prompt,
                "messages": [{ "role": "user", "content": content }],
                "max_tokens": req.max_tokens,
                "stream": stream
            });
            Ok((
                format!("{}/messages", base.trim_end_matches('/')),
                vec![
                    ("x-api-key".into(), key),
                    ("anthropic-version".into(), "2023-06-01".into()),
                ],
                body,
            ))
        }
        "gemini" => {
            let base = req
                .base_url
                .clone()
                .unwrap_or_else(|| "https://generativelanguage.googleapis.com/v1beta".into());
            let mut parts = vec![json!({ "text": req.user_text })];
            for img in &req.images {
                parts.push(json!({
                    "inline_data": { "mime_type": img.mime, "data": img.data }
                }));
            }
            let body = json!({
                "system_instruction": { "parts": [{ "text": req.system_prompt }] },
                "contents": [{ "role": "user", "parts": parts }],
                "generationConfig": { "maxOutputTokens": req.max_tokens }
            });
            let verb = if stream {
                "streamGenerateContent?alt=sse"
            } else {
                "generateContent"
            };
            Ok((
                format!("{}/models/{}:{}", base.trim_end_matches('/'), req.model, verb),
                vec![("x-goog-api-key".into(), key)],
                body,
            ))
        }
        other => Err(format!("Unknown provider \"{other}\"")),
    }
}

// ------------------------------------------------------------ chunk extractors

/// Gemini returns its internal reasoning as ordinary `text` parts flagged with
/// `thought: true`. Collecting them indiscriminately dumps the model's scratchpad
/// into the answer, which also buries the FINAL block the parser is looking for.
fn gemini_text(v: &Value) -> String {
    v["candidates"][0]["content"]["parts"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p["thought"] != Value::Bool(true))
                .filter_map(|p| p["text"].as_str())
                .collect::<String>()
        })
        .unwrap_or_default()
}

fn extract_delta(provider: &str, v: &Value) -> String {
    match provider {
        "openai" | "moonshot" | "tokenrouter" => v["choices"][0]["delta"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        "anthropic" => {
            // `thinking_delta` events also arrive under `content_block_delta`, but
            // carry their payload in `thinking` rather than `text`.
            if v["type"] == "content_block_delta" && v["delta"]["type"] == "text_delta" {
                v["delta"]["text"].as_str().unwrap_or_default().to_string()
            } else {
                String::new()
            }
        }
        "gemini" => gemini_text(v),
        _ => String::new(),
    }
}

fn extract_whole(provider: &str, v: &Value) -> String {
    match provider {
        "openai" | "moonshot" | "tokenrouter" => v["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        "anthropic" => v["content"]
            .as_array()
            .map(|blocks| {
                blocks
                    .iter()
                    .filter(|b| b["type"] == "text")
                    .filter_map(|b| b["text"].as_str())
                    .collect::<String>()
            })
            .unwrap_or_default(),
        "gemini" => gemini_text(v),
        _ => String::new(),
    }
}

fn extract_usage(provider: &str, v: &Value) -> Option<Usage> {
    match provider {
        "openai" | "moonshot" | "tokenrouter" => {
            let u = &v["usage"];
            u.is_object()
                .then(|| (u["prompt_tokens"].as_u64(), u["completion_tokens"].as_u64()))
        }
        "anthropic" => match v["type"].as_str() {
            Some("message_start") => Some((
                v["message"]["usage"]["input_tokens"].as_u64(),
                v["message"]["usage"]["output_tokens"].as_u64(),
            )),
            Some("message_delta") => Some((None, v["usage"]["output_tokens"].as_u64())),
            _ => None,
        },
        "gemini" => {
            let u = &v["usageMetadata"];
            u.is_object().then(|| {
                (
                    u["promptTokenCount"].as_u64(),
                    u["candidatesTokenCount"].as_u64(),
                )
            })
        }
        _ => None,
    }
}

/// An error delivered as an SSE event rather than as an HTTP status.
fn stream_error(v: &Value) -> Option<String> {
    if v["type"] == "error" {
        // Anthropic
        return Some(
            v["error"]["message"]
                .as_str()
                .unwrap_or("the provider reported an error mid-stream")
                .to_string(),
        );
    }
    if v["error"].is_object() {
        // OpenAI-compatible and Gemini
        return Some(
            v["error"]["message"]
                .as_str()
                .unwrap_or("the provider reported an error mid-stream")
                .to_string(),
        );
    }
    None
}

/// Providers bury the useful part of an error in different places; surface it.
fn explain(body: &str) -> String {
    let raw = match serde_json::from_str::<Value>(body) {
        Ok(v) => {
            let mut found = body.to_string();
            for path in [&v["error"]["message"], &v["message"], &v["error"]] {
                if let Some(s) = path.as_str() {
                    found = s.to_string();
                    break;
                }
            }
            found
        }
        Err(_) => body.to_string(),
    };
    plain_english(&raw)
}

/// Rewrites the handful of failures that are about an account rather than about
/// the request.
///
/// These arrive as long vendor strings with a request id trailing off the end,
/// repeated once per pane, and they all mean one short thing the person can act
/// on. The original is kept on a second line: it carries the request id, which is
/// the only part support will ask for.
fn plain_english(raw: &str) -> String {
    let l = raw.to_lowercase();

    let headline = if l.contains("credit") && (l.contains("insufficient") || l.contains("limit")) {
        // Deliberately does not suggest "use a direct vendor key": half the panel
        // is router-only and has no such option, and a remedy that does not exist
        // is worse than none. The pane adds the advice that fits it.
        Some("This account is out of credit. Models listed as free still need a positive balance on the router.")
    } else if l.contains("quota") || l.contains("billing") || l.contains("payment") {
        Some("The account behind this key has no quota left, or its billing needs attention.")
    } else if l.contains("rate limit") || l.contains("too many requests") {
        Some("Rate limited. Waiting a moment and rerunning that pane usually clears it.")
    } else if l.contains("invalid api key")
        || l.contains("incorrect api key")
        || l.contains("unauthorized")
        || l.contains("authentication")
    {
        Some("That key was rejected. Check it in Settings -- and that it is the right one for this route.")
    } else if l.contains("model") && (l.contains("not found") || l.contains("does not exist")) {
        Some("That model id is not available on this key. Check the spelling, and that the model is enabled on your account.")
    } else {
        None
    };

    match headline {
        Some(h) => format!("{h}\n\n{raw}"),
        None => raw.to_string(),
    }
}

#[cfg(test)]
mod explain_tests {
    use super::*;

    #[test]
    fn a_credit_failure_leads_with_what_to_do() {
        let msg = plain_english(
            "User's credit limit is insufficient, remaining credit limit: $0.000000 (request id: 2026082415401)",
        );
        assert!(msg.starts_with("This account is out of credit"), "{msg}");
        // The request id is the only part support will ask for, so it survives.
        assert!(msg.contains("request id: 2026082415401"), "{msg}");
        // Must not prescribe a remedy half the panel cannot use: router-only
        // panes have no direct vendor key to fall back to.
        assert!(!msg.contains("direct vendor key"), "{msg}");
    }

    #[test]
    fn a_bad_key_is_not_confused_with_an_empty_wallet() {
        let msg = plain_english("Incorrect API key provided: sk-xxx");
        assert!(msg.contains("was rejected"), "{msg}");
        assert!(!msg.contains("out of credit"), "{msg}");
    }

    #[test]
    fn an_unrecognised_error_is_passed_through_untouched() {
        let raw = "something we have never seen";
        assert_eq!(plain_english(raw), raw);
    }

    #[test]
    fn the_json_message_is_unwrapped_before_being_classified() {
        let msg = explain(r#"{"error":{"message":"User's credit limit is insufficient"}}"#);
        assert!(msg.starts_with("This account is out of credit"), "{msg}");
    }

    #[test]
    fn responses_body_wraps_text_as_a_user_message() {
        let req = RunRequest {
            run_id: "run".into(),
            agent_id: "agent".into(),
            attempt_id: "attempt".into(),
            provider: "tokenrouter".into(),
            model: "openai/gpt-5.3-codex".into(),
            system_prompt: "system".into(),
            user_text: "hello".into(),
            images: vec![],
            max_tokens: 32,
            temperature: 0.0,
            base_url: None,
            endpoint: Some("responses".into()),
        };

        let body = build_responses_body(&req);
        assert_eq!(body["input"][0]["type"], "message");
        assert_eq!(body["input"][0]["role"], "user");
        assert_eq!(body["input"][0]["content"][0]["type"], "input_text");
        assert_eq!(body["input"][0]["content"][0]["text"], "hello");
    }

    #[test]
    fn responses_parser_reads_message_output_and_usage() {
        let raw = r#"{
          "output": [{
            "type": "message",
            "content": [{ "type": "output_text", "text": "OK" }]
          }],
          "usage": { "input_tokens": 3, "output_tokens": 2 }
        }"#;

        let (text, usage) = parse_responses_text("tokenrouter", raw).expect("response parses");
        assert_eq!(text, "OK");
        assert_eq!(usage, (Some(3), Some(2)));
    }
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(n).collect::<String>())
    }
}

# qwen/qwen3-8-27b-uncensored Integration

**Model Overview:** Qwen3.8-27B-Uncensored is a 27-billion-parameter chat LLM (a refusal-reduced variant of Qwen3.8-27B) designed for long-context text tasks. It generates an assistant-style text completion from a user prompt (with an optional “thinking” reasoning block). By default **thinking** is enabled (`enableThinking=true`) to produce deeper reasoning, but it can be toggled off for shorter answers. The model supports up to a 262,144‑token context window, so the total length of your prompt plus expected output must fit under that limit. (It is a text-first model; any image/video input requires a separate multimodal path.)

**Endpoints:** Use Wiro’s unified `/v1/Run` API for this model. In particular:

- **Asynchronous Run:** `POST /v1/Run/qwen/qwen3-8-27b-uncensored`  
  Starts an inference task. The request body is JSON with model-specific parameters (see below). The response returns immediately with a JSON envelope containing a `taskid` and a `socketaccesstoken` for progress tracking. Example:  
  ```json
  {
    "result": true,
    "errors": [],
    "taskid": "12345",
    "socketaccesstoken": "abcde...xyz"
  }
  ```  
  (This follows Wiro’s standard Run response format.)  

- **Check Status:** `POST /v1/Task/Detail`  
  Poll or fetch task status/output by sending the `taskid` or `tasktoken`. The response JSON contains the current state. Once the task completes, the output text is found under `data.tasklist[0].outputs[0].content.segments` (an array of text segments) and a `finishreason` (e.g. `"stop"`). For example, a completed response might look like:  
  ```json
  {
    "result": true,
    "errors": [],
    "data": {
      "tasklist": [{
        "outputs": [{
          "content": {
            "segments": [{ "type": "text", "text": "The Second Law of Thermodynamics..." }],
            "finishreason": "stop"
          }
        }],
        "pexit": "0"
      }]
    }
  }
  ```  
  (Details in **Response Structure** below.) You may use either polling (`/Task/Detail`) or Wiro’s WebSocket/SSE for real-time updates; see [Tasks](https://wiro.ai/docs/tasks).  

- **Synchronous Run (/sync):** `POST /v1/Run/qwen/qwen3-8-27b-uncensored/sync`  
  For convenience, you can use the `/sync` variant to run the task and wait for completion on the same HTTP call. This is only for *finite* models like this chat model. By default it will block until done and return the final JSON (similar to polling **Task/Detail**), or you can stream partial outputs. For example:  
  - **JSON output:**  
    ```
    POST /v1/Run/qwen/qwen3-8-27b-uncensored/sync
    Content-Type: application/json

    {
      "prompt": "Explain the Second Law of Thermodynamics …",
      "enableThinking": true,
      "temperature": 1.0,
      "top_p": 0.95
    }
    ```  
    This request will return (after the model finishes) a Wiro JSON envelope containing the full `tasklist` with output segments, as shown above. (Internally it runs the same billed task as the async call.)  
  - **Streaming output:**  
    ```
    POST /v1/Run/qwen/qwen3-8-27b-uncensored/sync?stream=true
    Content-Type: application/json
    Accept: text/event-stream

    { "prompt": "Hello, how are you?", "enableThinking": false }
    ```  
    Using `?stream=true` returns a Server-Sent-Events stream of partial outputs (each event with updated `segments`) until completion. (After completion, the SSE stream ends. If the HTTP timeout occurs, a 504 with the `taskid` is returned so you can resume via **Task/Detail** or WebSocket.)  

For reference, Wiro’s docs note that `/v1/Run/{owner}/{model}` is always asynchronous, while `/sync` is a generic finite-model wait on the same host. (This model has no separate OpenAI/Anthropic gateway route, so you must use the Wiro endpoints above.)

**Parameters:** The `/v1/Run` and `/v1/Run/.../sync` endpoints accept a JSON object of model parameters. Key parameters include:  

- `prompt` (string, **required**): The user’s query or instruction text (chat history or instruction). For chat use cases, simply include the full prompt text. (Send either `prompt` or `messages`, but here we use `prompt`.) Example: `"prompt": "How does entropy relate to information theory?"`.  
- `enableThinking` (boolean, default `true`): Toggle reasoning mode. If `true`, the model may prepend a “Thinking:” block before the final answer; if `false`, it answers directly.  
- `user_id`, `session_id` (string, optional): Identifiers to track user/session for conversation context. E.g. `"user_id": "alice", "session_id": "session123"`.  
- `temperature` (number, default 1.0): Sampling temperature. Higher values (up to 1) increase randomness.  
- `top_p` (number, default 0.95): Top‑p (nucleus) sampling cutoff.  
- `top_k` (integer, default 20): Top‑k sampling limit.  
- *Stop sequences:* A semicolon-separated list of stop phrases (e.g. `"stop_sequences": "###;END"`). Generation halts when one is encountered.  
- *Length limits:* You can set `min_output_tokens` and `max_output_tokens` to constrain output length. (By default the model may stop early.) These correspond to the “minimum and maximum output token limits” mentioned in the docs.  
- *Additional options:* `seed` (integer for deterministic sampling), `sampling` (toggle on/off), and a `quantize` flag (boolean, to trade quality for lower memory) may also be supported. (The model page mentions optional “quantization” and “sampling” toggles.)  

_Example request payload (JSON):_  
```json
{
  "prompt": "Explain the Second Law of Thermodynamics ...",
  "user_id": "user42",
  "session_id": "session123",
  "enableThinking": true,
  "temperature": 1.0,
  "top_p": 0.95,
  "top_k": 20,
  "stop_sequences": "END"
}
```  
(This mirrors the Quickstart snippet on the model page.)

**Response Structure:** When you poll **Task/Detail** or complete a **/sync** call, the final output is found in the Wiro response under `data.tasklist[0].outputs[0].content.segments`. Each segment is an ordered piece of the assistant’s reply (and possibly reasoning). In practice you can concatenate all `"text"` segments. The JSON also includes metadata fields: e.g. `"finishreason"` indicates why generation stopped (`"stop"`, `"length"`, etc.), and `usage` fields with token counts. A successful task has `"pexit": "0"`. (This follows Wiro’s normal task model: see for example run response and for how final output appears in `/sync` and Task Detail.) The model returns a single UTF-8 text response (with an optional reasoning block if enabled).

**Example:** An asynchronous run might look like:  
```
POST /v1/Run/qwen/qwen3-8-27b-uncensored
Content-Type: application/json

{ "prompt": "Hello, who won the world series in 2020?", "enableThinking": false }
```  
Response:  
```json
{ "result": true, "errors": [], "taskid": "67890", "socketaccesstoken": "..." }
```  
Then poll:  
```
POST /v1/Task/Detail
Content-Type: application/json

{ "taskid": "67890" }
```  
The response (after completion) will contain the answer in `data.tasklist[0].outputs[0].content.segments[...].text`. Using the synchronous endpoint:  
```
POST /v1/Run/qwen/qwen3-8-27b-uncensored/sync
{ "prompt": "Hello, who won the world series in 2020?", "enableThinking": false }
```  
would directly return the completed JSON (with `tasklist[0].outputs[0].content.segments`) in one call.

**Limitations & Notes:** This model is *not* offered through a direct OpenAI-style chat/completion gateway; use only the Wiro `/v1/Run` APIs described above. It does *not* support image or audio input on this route (see note on multimodal inputs). Its “uncensored” label means refusals are reduced but not eliminated. Be sure to keep prompt+answer under the 262,144 token limit. No additional tools, embeddings, or generation modes are provided beyond the standard text run. For streaming output, the `/sync?stream=true` method will emit standard Wiro task SSE events until completion. All other Wiro features (WebSocket updates, callbacks, etc.) apply as usual to this model’s tasks.

**Sources:** Model details from Wiro’s documentation and model page. Endpoint behavior from Wiro API docs.
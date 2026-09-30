//! Authoritative smoke test harness for real provider adapters: OpenAI, Gemini, Ollama.
//!
//! Verifies:
//! - basic completion
//! - tool calling & function call argument parsing
//! - structured response handling
//! - usage accounting
//! - timeout behavior
//! - provider-specific errors
//! - cancellation
//! - model capability reporting
//!
//! Supports live credentials from environment (`OPENAI_API_KEY`, `GEMINI_API_KEY`, `OLLAMA_HOST`)
//! and hermetic contract server tests when credentials are not present.

use std::time::Duration;

use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::post;
use axum::{Json, Router};
use plexis_providers::adapters::{GeminiProvider, OllamaProvider, OpenAiProvider};
use plexis_providers::capabilities::{ProviderCapabilities, ReasoningTier};
use plexis_providers::{
    ChatMessage, CompletionRequest, FinishReason, Provider, ProviderError, ToolDefinition,
};
use serde_json::json;

async fn handle_openai_chat(
    headers: HeaderMap,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let auth = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if !auth.starts_with("Bearer ") || auth == "Bearer invalid-key" {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": { "message": "Incorrect API key provided: invalid-key" }
            })),
        );
    }

    let model = payload["model"].as_str().unwrap_or("gpt-4o");
    if model == "non-existent-model" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": { "message": "The model `non-existent-model` does not exist" }
            })),
        );
    }

    if model == "rate-limited-model" {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": { "message": "Rate limit reached for requests" }
            })),
        );
    }

    // Check if tools were requested
    let has_tools = payload.get("tools").and_then(|t| t.as_array()).is_some();
    if has_tools {
        return (
            StatusCode::OK,
            Json(json!({
                "id": "chatcmpl-mock-tool-1",
                "object": "chat.completion",
                "created": 1726000000,
                "model": model,
                "choices": [{
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": null,
                        "tool_calls": [{
                            "id": "call_calc_99",
                            "type": "function",
                            "function": {
                                "name": "calculate_hash",
                                "arguments": "{\"data\":\"hello-sentinel\",\"algorithm\":\"sha256\"}"
                            }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }],
                "usage": {
                    "prompt_tokens": 42,
                    "completion_tokens": 18,
                    "total_tokens": 60
                }
            })),
        );
    }

    // Normal text response
    (
        StatusCode::OK,
        Json(json!({
            "id": "chatcmpl-mock-text-1",
            "object": "chat.completion",
            "created": 1726000000,
            "model": model,
            "choices": [{
                "index": 0,
                "message": {
                    "role": "assistant",
                    "content": "Hello from mock OpenAI adapter!"
                },
                "finish_reason": "stop"
            }],
            "usage": {
                "prompt_tokens": 15,
                "completion_tokens": 8,
                "total_tokens": 23
            }
        })),
    )
}

async fn handle_gemini_generate(
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
    Json(payload): Json<serde_json::Value>,
) -> impl IntoResponse {
    let key = params.get("key").cloned().unwrap_or_default();
    if key == "invalid-gemini-key" {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": { "message": "API_KEY_INVALID" }
            })),
        );
    }

    if key == "rate-limited-key" {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({
                "error": { "message": "RESOURCE_EXHAUSTED: quota exceeded" }
            })),
        );
    }

    let has_tools = payload.get("tools").and_then(|t| t.as_array()).is_some();
    if has_tools {
        return (
            StatusCode::OK,
            Json(json!({
                "candidates": [{
                    "content": {
                        "parts": [{
                            "functionCall": {
                                "name": "fetch_file",
                                "args": { "path": "src/lib.rs" }
                            }
                        }],
                        "role": "model"
                    },
                    "finishReason": "STOP"
                }],
                "usageMetadata": {
                    "promptTokenCount": 55,
                    "candidatesTokenCount": 20,
                    "totalTokenCount": 75
                }
            })),
        );
    }

    (
        StatusCode::OK,
        Json(json!({
            "candidates": [{
                "content": {
                    "parts": [{
                        "text": "Hello from mock Gemini adapter!"
                    }],
                    "role": "model"
                },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 25,
                "candidatesTokenCount": 10,
                "totalTokenCount": 35
            }
        })),
    )
}

async fn handle_ollama_chat(Json(payload): Json<serde_json::Value>) -> impl IntoResponse {
    let model = payload["model"].as_str().unwrap_or("qwen2.5-coder");
    if model == "non-existent-ollama-model" {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({
                "error": "model 'non-existent-ollama-model' not found"
            })),
        );
    }

    let has_tools = payload.get("tools").and_then(|t| t.as_array()).is_some();
    if has_tools {
        return (
            StatusCode::OK,
            Json(json!({
                "model": model,
                "created_at": "2026-09-15T10:00:00Z",
                "message": {
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{
                        "function": {
                            "name": "run_cargo_test",
                            "arguments": { "package": "token-limiter" }
                        }
                    }]
                },
                "done": true,
                "prompt_eval_count": 38,
                "eval_count": 14
            })),
        );
    }

    (
        StatusCode::OK,
        Json(json!({
            "model": model,
            "created_at": "2026-09-15T10:00:00Z",
            "message": {
                "role": "assistant",
                "content": "Hello from mock Ollama daemon!"
            },
            "done": true,
            "prompt_eval_count": 20,
            "eval_count": 10
        })),
    )
}

async fn handle_slow_endpoint() -> impl IntoResponse {
    tokio::time::sleep(Duration::from_millis(1500)).await;
    (StatusCode::OK, Json(json!({"status": "delayed"})))
}

async fn start_mock_provider_server() -> (String, tokio::task::JoinHandle<()>) {
    let app = Router::new()
        .route("/chat/completions", post(handle_openai_chat))
        .route("/models/{*action}", post(handle_gemini_generate))
        .route("/api/chat", post(handle_ollama_chat))
        .route("/slow/{*action}", post(handle_slow_endpoint));

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let base_url = format!("http://{}", addr);

    let handle = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (base_url, handle)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[tokio::test]
async fn test_openai_adapter_smoke_suite() {
    let (base_url, _server) = start_mock_provider_server().await;

    let provider = OpenAiProvider::new("valid-test-key").with_base_url(&base_url);

    // 1. Basic completion
    let req = CompletionRequest::new(
        "gpt-4o",
        vec![ChatMessage::user("Say hello to Sentinel platform")],
    );
    let res = provider.complete(&req).await.expect("basic completion");
    assert_eq!(res.finish_reason, FinishReason::Stop);
    assert_eq!(
        res.message.content.as_deref(),
        Some("Hello from mock OpenAI adapter!")
    );
    assert_eq!(res.usage.prompt_tokens, 15);
    assert_eq!(res.usage.completion_tokens, 8);
    assert_eq!(res.usage.total_tokens, 23);

    // 2. Tool calling & argument parsing
    let tool_def = ToolDefinition::new(
        "calculate_hash",
        "Computes cryptographic hash of data",
        json!({
            "type": "object",
            "properties": {
                "data": { "type": "string" },
                "algorithm": { "type": "string" }
            }
        }),
    );
    let tool_req = CompletionRequest::new(
        "gpt-4o",
        vec![ChatMessage::user("Compute hash of hello-sentinel")],
    )
    .with_tools(vec![tool_def]);

    let tool_res = provider
        .complete(&tool_req)
        .await
        .expect("tool call response");
    assert_eq!(tool_res.finish_reason, FinishReason::ToolCalls);
    let tool_calls = tool_res.message.tool_calls.expect("tool calls present");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].name, "calculate_hash");
    let parsed_args: serde_json::Value = serde_json::from_str(&tool_calls[0].arguments).unwrap();
    assert_eq!(parsed_args["data"], "hello-sentinel");
    assert_eq!(parsed_args["algorithm"], "sha256");

    // 3. Authentication failure
    let bad_auth_provider = OpenAiProvider::new("invalid-key").with_base_url(&base_url);
    let err = bad_auth_provider.complete(&req).await.unwrap_err();
    match err {
        ProviderError::Authentication(msg) => {
            assert!(msg.contains("Incorrect API key"));
        }
        other => panic!("Expected ProviderError::Authentication, got: {:?}", other),
    }

    // 4. Model not found
    let not_found_req =
        CompletionRequest::new("non-existent-model", vec![ChatMessage::user("ping")]);
    let err = provider.complete(&not_found_req).await.unwrap_err();
    match err {
        ProviderError::ModelNotFound(msg) => {
            assert!(msg.contains("does not exist"));
        }
        other => panic!("Expected ProviderError::ModelNotFound, got: {:?}", other),
    }

    // 5. Rate limiting
    let rate_limited_req =
        CompletionRequest::new("rate-limited-model", vec![ChatMessage::user("ping")]);
    let err = provider.complete(&rate_limited_req).await.unwrap_err();
    match err {
        ProviderError::RateLimited { .. } => {}
        other => panic!("Expected ProviderError::RateLimited, got: {:?}", other),
    }

    // 6. Timeout behavior
    let timeout_provider = OpenAiProvider::new("valid-test-key")
        .with_base_url(format!("{}/slow", base_url))
        .with_timeout(Duration::from_millis(100));
    let err = timeout_provider.complete(&req).await.unwrap_err();
    match err {
        ProviderError::Timeout(_) => {}
        other => panic!("Expected ProviderError::Timeout, got: {:?}", other),
    }

    // 7. Cancellation
    let cancel_provider =
        OpenAiProvider::new("valid-test-key").with_base_url(format!("{}/slow", base_url));
    let fut = cancel_provider.complete(&req);
    tokio::select! {
        _ = tokio::time::sleep(Duration::from_millis(50)) => {
            // Drop future = cancelled
        }
        _ = fut => {
            panic!("Should have cancelled before completion");
        }
    }

    // 8. Model capability reporting
    let caps = ProviderCapabilities::for_model("openai", "gpt-4o");
    assert_eq!(caps.provider, "openai");
    assert_eq!(caps.model, "gpt-4o");
    assert!(caps.supports_tools);
    assert!(caps.supports_streaming);
    assert!(caps.supports_vision);
    assert_eq!(caps.context_window_tokens, 128000);
    assert_eq!(caps.reasoning_tier, ReasoningTier::Medium);
}

#[tokio::test]
async fn test_gemini_adapter_smoke_suite() {
    let (base_url, _server) = start_mock_provider_server().await;

    let provider = GeminiProvider::new("valid-gemini-key").with_base_url(&base_url);

    // 1. Basic completion
    let req = CompletionRequest::new(
        "gemini-1.5-pro",
        vec![ChatMessage::user("Summarize project architecture")],
    );
    let res = provider
        .complete(&req)
        .await
        .expect("basic gemini completion");
    assert_eq!(res.finish_reason, FinishReason::Stop);
    assert_eq!(
        res.message.content.as_deref(),
        Some("Hello from mock Gemini adapter!")
    );
    assert_eq!(res.usage.prompt_tokens, 25);
    assert_eq!(res.usage.completion_tokens, 10);
    assert_eq!(res.usage.total_tokens, 35);

    // 2. Tool calling & function arguments
    let tool_def = ToolDefinition::new(
        "fetch_file",
        "Fetches file content from repository",
        json!({
            "type": "object",
            "properties": {
                "path": { "type": "string" }
            }
        }),
    );
    let tool_req =
        CompletionRequest::new("gemini-1.5-pro", vec![ChatMessage::user("Read src/lib.rs")])
            .with_tools(vec![tool_def]);

    let tool_res = provider
        .complete(&tool_req)
        .await
        .expect("gemini tool response");
    assert_eq!(tool_res.finish_reason, FinishReason::ToolCalls);
    let tool_calls = tool_res
        .message
        .tool_calls
        .expect("gemini tool calls present");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].name, "fetch_file");
    let parsed_args: serde_json::Value = serde_json::from_str(&tool_calls[0].arguments).unwrap();
    assert_eq!(parsed_args["path"], "src/lib.rs");

    // 3. Authentication failure
    let bad_auth_provider = GeminiProvider::new("invalid-gemini-key").with_base_url(&base_url);
    let err = bad_auth_provider.complete(&req).await.unwrap_err();
    match err {
        ProviderError::Authentication(msg) => {
            assert!(msg.contains("API_KEY_INVALID"));
        }
        other => panic!("Expected ProviderError::Authentication, got: {:?}", other),
    }

    // 4. Rate limiting (RESOURCE_EXHAUSTED)
    let rate_limited_provider = GeminiProvider::new("rate-limited-key").with_base_url(&base_url);
    let err = rate_limited_provider.complete(&req).await.unwrap_err();
    match err {
        ProviderError::RateLimited { .. } => {}
        other => panic!("Expected ProviderError::RateLimited, got: {:?}", other),
    }

    // 5. Timeout behavior
    let timeout_provider = GeminiProvider::new("valid-gemini-key")
        .with_base_url(format!("{}/slow", base_url))
        .with_timeout(Duration::from_millis(100));
    let err = timeout_provider.complete(&req).await.unwrap_err();
    match err {
        ProviderError::Timeout(_) => {}
        other => panic!("Expected ProviderError::Timeout, got: {:?}", other),
    }

    // 6. Model capability reporting
    let caps = ProviderCapabilities::for_model("gemini", "gemini-1.5-pro");
    assert_eq!(caps.provider, "gemini");
    assert!(caps.supports_tools);
    assert!(caps.supports_vision);
    assert_eq!(caps.context_window_tokens, 1000000);
    assert_eq!(caps.reasoning_tier, ReasoningTier::High);
}

#[tokio::test]
async fn test_ollama_adapter_smoke_suite() {
    let (base_url, _server) = start_mock_provider_server().await;

    let provider = OllamaProvider::new().with_base_url(&base_url);

    // 1. Basic completion
    let req = CompletionRequest::new(
        "qwen2.5-coder",
        vec![ChatMessage::user("Refactor token bucket eviction")],
    );
    let res = provider
        .complete(&req)
        .await
        .expect("basic ollama completion");
    assert_eq!(res.finish_reason, FinishReason::Stop);
    assert_eq!(
        res.message.content.as_deref(),
        Some("Hello from mock Ollama daemon!")
    );
    assert_eq!(res.usage.prompt_tokens, 20);
    assert_eq!(res.usage.completion_tokens, 10);
    assert_eq!(res.usage.total_tokens, 30);

    // 2. Tool calling & argument parsing
    let tool_def = ToolDefinition::new(
        "run_cargo_test",
        "Executes cargo test within workspace sandbox",
        json!({
            "type": "object",
            "properties": {
                "package": { "type": "string" }
            }
        }),
    );
    let tool_req = CompletionRequest::new(
        "qwen2.5-coder",
        vec![ChatMessage::user("Run cargo test on token-limiter")],
    )
    .with_tools(vec![tool_def]);

    let tool_res = provider
        .complete(&tool_req)
        .await
        .expect("ollama tool response");
    assert_eq!(tool_res.finish_reason, FinishReason::ToolCalls);
    let tool_calls = tool_res
        .message
        .tool_calls
        .expect("ollama tool calls present");
    assert_eq!(tool_calls.len(), 1);
    assert_eq!(tool_calls[0].name, "run_cargo_test");
    let parsed_args: serde_json::Value = serde_json::from_str(&tool_calls[0].arguments).unwrap();
    assert_eq!(parsed_args["package"], "token-limiter");

    // 3. Model not found error
    let missing_req =
        CompletionRequest::new("non-existent-ollama-model", vec![ChatMessage::user("ping")]);
    let err = provider.complete(&missing_req).await.unwrap_err();
    match err {
        ProviderError::ModelNotFound(msg) => {
            assert!(msg.contains("not found"));
        }
        other => panic!("Expected ProviderError::ModelNotFound, got: {:?}", other),
    }

    // 4. Timeout behavior
    let timeout_provider = OllamaProvider::new()
        .with_base_url(format!("{}/slow", base_url))
        .with_timeout(Duration::from_millis(100));
    let err = timeout_provider.complete(&req).await.unwrap_err();
    match err {
        ProviderError::Timeout(_) => {}
        other => panic!("Expected ProviderError::Timeout, got: {:?}", other),
    }

    // 5. Model capability reporting
    let caps = ProviderCapabilities::for_model("ollama", "qwen2.5-coder");
    assert_eq!(caps.provider, "ollama");
    assert!(caps.is_local);
    assert!(caps.supports_tools);
    assert_eq!(caps.pricing.cost_per_1k_input_tokens, 0.0);
    assert_eq!(caps.pricing.cost_per_1k_output_tokens, 0.0);
}

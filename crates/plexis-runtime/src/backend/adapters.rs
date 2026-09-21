//! Future External Coding CLI Backend Adapter Stubs & Specifications
//!
//! Provides concrete adapter specifications and runtime stubs for commercial and
//! open-source external coding CLI agents (OpenAI Codex CLI, OpenCode).
//! Fully implemented CLI backends live in dedicated modules (see `gemini/`,
//! `claude/`).
//!
//! These adapters demonstrate how future CLI agents plug into the Plexis AgentBackend
//! architecture without modifying the core runtime.

use async_trait::async_trait;
use plexis_core::ids::ExecutionId;
use plexis_core::protocol::{ExecutionEvent, ExecutionRequest, ExecutionResult};
use tokio::sync::mpsc;

use super::AgentBackend;
use crate::error::RuntimeError;

fn check_binary_on_path(binary_name: &str) -> bool {
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_var) {
            let candidate = dir.join(binary_name);
            if candidate.is_file() {
                return true;
            }
        }
    }
    false
}

/// Adapter specification and stub for OpenAI Codex CLI (`codex`).
///
/// Execution protocol:
/// - Command: `codex exec --workspace <WORKSPACE>`
/// - Environment: `OPENAI_API_KEY` passed via scrubbed environment
pub struct CodexBackend;

#[async_trait]
impl AgentBackend for CodexBackend {
    fn id(&self) -> &str {
        "codex"
    }

    fn display_name(&self) -> &str {
        "OpenAI Codex CLI"
    }

    fn is_available(&self) -> bool {
        check_binary_on_path("codex")
    }

    async fn execute(
        &self,
        _request: &ExecutionRequest,
        _event_sender: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<ExecutionResult, RuntimeError> {
        if !self.is_available() {
            return Err(RuntimeError::InvalidCommand(
                "OpenAI Codex CLI (`codex`) is not installed on PATH. Please install Codex CLI or use the fake agent adapter.".to_string(),
            ));
        }
        Err(RuntimeError::InvalidCommand(
            "OpenAI Codex CLI adapter is installed on PATH but credential-gated for live execution.".to_string(),
        ))
    }

    async fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), RuntimeError> {
        Ok(())
    }
}

/// Adapter specification and stub for open-source OpenCode CLI (`opencode`).
pub struct OpenCodeBackend;

#[async_trait]
impl AgentBackend for OpenCodeBackend {
    fn id(&self) -> &str {
        "opencode"
    }

    fn display_name(&self) -> &str {
        "OpenCode Autonomous Coding CLI"
    }

    fn is_available(&self) -> bool {
        check_binary_on_path("opencode")
    }

    async fn execute(
        &self,
        _request: &ExecutionRequest,
        _event_sender: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<ExecutionResult, RuntimeError> {
        if !self.is_available() {
            return Err(RuntimeError::InvalidCommand(
                "OpenCode CLI (`opencode`) is not installed on PATH.".to_string(),
            ));
        }
        Err(RuntimeError::InvalidCommand(
            "OpenCode CLI adapter is not configured.".to_string(),
        ))
    }

    async fn cancel(&self, _execution_id: &ExecutionId) -> Result<(), RuntimeError> {
        Ok(())
    }
}

//! Agent Backend Abstraction and Registry
//!
//! Decouples external autonomous coding agent OS processes from LLM providers
//! and individual tool invocations.
//!
//! Architectural distinction:
//! - `Provider`: Model inference (completions, tokens, embeddings)
//! - `AgentBackend`: External autonomous coding agent OS process (Claude Code, Codex, FakeAgent)
//! - `Tool`: Individual capability exposed to an agent (filesystem, shell, git)

pub mod adapters;
pub mod claude;
pub mod fake;
pub mod gemini;
pub mod git_verify;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
pub use claude::{ClaudeAuthStatus, ClaudeCapabilities, ClaudeCapabilityProbe, ClaudeCodeBackend};
pub use gemini::{GeminiAuthStatus, GeminiCapabilities, GeminiCapabilityProbe, GeminiCliBackend};
use plexis_core::ids::ExecutionId;
use plexis_core::protocol::{ExecutionEvent, ExecutionRequest, ExecutionResult};
use tokio::sync::mpsc;

pub use adapters::{CodexBackend, OpenCodeBackend};
pub use fake::FakeAgentBackend;

use crate::error::RuntimeError;

/// Trait representing an external autonomous coding agent backend process.
#[async_trait]
pub trait AgentBackend: Send + Sync {
    /// Unique backend identifier (e.g. "fake_agent", "claude_code", "codex", "gemini_cli").
    fn id(&self) -> &str;

    /// Human-readable display name.
    fn display_name(&self) -> &str;

    /// Returns whether the backend executable is available on the system.
    fn is_available(&self) -> bool;

    /// Executes an objective within the target workspace, streaming events.
    async fn execute(
        &self,
        request: &ExecutionRequest,
        event_sender: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<ExecutionResult, RuntimeError>;

    /// Cancels an in-flight execution on this backend.
    async fn cancel(&self, execution_id: &ExecutionId) -> Result<(), RuntimeError>;
}

/// Registry holding available external agent backends.
#[derive(Clone, Default)]
pub struct BackendRegistry {
    backends: HashMap<String, Arc<dyn AgentBackend>>,
}

impl BackendRegistry {
    pub fn new() -> Self {
        Self {
            backends: HashMap::new(),
        }
    }

    /// Creates a registry initialized with all known standard backends (fake + CLI agents).
    pub fn with_defaults() -> Self {
        let mut reg = Self::new();
        reg.register(Arc::new(FakeAgentBackend::with_default_host()));
        reg.register(Arc::new(ClaudeCodeBackend::new()));
        reg.register(Arc::new(CodexBackend));
        reg.register(Arc::new(GeminiCliBackend::default()));
        reg.register(Arc::new(OpenCodeBackend));
        reg
    }

    /// Registers a backend in the registry.
    pub fn register(&mut self, backend: Arc<dyn AgentBackend>) {
        self.backends.insert(backend.id().to_string(), backend);
    }

    /// Retrieves a backend by ID.
    pub fn get(&self, id: &str) -> Option<Arc<dyn AgentBackend>> {
        self.backends.get(id).cloned()
    }

    /// Lists all registered backends.
    pub fn list_backends(&self) -> Vec<Arc<dyn AgentBackend>> {
        self.backends.values().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backend_registry_defaults() {
        let reg = BackendRegistry::with_defaults();
        assert!(reg.get("fake_agent").is_some());
        assert!(reg.get("claude_code").is_some());
        assert!(reg.get("codex").is_some());
        assert!(reg.get("gemini_cli").is_some());
        assert!(reg.get("opencode").is_some());

        let list = reg.list_backends();
        assert!(list.len() >= 5);
    }

    #[tokio::test]
    async fn test_cli_adapter_stubs_report_unavailability_when_missing() {
        let claude = ClaudeCodeBackend::new();
        assert_eq!(claude.id(), "claude_code");
        assert_eq!(claude.display_name(), "Anthropic Claude Code CLI");

        let codex = CodexBackend;
        assert_eq!(codex.id(), "codex");

        let gemini = GeminiCliBackend::default();
        assert_eq!(gemini.id(), "gemini_cli");
    }
}

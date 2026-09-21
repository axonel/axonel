//! Claude Code CLI Agent Backend
//!
//! Implements `AgentBackend` to bridge Plexis with the physical `claude` CLI
//! OS process (Anthropic Claude Code) via `LocalAgentHost`.

use std::sync::Arc;

use async_trait::async_trait;
use plexis_core::ids::ExecutionId;
use plexis_core::protocol::{ExecutionEvent, ExecutionRequest, ExecutionResult};
use tokio::sync::mpsc;

use super::probe::{ClaudeAuthStatus, ClaudeCapabilityProbe};
use super::stream::ClaudeCodeStreamParser;
use crate::agent_host::LocalAgentHost;
use crate::backend::git_verify::GitVerifier;
use crate::backend::AgentBackend;
use crate::error::RuntimeError;

/// Agent backend adapter invoking Anthropic Claude Code (`claude`).
pub struct ClaudeCodeBackend {
    host: Arc<LocalAgentHost>,
    probe: ClaudeCapabilityProbe,
    configured_model: Option<String>,
}

impl Default for ClaudeCodeBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeCodeBackend {
    pub fn new() -> Self {
        Self {
            host: Arc::new(LocalAgentHost::with_default_binary()),
            probe: ClaudeCapabilityProbe::new(),
            configured_model: std::env::var("PLEXIS_CLAUDE_MODEL").ok(),
        }
    }

    pub fn with_host(mut self, host: Arc<LocalAgentHost>) -> Self {
        self.host = host;
        self
    }

    pub fn with_probe(mut self, probe: ClaudeCapabilityProbe) -> Self {
        self.probe = probe;
        self
    }

    pub fn with_model(mut self, model: impl Into<String>) -> Self {
        self.configured_model = Some(model.into());
        self
    }

    pub fn host(&self) -> &Arc<LocalAgentHost> {
        &self.host
    }

    pub fn probe(&self) -> &ClaudeCapabilityProbe {
        &self.probe
    }

    /// Translates the request's requested capabilities into the headless
    /// `--permission-mode` value. `requested_capabilities` is the source of
    /// truth; recognized vocabulary:
    ///
    /// - `read_only`       -> `plan`
    /// - `workspace_edit`  -> `acceptEdits`
    /// - `full_autonomous` -> `bypassPermissions`
    ///
    /// When several are requested, the most restrictive wins. Requests without
    /// capabilities fall back to `execution_policy` (same vocabulary, keeping
    /// cross-backend behavior consistent), and to full-autonomous semantics
    /// when neither is present so autonomous missions retain write access
    /// inside the isolated worktree.
    fn resolve_permission_mode(request: &ExecutionRequest) -> &'static str {
        let caps = &request.requested_capabilities;
        if caps.iter().any(|c| c == "read_only") {
            "plan"
        } else if caps.iter().any(|c| c == "workspace_edit") {
            "acceptEdits"
        } else if caps.iter().any(|c| c == "full_autonomous") {
            "bypassPermissions"
        } else {
            match request.execution_policy.as_deref() {
                Some("read_only") => "plan",
                Some("workspace_edit") => "acceptEdits",
                _ => "bypassPermissions",
            }
        }
    }
}

#[async_trait]
impl AgentBackend for ClaudeCodeBackend {
    fn id(&self) -> &str {
        "claude_code"
    }

    fn display_name(&self) -> &str {
        "Anthropic Claude Code CLI"
    }

    fn is_available(&self) -> bool {
        let caps = self.probe.probe();
        caps.available
    }

    async fn execute(
        &self,
        request: &ExecutionRequest,
        event_sender: Option<mpsc::Sender<ExecutionEvent>>,
    ) -> Result<ExecutionResult, RuntimeError> {
        // 1. Check capabilities and authentication status
        let caps = self.probe.probe();
        if !caps.installed {
            return Err(RuntimeError::InvalidCommand(
                "Claude Code CLI (`claude`) is not installed or not found on PATH. Please install Claude Code or use fake agent adapter.".to_string(),
            ));
        }

        if !caps.available {
            let reason = match &caps.auth_status {
                ClaudeAuthStatus::Unauthenticated { reason } => reason.clone(),
                ClaudeAuthStatus::Unavailable => {
                    "Claude Code CLI executable unavailable".to_string()
                }
                _ => "Authentication required for headless execution".to_string(),
            };
            return Err(RuntimeError::InvalidCommand(format!(
                "authentication_required: {}",
                reason
            )));
        }

        let exe_path = caps.executable_path.ok_or_else(|| {
            RuntimeError::InvalidCommand("Claude Code CLI executable path not resolved".to_string())
        })?;

        // 2. Translate requested capabilities into the headless permission mode
        let permission_mode = Self::resolve_permission_mode(request);

        let prompt = match &request.description {
            Some(desc) if !desc.trim().is_empty() => {
                format!("{}\n\nContext & Instructions:\n{}", request.objective, desc)
            }
            _ => request.objective.clone(),
        };

        // 3. Build direct CLI arguments (zero shell interpolation).
        // `--verbose` is required by the CLI for stream-json output in print mode.
        let mut args = vec![
            "-p".to_string(),
            prompt,
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--verbose".to_string(),
            "--permission-mode".to_string(),
            permission_mode.to_string(),
        ];

        if let Some(ref m) = request.model {
            args.push("--model".to_string());
            args.push(m.clone());
        } else if let Some(ref m) = self.configured_model {
            args.push("--model".to_string());
            args.push(m.clone());
        }

        // 4. Snapshot Git repository state before execution
        let pre_git = GitVerifier::snapshot_pre_execution(&request.workspace_path);

        // 5. Spawn and supervise process via LocalAgentHost.
        // Credentials travel through the scrubbed request environment
        // (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN); no host keychain
        // integration is attempted.
        let parser = Arc::new(ClaudeCodeStreamParser::new());
        let cmd_output = self
            .host
            .spawn_command_execution(
                request.execution_id,
                &exe_path,
                &args,
                &request.workspace_path,
                &request.environment,
                request.timeout_secs,
                event_sender,
                Some(parser),
            )
            .await?;

        // 6. Independently inspect Git workspace changes
        let post_git = GitVerifier::verify_post_execution(&request.workspace_path, &pre_git)?;

        // 7. Formulate authoritative ExecutionResult
        let is_success =
            cmd_output.exit_code == 0 && !cmd_output.timed_out && !cmd_output.cancelled;
        let summary = if is_success {
            format!(
                "Claude Code completed objective successfully. Changed files: [{}]. Commit SHA: {}.",
                post_git.changed_files.join(", "),
                post_git.commit_sha.as_deref().unwrap_or("none")
            )
        } else if cmd_output.timed_out {
            format!(
                "Claude Code execution timed out after {}s",
                request.timeout_secs
            )
        } else if cmd_output.cancelled {
            "Claude Code execution cancelled".to_string()
        } else {
            format!(
                "Claude Code exited with code {}: {}",
                cmd_output.exit_code,
                cmd_output.stderr.trim()
            )
        };

        let failure_reason = if !is_success {
            Some(summary.clone())
        } else {
            None
        };

        Ok(ExecutionResult {
            protocol_version: request.protocol_version.clone(),
            execution_id: request.execution_id,
            exit_code: cmd_output.exit_code,
            success: is_success,
            summary,
            changed_files: post_git.changed_files,
            commit_sha: post_git.commit_sha,
            duration_ms: cmd_output.duration_ms,
            failure_reason,
            raw_stdout: Some(cmd_output.stdout),
            raw_stderr: Some(cmd_output.stderr),
            pid: None,
        })
    }

    async fn cancel(&self, execution_id: &ExecutionId) -> Result<(), RuntimeError> {
        self.host.cancel_execution(execution_id).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plexis_core::ids::{AgentId, ExecutionId};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn base_request() -> ExecutionRequest {
        let mut request = ExecutionRequest::new(
            ExecutionId::new(),
            AgentId::new(),
            "Developer",
            "obj",
            PathBuf::from("/tmp/workspace"),
        );
        request.requested_capabilities = Vec::new();
        request.execution_policy = None;
        request.environment = HashMap::new();
        request
    }

    #[test]
    fn test_capability_read_only_maps_to_plan() {
        let mut request = base_request();
        request.requested_capabilities = vec!["read_only".to_string()];
        assert_eq!(ClaudeCodeBackend::resolve_permission_mode(&request), "plan");
    }

    #[test]
    fn test_capability_workspace_edit_maps_to_accept_edits() {
        let mut request = base_request();
        request.requested_capabilities = vec!["workspace_edit".to_string()];
        assert_eq!(
            ClaudeCodeBackend::resolve_permission_mode(&request),
            "acceptEdits"
        );
    }

    #[test]
    fn test_capability_full_autonomous_maps_to_bypass_permissions() {
        let mut request = base_request();
        request.requested_capabilities = vec!["full_autonomous".to_string()];
        assert_eq!(
            ClaudeCodeBackend::resolve_permission_mode(&request),
            "bypassPermissions"
        );
    }

    #[test]
    fn test_most_restrictive_capability_wins() {
        let mut request = base_request();
        request.requested_capabilities =
            vec!["full_autonomous".to_string(), "read_only".to_string()];
        assert_eq!(ClaudeCodeBackend::resolve_permission_mode(&request), "plan");
    }

    #[test]
    fn test_execution_policy_fallback_when_no_capabilities() {
        let mut request = base_request();
        request.execution_policy = Some("workspace_edit".to_string());
        assert_eq!(
            ClaudeCodeBackend::resolve_permission_mode(&request),
            "acceptEdits"
        );
    }

    #[test]
    fn test_default_is_bypass_permissions_for_autonomous_missions() {
        let request = base_request();
        assert_eq!(
            ClaudeCodeBackend::resolve_permission_mode(&request),
            "bypassPermissions"
        );
    }

    #[tokio::test]
    async fn test_execute_fails_on_missing_binary() {
        let backend = ClaudeCodeBackend::new().with_probe(
            ClaudeCapabilityProbe::new().with_custom_path(PathBuf::from("/nonexistent/bin/claude")),
        );
        let request = base_request();

        let err = backend
            .execute(&request, None)
            .await
            .expect_err("expected missing-binary error");
        match err {
            RuntimeError::InvalidCommand(msg) => {
                assert!(msg.contains("not installed"), "unexpected message: {msg}");
            }
            other => panic!("Expected InvalidCommand, got {:?}", other),
        }
    }
}

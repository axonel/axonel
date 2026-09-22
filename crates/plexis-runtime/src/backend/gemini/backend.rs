//! Gemini CLI Agent Backend
//!
//! Implements `AgentBackend` to bridge Plexis with the physical `gemini` CLI OS process
//! via `LocalAgentHost`.

use std::sync::Arc;

use async_trait::async_trait;
use plexis_core::ids::ExecutionId;
use plexis_core::protocol::{ExecutionEvent, ExecutionRequest, ExecutionResult};
use tokio::sync::mpsc;

use super::probe::{GeminiAuthStatus, GeminiCapabilityProbe};
use super::stream::GeminiStreamParser;
use crate::agent_host::LocalAgentHost;
use crate::backend::git_verify::GitVerifier;
use crate::backend::AgentBackend;
use crate::error::RuntimeError;

/// Agent backend adapter invoking the official Google Gemini CLI (`gemini`).
pub struct GeminiCliBackend {
    host: Arc<LocalAgentHost>,
    probe: GeminiCapabilityProbe,
    configured_model: Option<String>,
}

impl Default for GeminiCliBackend {
    fn default() -> Self {
        Self::new()
    }
}

impl GeminiCliBackend {
    pub fn new() -> Self {
        let configured_model = std::env::var("PLEXIS_GEMINI_MODEL")
            .ok()
            .or_else(|| Some("gemini-3.1-flash-lite".to_string()));
        Self {
            host: Arc::new(LocalAgentHost::with_default_binary()),
            probe: GeminiCapabilityProbe::new(),
            configured_model,
        }
    }

    pub fn with_host(mut self, host: Arc<LocalAgentHost>) -> Self {
        self.host = host;
        self
    }

    pub fn with_probe(mut self, probe: GeminiCapabilityProbe) -> Self {
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

    pub fn probe(&self) -> &GeminiCapabilityProbe {
        &self.probe
    }
}

#[async_trait]
impl AgentBackend for GeminiCliBackend {
    fn id(&self) -> &str {
        "gemini_cli"
    }

    fn display_name(&self) -> &str {
        "Google Gemini Coding CLI"
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
                "Gemini CLI (`gemini`) is not installed or not found on PATH. Please install Gemini CLI or use fake agent adapter.".to_string(),
            ));
        }

        if !caps.available {
            let reason = match &caps.auth_status {
                GeminiAuthStatus::Unauthenticated { reason } => reason.clone(),
                GeminiAuthStatus::Unavailable => "Gemini CLI executable unavailable".to_string(),
                _ => "Authentication required for headless execution".to_string(),
            };
            return Err(RuntimeError::InvalidCommand(format!(
                "authentication_required: {}",
                reason
            )));
        }

        let exe_path = caps.executable_path.ok_or_else(|| {
            RuntimeError::InvalidCommand("Gemini CLI executable path not resolved".to_string())
        })?;

        // 2. Map Plexis governance policy to Gemini approval mode
        let approval_mode = match request.execution_policy.as_deref() {
            Some("read_only") => "plan",
            Some("workspace_edit") => "auto_edit",
            Some("full_autonomous") => "yolo",
            _ => "yolo",
        };

        let prompt = match &request.description {
            Some(desc) if !desc.trim().is_empty() => {
                format!("{}\n\nContext & Instructions:\n{}", request.objective, desc)
            }
            _ => request.objective.clone(),
        };

        // 3. Build direct CLI arguments (zero shell interpolation)
        let mut args = vec![
            "-p".to_string(),
            prompt,
            "-o".to_string(),
            "stream-json".to_string(),
            "--approval-mode".to_string(),
            approval_mode.to_string(),
            "--skip-trust".to_string(),
        ];

        if let Some(ref m) = request.model {
            args.push("-m".to_string());
            args.push(m.clone());
        } else if let Some(ref m) = self.configured_model {
            args.push("-m".to_string());
            args.push(m.clone());
        }

        // 4. Snapshot Git repository state before execution
        let pre_git = GitVerifier::snapshot_pre_execution(&request.workspace_path);

        // Prepare environment with permitted overrides
        let mut custom_env = request.environment.clone();
        if !custom_env.contains_key("GEMINI_API_KEY") {
            if let GeminiAuthStatus::Authenticated { ref method, .. } = caps.auth_status {
                if method == "gemini_keychain_api_key" {
                    if let Ok(output) = std::process::Command::new("secret-tool")
                        .args([
                            "lookup",
                            "service",
                            "gemini-cli-api-key",
                            "account",
                            "default-api-key",
                        ])
                        .output()
                    {
                        if output.status.success() {
                            let stdout = String::from_utf8_lossy(&output.stdout);
                            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                                if let Some(token) = parsed
                                    .get("token")
                                    .and_then(|t| t.get("accessToken"))
                                    .and_then(|a| a.as_str())
                                {
                                    custom_env
                                        .insert("GEMINI_API_KEY".to_string(), token.to_string());
                                }
                            }
                        }
                    }
                }
            }
        }

        // 5. Spawn and supervise process via LocalAgentHost
        let parser = Arc::new(GeminiStreamParser::new());
        let cmd_output = self
            .host
            .spawn_command_execution(
                request.execution_id,
                &exe_path,
                &args,
                &request.workspace_path,
                &custom_env,
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
                "Gemini CLI completed objective successfully. Changed files: [{}]. Commit SHA: {}.",
                post_git.changed_files.join(", "),
                post_git.commit_sha.as_deref().unwrap_or("none")
            )
        } else if cmd_output.timed_out {
            format!(
                "Gemini CLI execution timed out after {}s",
                request.timeout_secs
            )
        } else if cmd_output.cancelled {
            "Gemini CLI execution cancelled".to_string()
        } else {
            format!(
                "Gemini CLI exited with code {}: {}",
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

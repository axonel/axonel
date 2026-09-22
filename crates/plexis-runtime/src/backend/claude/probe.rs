//! Claude Code CLI Capability Probe
//!
//! Discovers the local Claude Code CLI installation, inspects version,
//! evaluates non-interactive authentication state, and reports operational
//! readiness without making expensive model inference calls.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Authentication state of the local Claude Code CLI installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum ClaudeAuthStatus {
    /// Authenticated via API key, OAuth token, or stored credentials.
    Authenticated {
        method: String,
        account: Option<String>,
    },
    /// Claude Code binary is present but lacks credentials for headless execution.
    Unauthenticated { reason: String },
    /// Claude Code binary is not installed or unavailable.
    Unavailable,
}

/// Comprehensive capability report for Claude Code CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClaudeCapabilities {
    pub installed: bool,
    pub executable_path: Option<PathBuf>,
    pub version: Option<String>,
    pub auth_status: ClaudeAuthStatus,
    pub headless_supported: bool,
    pub available: bool,
    pub diagnostics: String,
}

impl ClaudeCapabilities {
    /// Creates an unavailable report when Claude Code cannot be found.
    pub fn unavailable(diagnostics: impl Into<String>) -> Self {
        Self {
            installed: false,
            executable_path: None,
            version: None,
            auth_status: ClaudeAuthStatus::Unavailable,
            headless_supported: false,
            available: false,
            diagnostics: diagnostics.into(),
        }
    }
}

/// Capability probe for Anthropic Claude Code CLI.
pub struct ClaudeCapabilityProbe {
    custom_exe_path: Option<PathBuf>,
    home_dir: Option<PathBuf>,
}

impl Default for ClaudeCapabilityProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeCapabilityProbe {
    pub fn new() -> Self {
        Self {
            custom_exe_path: None,
            home_dir: None,
        }
    }

    pub fn with_custom_path(mut self, path: PathBuf) -> Self {
        self.custom_exe_path = Some(path);
        self
    }

    pub fn with_home_dir(mut self, home: PathBuf) -> Self {
        self.home_dir = Some(home);
        self
    }

    /// Probes the system and returns current Claude Code CLI capabilities.
    pub fn probe(&self) -> ClaudeCapabilities {
        let exe = match self.find_executable() {
            Some(path) => path,
            None => {
                return ClaudeCapabilities::unavailable(
                    "Claude Code CLI (`claude`) not found on PATH, PLEXIS_CLAUDE_PATH, or standard paths (~/.local/bin/claude, /usr/local/bin/claude).",
                );
            }
        };

        // 1. Version detection via `claude --version`
        let version = Self::detect_version(&exe);
        let headless_supported = version.is_some();

        // 2. Authentication detection without sending inference requests
        let auth_status = self.detect_auth_status();

        let available = matches!(&auth_status, ClaudeAuthStatus::Authenticated { .. });

        let diagnostics = match (&version, &auth_status) {
            (Some(v), ClaudeAuthStatus::Authenticated { method, account }) => {
                if let Some(acc) = account {
                    format!(
                        "Claude Code CLI v{} ready (authenticated as {} via {})",
                        v, acc, method
                    )
                } else {
                    format!(
                        "Claude Code CLI v{} ready (authenticated via {})",
                        v, method
                    )
                }
            }
            (Some(v), ClaudeAuthStatus::Unauthenticated { reason }) => {
                format!(
                    "Claude Code CLI v{} is installed at '{}', but requires authentication: {}",
                    v,
                    exe.display(),
                    reason
                )
            }
            (None, _) => {
                format!(
                    "Claude Code CLI found at '{}', but failed to query version.",
                    exe.display()
                )
            }
            _ => "Claude Code CLI unavailable.".to_string(),
        };

        ClaudeCapabilities {
            installed: true,
            executable_path: Some(exe),
            version,
            auth_status,
            headless_supported,
            available,
            diagnostics,
        }
    }

    /// Discovers the Claude Code CLI executable using the defined search hierarchy.
    pub fn find_executable(&self) -> Option<PathBuf> {
        // 1. Explicitly configured path (if specified, do not fall back to PATH)
        if let Some(ref path) = self.custom_exe_path {
            return if path.exists() {
                Some(path.clone())
            } else {
                None
            };
        }

        // 2. PLEXIS_CLAUDE_PATH environment override
        if let Ok(env_path) = std::env::var("PLEXIS_CLAUDE_PATH") {
            let p = PathBuf::from(env_path);
            if p.exists() {
                return Some(p);
            }
        }

        // 3. Search standard PATH
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join("claude");
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        // 4. Standard candidate locations
        let home = self
            .home_dir
            .clone()
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from));

        if let Some(h) = home {
            let user_candidates = [h.join(".local/bin/claude"), h.join(".claude/local/claude")];
            for cand in user_candidates {
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }

        let system_candidates = [
            PathBuf::from("/usr/local/bin/claude"),
            PathBuf::from("/usr/bin/claude"),
        ];
        system_candidates.into_iter().find(|cand| cand.is_file())
    }

    fn detect_version(exe: &Path) -> Option<String> {
        let output = Command::new(exe).arg("--version").output().ok()?;

        if output.status.success() {
            let ver_str = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !ver_str.is_empty() {
                return Some(ver_str);
            }
        }
        None
    }

    pub fn detect_auth_status(&self) -> ClaudeAuthStatus {
        // 1. Check ANTHROPIC_API_KEY in process environment
        if let Ok(key) = std::env::var("ANTHROPIC_API_KEY") {
            if !key.trim().is_empty() {
                return ClaudeAuthStatus::Authenticated {
                    method: "ANTHROPIC_API_KEY".to_string(),
                    account: None,
                };
            }
        }

        // 2. Check CLAUDE_CODE_OAUTH_TOKEN (long-lived token from `claude setup-token`)
        if let Ok(token) = std::env::var("CLAUDE_CODE_OAUTH_TOKEN") {
            if !token.trim().is_empty() {
                return ClaudeAuthStatus::Authenticated {
                    method: "CLAUDE_CODE_OAUTH_TOKEN".to_string(),
                    account: None,
                };
            }
        }

        // 3. Inspect Claude Code credential storage under the home directory
        let home = self
            .home_dir
            .clone()
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from));

        if let Some(ref h) = home {
            // Stored OAuth credentials written by `claude login`
            let credentials_file = h.join(".claude/.credentials.json");
            if credentials_file.is_file() {
                return ClaudeAuthStatus::Authenticated {
                    method: "claude_stored_credentials".to_string(),
                    account: None,
                };
            }

            // Config file carrying an active OAuth account
            let config_file = h.join(".claude.json");
            if config_file.is_file() {
                if let Ok(content) = std::fs::read_to_string(&config_file) {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(email) = parsed
                            .get("oauthAccount")
                            .and_then(|v| v.get("emailAddress"))
                            .and_then(|v| v.as_str())
                        {
                            if !email.trim().is_empty() {
                                return ClaudeAuthStatus::Authenticated {
                                    method: "oauth_personal".to_string(),
                                    account: Some(email.to_string()),
                                };
                            }
                        }
                    }
                }
            }
        }

        ClaudeAuthStatus::Unauthenticated {
            reason: "No ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN set and no stored Claude credentials found in ~/.claude/.credentials.json or ~/.claude.json.".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_claude_capabilities_unavailable_when_missing() {
        let probe = ClaudeCapabilityProbe::new()
            .with_custom_path(PathBuf::from("/nonexistent/bin/claude"))
            .with_home_dir(PathBuf::from("/nonexistent/home"));

        let caps = probe.probe();
        assert!(!caps.installed);
        assert!(!caps.available);
        assert_eq!(caps.auth_status, ClaudeAuthStatus::Unavailable);
        assert!(caps.diagnostics.contains("not found"));
    }

    #[test]
    fn test_claude_detects_unauthenticated_without_credentials() {
        let temp_dir = tempdir().expect("tempdir");

        let probe = ClaudeCapabilityProbe::new().with_home_dir(temp_dir.path().to_path_buf());
        let status = probe.detect_auth_status();

        match status {
            ClaudeAuthStatus::Unauthenticated { reason } => {
                assert!(reason.contains("No ANTHROPIC_API_KEY"));
            }
            _ => panic!("Expected Unauthenticated status, got {:?}", status),
        }
    }

    #[test]
    fn test_claude_detects_stored_credentials_file() {
        let temp_dir = tempdir().expect("tempdir");
        let claude_dir = temp_dir.path().join(".claude");
        std::fs::create_dir_all(&claude_dir).expect("create_dir");

        let credentials_path = claude_dir.join(".credentials.json");
        std::fs::write(
            &credentials_path,
            r#"{"claudeAiOauth": {"accessToken": "token", "refreshToken": "refresh"}}"#,
        )
        .expect("write credentials");

        let probe = ClaudeCapabilityProbe::new().with_home_dir(temp_dir.path().to_path_buf());
        let status = probe.detect_auth_status();

        match status {
            ClaudeAuthStatus::Authenticated { method, account } => {
                assert_eq!(method, "claude_stored_credentials");
                assert_eq!(account, None);
            }
            _ => panic!("Expected Authenticated status, got {:?}", status),
        }
    }

    #[test]
    fn test_claude_detects_oauth_account_in_config() {
        let temp_dir = tempdir().expect("tempdir");

        let config_path = temp_dir.path().join(".claude.json");
        std::fs::write(
            &config_path,
            r#"{"oauthAccount": {"emailAddress": "engineer@axonel.local"}}"#,
        )
        .expect("write config");

        let probe = ClaudeCapabilityProbe::new().with_home_dir(temp_dir.path().to_path_buf());
        let status = probe.detect_auth_status();

        match status {
            ClaudeAuthStatus::Authenticated { method, account } => {
                assert_eq!(method, "oauth_personal");
                assert_eq!(account, Some("engineer@axonel.local".to_string()));
            }
            _ => panic!("Expected Authenticated status, got {:?}", status),
        }
    }

    #[test]
    fn test_claude_unauthenticated_when_oauth_account_empty() {
        let temp_dir = tempdir().expect("tempdir");

        let config_path = temp_dir.path().join(".claude.json");
        std::fs::write(&config_path, r#"{"oauthAccount": {"emailAddress": ""}}"#)
            .expect("write config");

        let probe = ClaudeCapabilityProbe::new().with_home_dir(temp_dir.path().to_path_buf());
        let status = probe.detect_auth_status();

        match status {
            ClaudeAuthStatus::Unauthenticated { .. } => {}
            _ => panic!("Expected Unauthenticated status, got {:?}", status),
        }
    }
}

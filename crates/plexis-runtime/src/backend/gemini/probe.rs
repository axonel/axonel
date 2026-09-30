//! Gemini CLI Capability Probe
//!
//! Discovers the local Gemini CLI installation, inspects version,
//! evaluates non-interactive authentication state, and reports operational
//! readiness without making expensive model inference calls.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// Authentication state of the local Gemini CLI installation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum GeminiAuthStatus {
    /// Authenticated via Google OAuth account or API key.
    Authenticated {
        method: String,
        account: Option<String>,
    },
    /// Gemini CLI binary is present but lacks credentials for headless execution.
    Unauthenticated { reason: String },
    /// Gemini CLI binary is not installed or unavailable.
    Unavailable,
}

/// Comprehensive capability report for Gemini CLI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GeminiCapabilities {
    pub installed: bool,
    pub executable_path: Option<PathBuf>,
    pub version: Option<String>,
    pub auth_status: GeminiAuthStatus,
    pub headless_supported: bool,
    pub available: bool,
    pub diagnostics: String,
}

impl GeminiCapabilities {
    /// Creates an unavailable report when Gemini CLI cannot be found.
    pub fn unavailable(diagnostics: impl Into<String>) -> Self {
        Self {
            installed: false,
            executable_path: None,
            version: None,
            auth_status: GeminiAuthStatus::Unavailable,
            headless_supported: false,
            available: false,
            diagnostics: diagnostics.into(),
        }
    }
}

/// Capability probe for Google Gemini CLI.
pub struct GeminiCapabilityProbe {
    custom_exe_path: Option<PathBuf>,
    home_dir: Option<PathBuf>,
}

impl Default for GeminiCapabilityProbe {
    fn default() -> Self {
        Self::new()
    }
}

impl GeminiCapabilityProbe {
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

    /// Probes the system and returns current Gemini CLI capabilities.
    pub fn probe(&self) -> GeminiCapabilities {
        let exe = match self.find_executable() {
            Some(path) => path,
            None => {
                return GeminiCapabilities::unavailable(
                    "Gemini CLI (`gemini`) not found on PATH, PLEXIS_GEMINI_PATH, or standard paths (~/.local/bin/gemini, /usr/local/bin/gemini).",
                );
            }
        };

        // 1. Version detection via `gemini --version`
        let version = Self::detect_version(&exe);
        let headless_supported = version.is_some();

        // 2. Authentication detection without sending inference requests
        let auth_status = self.detect_auth_status();

        let available = matches!(&auth_status, GeminiAuthStatus::Authenticated { .. });

        let diagnostics = match (&version, &auth_status) {
            (Some(v), GeminiAuthStatus::Authenticated { method, account }) => {
                if let Some(acc) = account {
                    format!(
                        "Gemini CLI v{} ready (authenticated as {} via {})",
                        v, acc, method
                    )
                } else {
                    format!("Gemini CLI v{} ready (authenticated via {})", v, method)
                }
            }
            (Some(v), GeminiAuthStatus::Unauthenticated { reason }) => {
                format!(
                    "Gemini CLI v{} is installed at '{}', but requires authentication: {}",
                    v,
                    exe.display(),
                    reason
                )
            }
            (None, _) => {
                format!(
                    "Gemini CLI found at '{}', but failed to query version.",
                    exe.display()
                )
            }
            _ => "Gemini CLI unavailable.".to_string(),
        };

        GeminiCapabilities {
            installed: true,
            executable_path: Some(exe),
            version,
            auth_status,
            headless_supported,
            available,
            diagnostics,
        }
    }

    /// Discovers the Gemini CLI executable using the defined search hierarchy.
    pub fn find_executable(&self) -> Option<PathBuf> {
        // 1. Explicitly configured path (if specified, do not fall back to PATH)
        if let Some(ref path) = self.custom_exe_path {
            return if path.exists() {
                Some(path.clone())
            } else {
                None
            };
        }

        // 2. PLEXIS_GEMINI_PATH environment override
        if let Ok(env_path) = std::env::var("PLEXIS_GEMINI_PATH") {
            let p = PathBuf::from(env_path);
            if p.exists() {
                return Some(p);
            }
        }

        // 3. Search standard PATH
        if let Ok(path_var) = std::env::var("PATH") {
            for dir in std::env::split_paths(&path_var) {
                let candidate = dir.join("gemini");
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
            let user_candidates = [
                h.join(".local/bin/gemini"),
                h.join(".local/share/mise/installs/gemini/latest/node_modules/.bin/gemini"),
            ];
            for cand in user_candidates {
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }

        let system_candidates = [
            PathBuf::from("/usr/local/bin/gemini"),
            PathBuf::from("/usr/bin/gemini"),
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

    pub fn detect_auth_status(&self) -> GeminiAuthStatus {
        // 1. Check GEMINI_API_KEY in process environment
        if let Ok(key) = std::env::var("GEMINI_API_KEY") {
            if !key.trim().is_empty() {
                return GeminiAuthStatus::Authenticated {
                    method: "GEMINI_API_KEY".to_string(),
                    account: None,
                };
            }
        }

        // 2. Check GOOGLE_API_KEY in process environment
        if let Ok(key) = std::env::var("GOOGLE_API_KEY") {
            if !key.trim().is_empty() {
                return GeminiAuthStatus::Authenticated {
                    method: "GOOGLE_API_KEY".to_string(),
                    account: None,
                };
            }
        }

        // 3. Inspect ~/.gemini/google_accounts.json for an active Google OAuth account
        let home = self
            .home_dir
            .clone()
            .or_else(|| std::env::var("HOME").ok().map(PathBuf::from));

        if let Some(ref h) = home {
            let accounts_file = h.join(".gemini/google_accounts.json");
            if accounts_file.is_file() {
                if let Ok(content) = std::fs::read_to_string(&accounts_file) {
                    if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(active) = parsed.get("active").and_then(|v| v.as_str()) {
                            if !active.trim().is_empty() {
                                return GeminiAuthStatus::Authenticated {
                                    method: "oauth_personal".to_string(),
                                    account: Some(active.to_string()),
                                };
                            }
                        }
                    }
                }
            }

            // Check Application Default Credentials (ADC)
            let adc_file = h.join(".config/gcloud/application_default_credentials.json");
            if adc_file.is_file() {
                return GeminiAuthStatus::Authenticated {
                    method: "google_application_default_credentials".to_string(),
                    account: None,
                };
            }
        }

        // Check GOOGLE_APPLICATION_CREDENTIALS environment variable
        if let Ok(adc_path) = std::env::var("GOOGLE_APPLICATION_CREDENTIALS") {
            if Path::new(&adc_path).is_file() {
                return GeminiAuthStatus::Authenticated {
                    method: "google_application_credentials_env".to_string(),
                    account: None,
                };
            }
        }

        // Check system keyring (secret-tool) for Gemini CLI API key (only if running with host's default home)
        if self.home_dir.is_none() {
            if let Ok(output) = Command::new("secret-tool")
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
                    if !stdout.trim().is_empty() {
                        return GeminiAuthStatus::Authenticated {
                            method: "gemini_keychain_api_key".to_string(),
                            account: Some("default-api-key".to_string()),
                        };
                    }
                }
            }
        }

        GeminiAuthStatus::Unauthenticated {
            reason: "No active Google account found in ~/.gemini/google_accounts.json and GEMINI_API_KEY / GOOGLE_API_KEY not set.".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_gemini_capabilities_unavailable_when_missing() {
        let probe = GeminiCapabilityProbe::new()
            .with_custom_path(PathBuf::from("/nonexistent/bin/gemini"))
            .with_home_dir(PathBuf::from("/nonexistent/home"));

        let caps = probe.probe();
        assert!(!caps.installed);
        assert!(!caps.available);
        assert_eq!(caps.auth_status, GeminiAuthStatus::Unavailable);
        assert!(caps.diagnostics.contains("not found"));
    }

    #[test]
    fn test_gemini_detects_unauthenticated_with_empty_accounts() {
        let temp_dir = tempdir().expect("tempdir");
        let gemini_dir = temp_dir.path().join(".gemini");
        std::fs::create_dir_all(&gemini_dir).expect("create_dir");

        let accounts_path = gemini_dir.join("google_accounts.json");
        std::fs::write(&accounts_path, r#"{"active": null, "old": []}"#).expect("write accounts");

        let probe = GeminiCapabilityProbe::new().with_home_dir(temp_dir.path().to_path_buf());
        let status = probe.detect_auth_status();

        match status {
            GeminiAuthStatus::Unauthenticated { reason } => {
                assert!(reason.contains("No active Google account"));
            }
            _ => panic!("Expected Unauthenticated status, got {:?}", status),
        }
    }

    #[test]
    fn test_gemini_detects_authenticated_with_active_account() {
        let temp_dir = tempdir().expect("tempdir");
        let gemini_dir = temp_dir.path().join(".gemini");
        std::fs::create_dir_all(&gemini_dir).expect("create_dir");

        let accounts_path = gemini_dir.join("google_accounts.json");
        std::fs::write(
            &accounts_path,
            r#"{"active": "engineer@sentinel.local", "old": []}"#,
        )
        .expect("write accounts");

        let probe = GeminiCapabilityProbe::new().with_home_dir(temp_dir.path().to_path_buf());
        let status = probe.detect_auth_status();

        match status {
            GeminiAuthStatus::Authenticated { method, account } => {
                assert_eq!(method, "oauth_personal");
                assert_eq!(account, Some("engineer@sentinel.local".to_string()));
            }
            _ => panic!("Expected Authenticated status, got {:?}", status),
        }
    }

    #[test]
    fn test_gemini_probe_on_current_system() {
        let probe = GeminiCapabilityProbe::new();
        let caps = probe.probe();
        if !caps.installed {
            assert!(!caps.available);
            return;
        }
        assert!(caps.installed);
        assert!(caps.executable_path.is_some());
        assert!(caps.headless_supported);
    }
}

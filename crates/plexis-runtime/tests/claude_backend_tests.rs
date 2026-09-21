//! Claude Code Backend Contract, Lifecycle, and Failure Tests
//!
//! Credential-free hermetic coverage for `ClaudeCodeBackend`, mirroring the
//! Gemini backend test suite with a scripted `claude` fixture that emits
//! canned stream-json. Verifies that the backend:
//! - Conforms to the `AgentBackend` contract
//! - Handles missing binary (`backend unavailable`)
//! - Handles unauthenticated state (`authentication_required`)
//! - Translates requested capabilities into the headless permission mode
//! - Records non-zero exit codes as failures
//! - Streams parsed events and detects independent Git provenance
//!
//! This file is `cfg(unix)`: the fixture relies on POSIX process-group
//! supervision and shell scripts, matching the platform support contract.

#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use plexis_core::ids::{AgentId, ExecutionId};
use plexis_core::protocol::{ExecutionEvent, ExecutionEventType, ExecutionRequest};
use plexis_runtime::agent_host::LocalAgentHost;
use plexis_runtime::backend::claude::{ClaudeCapabilityProbe, ClaudeCodeBackend};
use plexis_runtime::backend::{AgentBackend, FakeAgentBackend};
use tempfile::tempdir;
use tokio::sync::mpsc;

fn setup_git_workspace(dir: &Path) {
    Command::new("git")
        .current_dir(dir)
        .arg("init")
        .output()
        .expect("git init");
    Command::new("git")
        .current_dir(dir)
        .args(["config", "user.name", "Tester"])
        .output()
        .expect("git config user");
    Command::new("git")
        .current_dir(dir)
        .args(["config", "user.email", "tester@axonel.local"])
        .output()
        .expect("git config email");

    fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"calc\"\nversion = \"0.1.0\"\n",
    )
    .expect("write Cargo.toml");
    fs::create_dir_all(dir.join("src")).expect("mkdir src");
    fs::write(
        dir.join("src/lib.rs"),
        "pub fn multiply(a: i32, b: i32) -> i32 {\n    a + b\n}\n",
    )
    .expect("write src/lib.rs");

    Command::new("git")
        .current_dir(dir)
        .args(["add", "-A"])
        .output()
        .expect("git add");
    Command::new("git")
        .current_dir(dir)
        .args(["commit", "-m", "Initial commit with bug"])
        .output()
        .expect("git commit");
}

fn create_mock_script(path: &Path, content: &str) {
    fs::write(path, content).expect("write mock script");
    let mut perms = fs::metadata(path).expect("metadata").permissions();
    perms.set_mode(0o755);
    fs::set_permissions(path, perms).expect("set_permissions");
}

/// Builds a backend around a scripted `claude` fixture with an isolated home
/// directory holding fixture credentials, so probe results are deterministic
/// and credential-free (nothing real is ever contacted).
fn fixture_backend(mock_claude: &Path) -> ClaudeCodeBackend {
    let temp_home = tempdir().expect("temp_home");
    let claude_dir = temp_home.path().join(".claude");
    std::fs::create_dir_all(&claude_dir).expect("create .claude dir");
    std::fs::write(
        claude_dir.join(".credentials.json"),
        r#"{"claudeAiOauth": {"accessToken": "fixture-access-token"}}"#,
    )
    .expect("write fixture credentials");

    let probe = ClaudeCapabilityProbe::new()
        .with_custom_path(mock_claude.to_path_buf())
        .with_home_dir(temp_home.path().to_path_buf());

    let host = Arc::new(LocalAgentHost::new(mock_claude.to_path_buf()));
    let backend = ClaudeCodeBackend::new().with_host(host).with_probe(probe);
    // Keep the isolated home alive for the lifetime of the test: the probe
    // and the spawned fixture read it during execute().
    std::mem::forget(temp_home);
    backend
}

#[tokio::test]
async fn test_agent_backend_contract_parity() {
    let fake: Arc<dyn AgentBackend> = Arc::new(FakeAgentBackend::with_default_host());
    let claude: Arc<dyn AgentBackend> = Arc::new(ClaudeCodeBackend::new());

    assert_eq!(fake.id(), "fake_agent");
    assert_eq!(claude.id(), "claude_code");

    assert!(fake.display_name().contains("Fake"));
    assert!(claude.display_name().contains("Claude"));

    // Both satisfy AgentBackend trait Send + Sync
    let _backends: Vec<Arc<dyn AgentBackend>> = vec![fake, claude];
}

#[tokio::test]
async fn test_claude_missing_binary_returns_unavailable() {
    let missing_probe = ClaudeCapabilityProbe::new()
        .with_custom_path(PathBuf::from("/nonexistent/bin/claude_missing"))
        .with_home_dir(PathBuf::from("/nonexistent/home"));

    let backend = ClaudeCodeBackend::new().with_probe(missing_probe);
    assert!(!backend.is_available());

    let dir = tempdir().expect("tempdir");
    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Fix bug",
        dir.path().to_path_buf(),
    );

    let err = backend.execute(&req, None).await.unwrap_err();
    let err_msg = err.to_string();
    assert!(
        err_msg.contains("not installed") || err_msg.contains("not found"),
        "Expected missing binary error, got: {}",
        err_msg
    );
}

#[tokio::test]
async fn test_claude_unauthenticated_returns_actionable_error() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_claude = bin_dir.path().join("claude");
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "1.0.0 (Claude Code)"
    exit 0
fi
exit 1
"#;
    create_mock_script(&mock_claude, script_content);

    // Isolated home without any stored credentials
    let temp_home = tempdir().expect("temp_home");
    let probe = ClaudeCapabilityProbe::new()
        .with_custom_path(mock_claude.clone())
        .with_home_dir(temp_home.path().to_path_buf());

    let backend = ClaudeCodeBackend::new().with_probe(probe);

    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Fix multiply bug",
        dir.path().to_path_buf(),
    );

    let err = backend.execute(&req, None).await.unwrap_err();
    let err_msg = err.to_string();
    assert!(
        err_msg.contains("authentication_required"),
        "Expected authentication_required error, got: {}",
        err_msg
    );
}

#[tokio::test]
async fn test_claude_mock_autonomous_execution_with_git_provenance() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_claude = bin_dir.path().join("claude");

    // Script simulates Claude Code in headless stream-json mode:
    // It emits system/assistant/result events, fixes src/lib.rs, and creates
    // a real Git commit.
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "1.0.0 (Claude Code)"
    exit 0
fi

echo '{"type":"system","subtype":"init","session_id":"fixture-session","model":"claude-fixture","tools":["Bash","Read","Edit"]}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Inspecting the multiply function."}]}}'
echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"src/lib.rs"}}]}}'
sleep 0.1
cat << 'EOF' > src/lib.rs
pub fn multiply(a: i32, b: i32) -> i32 {
    a * b
}

#[test]
fn test_multiply() {
    assert_eq!(multiply(3, 4), 12);
}
EOF

git add src/lib.rs
git commit -m "fix(calc): correctly multiply operands in multiply()"
echo '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"edited src/lib.rs"}]}}'
echo '{"type":"result","subtype":"success","is_error":false,"result":"Fixed multiply() and committed changes.","num_turns":3}'
exit 0
"#;
    create_mock_script(&mock_claude, script_content);

    let backend = fixture_backend(&mock_claude);
    assert!(backend.is_available());

    let (tx, mut rx) = mpsc::channel::<ExecutionEvent>(50);

    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Fix multiply function bug",
        dir.path().to_path_buf(),
    )
    .with_execution_policy("full_autonomous");

    let result = backend.execute(&req, Some(tx)).await.expect("execute");

    assert!(result.success);
    assert_eq!(result.exit_code, 0);
    assert!(result.changed_files.contains(&"src/lib.rs".to_string()));
    assert!(result.commit_sha.is_some());
    assert!(result.summary.contains("Claude Code completed objective"));

    // Verify events were streamed
    let mut received_events = Vec::new();
    while let Ok(ev) = rx.try_recv() {
        received_events.push(ev);
    }
    assert!(!received_events.is_empty());
    assert!(received_events
        .iter()
        .any(|e| matches!(e.event, ExecutionEventType::Started { .. })));
    assert!(received_events
        .iter()
        .any(|e| matches!(e.event, ExecutionEventType::ToolAction { .. })));
    assert!(received_events.iter().any(|e| matches!(
        e.event,
        ExecutionEventType::Stdout { ref text }
            if text.contains("fixture-session")
    )));

    // Verify git directly on disk
    let head_commit = Command::new("git")
        .current_dir(dir.path())
        .args(["log", "-1", "--pretty=%s"])
        .output()
        .expect("git log");
    let log_msg = String::from_utf8_lossy(&head_commit.stdout);
    assert!(log_msg.contains("correctly multiply"));
}

#[tokio::test]
async fn test_claude_requested_capabilities_translate_to_permission_mode() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_claude = bin_dir.path().join("claude");

    // Fixture records its invocation arguments so the test can assert the
    // exact CLI contract derived from requested capabilities.
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "1.0.0 (Claude Code)"
    exit 0
fi
printf '%s\n' "$@" > captured_args.txt
echo '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'
exit 0
"#;
    create_mock_script(&mock_claude, script_content);

    let backend = fixture_backend(&mock_claude);

    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Read-only inspection",
        dir.path().to_path_buf(),
    );
    let mut req = req;
    req.requested_capabilities = vec!["read_only".to_string()];

    let result = backend.execute(&req, None).await.expect("execute");
    assert!(result.success);

    let captured =
        fs::read_to_string(dir.path().join("captured_args.txt")).expect("fixture captured args");
    assert!(
        captured.contains("--permission-mode\nplan\n"),
        "Expected read_only to translate to `--permission-mode plan`, got: {}",
        captured
    );
}

#[tokio::test]
async fn test_claude_non_zero_exit_recorded_as_failure() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_claude = bin_dir.path().join("claude");
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "1.0.0 (Claude Code)"
    exit 0
fi
>&2 echo "FatalError: authentication rejected by provider"
exit 2
"#;
    create_mock_script(&mock_claude, script_content);

    let backend = fixture_backend(&mock_claude);

    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Fix multiply bug",
        dir.path().to_path_buf(),
    );

    let result = backend.execute(&req, None).await.expect("execute");
    assert!(!result.success);
    assert_eq!(result.exit_code, 2);
    assert!(result.failure_reason.is_some());
    assert!(result.summary.contains("exited with code 2"));
}

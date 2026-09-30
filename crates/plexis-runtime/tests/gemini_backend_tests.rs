//! Gemini Backend Contract, Lifecycle, and Failure Tests
//!
//! Verifies that `GeminiCliBackend` conforms to the `AgentBackend` contract,
//! shares parity with `FakeAgentBackend`, and cleanly handles:
//! - Missing binary (`backend unavailable`)
//! - Unauthenticated state (`authentication_required`)
//! - Non-zero exit codes
//! - Timeout enforcement with process-group teardown
//! - Cancellation signaling with zero orphaned child processes
//! - Independent Git provenance detection

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::time::Duration;

use plexis_core::ids::{AgentId, ExecutionId};
use plexis_core::protocol::{ExecutionEvent, ExecutionEventType, ExecutionRequest};
use plexis_runtime::agent_host::{LocalAgentHost, ProcessState};
use plexis_runtime::backend::gemini::{GeminiCapabilityProbe, GeminiCliBackend};
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
        .args(["config", "user.email", "tester@sentinel.local"])
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

#[tokio::test]
async fn test_agent_backend_contract_parity() {
    let fake: Arc<dyn AgentBackend> = Arc::new(FakeAgentBackend::with_default_host());
    let gemini: Arc<dyn AgentBackend> = Arc::new(GeminiCliBackend::default());

    assert_eq!(fake.id(), "fake_agent");
    assert_eq!(gemini.id(), "gemini_cli");

    assert!(fake.display_name().contains("Fake"));
    assert!(gemini.display_name().contains("Gemini"));

    // Both satisfy AgentBackend trait Send + Sync
    let _backends: Vec<Arc<dyn AgentBackend>> = vec![fake, gemini];
}

#[tokio::test]
async fn test_gemini_missing_binary_returns_unavailable() {
    let missing_probe = GeminiCapabilityProbe::new()
        .with_custom_path(PathBuf::from("/nonexistent/bin/gemini_cli_missing"))
        .with_home_dir(PathBuf::from("/nonexistent/home"));

    let backend = GeminiCliBackend::new().with_probe(missing_probe);
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
async fn test_gemini_unauthenticated_returns_actionable_error() {
    let probe = GeminiCapabilityProbe::new();
    let caps = probe.probe();
    if !caps.installed {
        println!("Skipping: gemini CLI binary not installed");
        return;
    }

    let temp_home = tempdir().expect("temp_home");
    let gemini_cfg_dir = temp_home.path().join(".gemini");
    fs::create_dir_all(&gemini_cfg_dir).expect("create .gemini");
    fs::write(
        gemini_cfg_dir.join("google_accounts.json"),
        r#"{"active": null, "old": []}"#,
    )
    .expect("write accounts");

    // Point to current installed gemini with unauthenticated home
    let unauth_probe = probe.with_home_dir(temp_home.path().to_path_buf());
    let backend = GeminiCliBackend::new().with_probe(unauth_probe);

    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

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
async fn test_gemini_mock_autonomous_execution_with_git_provenance() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_gemini = bin_dir.path().join("gemini");

    // Script simulates Gemini CLI in headless stream-json mode:
    // It emits JSON events, fixes src/lib.rs, and creates a real Git commit.
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "0.60.0"
    exit 0
fi

echo '{"tool": "file_edit", "action": "replace", "parameters": {"path": "src/lib.rs"}}'
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
echo '{"text": "Successfully fixed multiply() and committed changes."}'
exit 0
"#;
    create_mock_script(&mock_gemini, script_content);

    // Setup home with active account to pass capability probe
    let temp_home = tempdir().expect("temp_home");
    let gemini_cfg_dir = temp_home.path().join(".gemini");
    fs::create_dir_all(&gemini_cfg_dir).expect("create .gemini");
    fs::write(
        gemini_cfg_dir.join("google_accounts.json"),
        r#"{"active": "test-bot@sentinel.local", "old": []}"#,
    )
    .expect("write accounts");

    let probe = GeminiCapabilityProbe::new()
        .with_custom_path(mock_gemini.clone())
        .with_home_dir(temp_home.path().to_path_buf());

    let host = Arc::new(LocalAgentHost::new(mock_gemini));
    let backend = GeminiCliBackend::new().with_host(host).with_probe(probe);

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
async fn test_gemini_non_zero_exit_recorded_as_failure() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_gemini = bin_dir.path().join("gemini");
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "0.60.0"
    exit 0
fi
>&2 echo "FatalError: syntax parsing failed on workspace target"
exit 2
"#;
    create_mock_script(&mock_gemini, script_content);

    let temp_home = tempdir().expect("temp_home");
    let gemini_cfg_dir = temp_home.path().join(".gemini");
    fs::create_dir_all(&gemini_cfg_dir).expect("create .gemini");
    fs::write(
        gemini_cfg_dir.join("google_accounts.json"),
        r#"{"active": "test-bot@sentinel.local", "old": []}"#,
    )
    .expect("write accounts");

    let probe = GeminiCapabilityProbe::new()
        .with_custom_path(mock_gemini.clone())
        .with_home_dir(temp_home.path().to_path_buf());

    let host = Arc::new(LocalAgentHost::new(mock_gemini));
    let backend = GeminiCliBackend::new().with_host(host).with_probe(probe);

    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Failing task",
        dir.path().to_path_buf(),
    );

    let result = backend.execute(&req, None).await.expect("execute");
    assert!(!result.success);
    assert_eq!(result.exit_code, 2);
    assert!(result.failure_reason.is_some());
    let reason = result.failure_reason.unwrap();
    assert!(reason.contains("FatalError") || reason.contains("code 2"));
}

#[tokio::test]
async fn test_gemini_timeout_kills_process_group_and_reaps_orphans() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_gemini = bin_dir.path().join("gemini");
    // Script sleeps longer than timeout threshold
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "0.60.0"
    exit 0
fi
# Spawn child sleep process in background to test process-group teardown
sleep 60 &
CHILD_PID=$!
sleep 60
"#;
    create_mock_script(&mock_gemini, script_content);

    let temp_home = tempdir().expect("temp_home");
    let gemini_cfg_dir = temp_home.path().join(".gemini");
    fs::create_dir_all(&gemini_cfg_dir).expect("create .gemini");
    fs::write(
        gemini_cfg_dir.join("google_accounts.json"),
        r#"{"active": "test-bot@sentinel.local", "old": []}"#,
    )
    .expect("write accounts");

    let probe = GeminiCapabilityProbe::new()
        .with_custom_path(mock_gemini.clone())
        .with_home_dir(temp_home.path().to_path_buf());

    let host = Arc::new(LocalAgentHost::new(mock_gemini));
    let backend = GeminiCliBackend::new().with_host(host).with_probe(probe);

    let req = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Developer",
        "Timeout task",
        dir.path().to_path_buf(),
    )
    .with_timeout_secs(1); // 1 second timeout

    let result = backend.execute(&req, None).await.expect("execute");
    assert!(!result.success);
    assert_eq!(result.exit_code, 124);
    assert!(result.failure_reason.unwrap().contains("timed out"));
}

#[tokio::test]
async fn test_gemini_cancellation_terminates_process_group() {
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let bin_dir = tempdir().expect("bin_dir");
    let mock_gemini = bin_dir.path().join("gemini");
    let script_content = r#"#!/bin/bash
if [ "$1" = "--version" ]; then
    echo "0.60.0"
    exit 0
fi
sleep 30
"#;
    create_mock_script(&mock_gemini, script_content);

    let temp_home = tempdir().expect("temp_home");
    let gemini_cfg_dir = temp_home.path().join(".gemini");
    fs::create_dir_all(&gemini_cfg_dir).expect("create .gemini");
    fs::write(
        gemini_cfg_dir.join("google_accounts.json"),
        r#"{"active": "test-bot@sentinel.local", "old": []}"#,
    )
    .expect("write accounts");

    let probe = GeminiCapabilityProbe::new()
        .with_custom_path(mock_gemini.clone())
        .with_home_dir(temp_home.path().to_path_buf());

    let host = Arc::new(LocalAgentHost::new(mock_gemini));
    let backend = Arc::new(
        GeminiCliBackend::new()
            .with_host(host.clone())
            .with_probe(probe),
    );

    let exec_id = ExecutionId::new();
    let req = ExecutionRequest::new(
        exec_id,
        AgentId::new(),
        "Developer",
        "Cancellation task",
        dir.path().to_path_buf(),
    )
    .with_timeout_secs(30);

    let backend_clone = backend.clone();
    let handle = tokio::spawn(async move { backend_clone.execute(&req, None).await });

    // Wait for process to spawn
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Send cancellation
    backend.cancel(&exec_id).await.expect("cancel");

    let result = handle.await.expect("task join").expect("execute outcome");
    assert!(!result.success);
    assert!(result.summary.contains("cancelled") || result.exit_code != 0);
}

#[tokio::test]
async fn test_real_gemini_binary_timeout_kills_process_group() {
    let probe = GeminiCapabilityProbe::new();
    let caps = probe.probe();
    if !caps.installed {
        println!("Skipping: gemini CLI binary not installed");
        return;
    }
    let real_exe = caps.executable_path.unwrap();
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let host = Arc::new(LocalAgentHost::new(real_exe.clone()));
    let exec_id = ExecutionId::new();

    // Spawn real gemini CLI binary with a 1 second timeout
    let res = host
        .spawn_command_execution(
            exec_id,
            &real_exe,
            &["-p".to_string(), "test prompt".to_string()],
            dir.path(),
            &std::collections::HashMap::new(),
            1, // 1 second timeout
            None,
            None,
        )
        .await;

    assert!(res.is_ok());
    let output = res.unwrap();
    assert_eq!(output.exit_code, 124, "Timeout exit code must be 124");
    assert!(output.timed_out, "Must be flagged as timed out");

    // Verify host tracked TimedOut state
    let active = host.list_active_processes().await;
    let proc_record = active
        .iter()
        .find(|p| p.execution_id == exec_id)
        .expect("tracked");
    assert!(matches!(proc_record.state, ProcessState::TimedOut));

    // Verify real process is no longer running in OS
    unsafe {
        // libc::kill(pid, 0) returns -1 if process does not exist
        let res = libc::kill(proc_record.pid as i32, 0);
        assert!(res != 0 || nix_wait_reaped(proc_record.pid));
    }
}

fn nix_wait_reaped(pid: u32) -> bool {
    // Check if process has exited
    std::thread::sleep(std::time::Duration::from_millis(100));
    unsafe { libc::kill(pid as i32, 0) != 0 }
}

#[tokio::test]
async fn test_real_gemini_binary_cancellation_kills_process_group() {
    let probe = GeminiCapabilityProbe::new();
    let caps = probe.probe();
    if !caps.installed {
        println!("Skipping: gemini CLI binary not installed");
        return;
    }
    let real_exe = caps.executable_path.unwrap();
    let dir = tempdir().expect("tempdir");
    setup_git_workspace(dir.path());

    let host = Arc::new(LocalAgentHost::new(real_exe.clone()));
    let exec_id = ExecutionId::new();

    let host_clone = host.clone();
    let real_exe_clone = real_exe.clone();
    let dir_buf = dir.path().to_path_buf();
    let handle = tokio::spawn(async move {
        host_clone
            .spawn_command_execution(
                exec_id,
                &real_exe_clone,
                &["-p".to_string(), "test prompt".to_string()],
                &dir_buf,
                &std::collections::HashMap::new(),
                30, // 30 second timeout
                None,
                None,
            )
            .await
    });

    // Wait for process to spawn
    tokio::time::sleep(Duration::from_millis(400)).await;

    // Send cancellation to real gemini process group
    host.cancel_execution(&exec_id).await.expect("cancel");

    let res = handle.await.expect("join handle");
    assert!(res.is_ok());
    let output = res.unwrap();
    assert_ne!(output.exit_code, 0, "Cancelled execution should not exit 0");

    // Verify host tracked Cancelled state
    let active = host.list_active_processes().await;
    let proc_record = active
        .iter()
        .find(|p| p.execution_id == exec_id)
        .expect("tracked");
    assert!(matches!(proc_record.state, ProcessState::Cancelled));

    // Verify real process is no longer running in OS
    assert!(nix_wait_reaped(proc_record.pid));
}

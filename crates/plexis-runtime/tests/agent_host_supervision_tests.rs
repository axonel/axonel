//! Agent Host Supervision and Failure Recovery Tests
//!
//! Verifies process-group supervision, timeout enforcement, process crash handling,
//! cancellation signaling, workspace confinement security, and environment scrubbing.

use std::fs;
use std::process::Command as StdCommand;
use std::time::Duration;
use tempfile::tempdir;

use plexis_core::ids::{AgentId, ExecutionId};
use plexis_core::protocol::ExecutionRequest;
use plexis_runtime::agent_host::security::{EnvironmentScrubber, WorkspaceValidator};
use plexis_runtime::agent_host::LocalAgentHost;
use plexis_runtime::error::RuntimeError;

fn setup_git_repo(dir: &std::path::Path) {
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"supervision_test\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    fs::write(
        dir.join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
    )
    .unwrap();

    let _ = StdCommand::new("git")
        .args(["init"])
        .current_dir(dir)
        .output();
    let _ = StdCommand::new("git")
        .args(["config", "user.name", "Host Tester"])
        .current_dir(dir)
        .output();
    let _ = StdCommand::new("git")
        .args(["config", "user.email", "host-tester@sentinel.local"])
        .current_dir(dir)
        .output();
    let _ = StdCommand::new("git")
        .args(["add", "-A"])
        .current_dir(dir)
        .output();
    let _ = StdCommand::new("git")
        .args(["commit", "-m", "Initial commit"])
        .current_dir(dir)
        .output();
}

#[tokio::test]
async fn test_process_lifecycle_clean_exit() {
    let dir = tempdir().unwrap();
    setup_git_repo(dir.path());

    let host = LocalAgentHost::with_default_binary();
    let exec_id = ExecutionId::new();
    let agent_id = AgentId::new();

    let mut request = ExecutionRequest::new(
        exec_id,
        agent_id,
        "developer",
        "Add multiply function to src/lib.rs and run tests",
        dir.path().to_path_buf(),
    );
    request.timeout_secs = 30;

    let (tx, mut rx) = tokio::sync::mpsc::channel(64);
    let event_reader = tokio::spawn(async move {
        let mut events = Vec::new();
        while let Some(evt) = rx.recv().await {
            events.push(evt);
        }
        events
    });

    let outcome = host
        .spawn_execution(request, Some(tx))
        .await
        .expect("execution succeeded");
    let events = event_reader.await.unwrap();

    assert!(outcome.success, "Outcome should be successful");
    assert_eq!(outcome.exit_code, 0, "Exit code must be 0");
    assert!(outcome.commit_sha.is_some(), "Commit SHA must be produced");
    assert!(
        !outcome.changed_files.is_empty(),
        "Changed files should not be empty"
    );

    // Verify events were streamed
    assert!(
        !events.is_empty(),
        "Streamed execution events should be recorded"
    );
}

#[tokio::test]
async fn test_process_non_zero_exit() {
    let dir = tempdir().unwrap();
    setup_git_repo(dir.path());

    let host = LocalAgentHost::with_default_binary();
    let exec_id = ExecutionId::new();
    let agent_id = AgentId::new();

    let mut request = ExecutionRequest::new(
        exec_id,
        agent_id,
        "tester",
        "Simulate non-zero exit",
        dir.path().to_path_buf(),
    );
    request.timeout_secs = 10;
    request.failure_mode = Some("non_zero_exit".into());

    let outcome = host
        .spawn_execution(request, None)
        .await
        .expect("spawn returns result");

    assert!(
        !outcome.success,
        "Outcome must report failure for non-zero exit"
    );
    assert_eq!(outcome.exit_code, 1, "Exit code must match 1");
    assert!(
        outcome
            .failure_reason
            .as_deref()
            .unwrap_or("")
            .contains("Simulated intentional agent failure"),
        "Failure reason should reflect deliberate error: {:?}",
        outcome.failure_reason
    );
}

#[tokio::test]
async fn test_process_crash_handling() {
    let dir = tempdir().unwrap();
    setup_git_repo(dir.path());

    let host = LocalAgentHost::with_default_binary();
    let exec_id = ExecutionId::new();
    let agent_id = AgentId::new();

    let mut request = ExecutionRequest::new(
        exec_id,
        agent_id,
        "tester",
        "Simulate process crash panic",
        dir.path().to_path_buf(),
    );
    request.timeout_secs = 10;
    request.failure_mode = Some("crash".into());

    let outcome = host
        .spawn_execution(request, None)
        .await
        .expect("spawn handles crash without panicking runtime");

    assert!(
        !outcome.success,
        "Outcome must report failure for crashed process"
    );
    assert_ne!(outcome.exit_code, 0, "Exit code must not be 0");
}

#[tokio::test]
async fn test_process_timeout_and_orphan_cleanup() {
    let dir = tempdir().unwrap();
    setup_git_repo(dir.path());

    let host = LocalAgentHost::with_default_binary();
    let exec_id = ExecutionId::new();
    let agent_id = AgentId::new();

    let mut request = ExecutionRequest::new(
        exec_id,
        agent_id,
        "tester",
        "Hang to test timeout enforcement",
        dir.path().to_path_buf(),
    );
    request.timeout_secs = 1; // 1 second timeout
    request.failure_mode = Some("hang".into());

    let outcome = host
        .spawn_execution(request, None)
        .await
        .expect("spawn execution handles timeout");

    assert!(
        !outcome.success,
        "Timed out process must report failure outcome"
    );
    assert_eq!(
        outcome.exit_code, 124,
        "Standard POSIX timeout exit code is 124"
    );
    assert!(
        outcome
            .failure_reason
            .as_deref()
            .unwrap_or("")
            .contains("timed out"),
        "Failure reason should mention timeout: {:?}",
        outcome.failure_reason
    );

    // Give kernel a brief moment to reap
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Verify no orphaned plexis-fake-agent process is hanging around
    #[cfg(unix)]
    {
        let check = StdCommand::new("pgrep")
            .args(["-f", "plexis-fake-agent.*hang"])
            .output();
        if let Ok(out) = check {
            let pids = String::from_utf8_lossy(&out.stdout);
            assert!(
                pids.trim().is_empty(),
                "No hanging plexis-fake-agent processes should survive timeout: {}",
                pids
            );
        }
    }
}

#[tokio::test]
async fn test_process_cancellation_and_orphan_cleanup() {
    let dir = tempdir().unwrap();
    setup_git_repo(dir.path());

    let host = std::sync::Arc::new(LocalAgentHost::with_default_binary());
    let exec_id = ExecutionId::new();
    let agent_id = AgentId::new();

    let mut request = ExecutionRequest::new(
        exec_id,
        agent_id,
        "tester",
        "Long running task for cancellation",
        dir.path().to_path_buf(),
    );
    request.timeout_secs = 30;
    // Delay 10 seconds so it is in flight when cancellation arrives
    request.delay_ms = Some(10000);

    let host_clone = host.clone();
    let spawn_handle = tokio::spawn(async move { host_clone.spawn_execution(request, None).await });

    // Wait until process has spawned and registered
    let mut started = false;
    for _ in 0..20 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        let procs = host.list_active_processes().await;
        if procs.iter().any(|p| p.execution_id == exec_id) {
            started = true;
            break;
        }
    }
    assert!(started, "Process should have spawned and registered");

    // Cancel the execution
    let cancel_res = host.cancel_execution(&exec_id).await;
    assert!(
        cancel_res.is_ok(),
        "Cancellation should succeed: {:?}",
        cancel_res
    );

    // Await child termination
    let outcome = spawn_handle
        .await
        .unwrap()
        .expect("execution result returned");
    assert!(
        !outcome.success,
        "Cancelled process should not report success"
    );

    // Give kernel a moment to reap
    tokio::time::sleep(Duration::from_millis(200)).await;

    // Verify process group was cleanly terminated
    #[cfg(unix)]
    {
        let check = StdCommand::new("pgrep")
            .args(["-f", "plexis-fake-agent.*Long running task"])
            .output();
        if let Ok(out) = check {
            let pids = String::from_utf8_lossy(&out.stdout);
            assert!(
                pids.trim().is_empty(),
                "No cancelled plexis-fake-agent processes should survive: {}",
                pids
            );
        }
    }
}

#[tokio::test]
async fn test_workspace_confinement_security() {
    // 1. Root directory must be rejected
    let root_path = std::path::PathBuf::from("/");
    let res = WorkspaceValidator::validate_and_canonicalize(&root_path);
    assert!(
        matches!(res, Err(RuntimeError::Security(_))),
        "Root directory must be rejected with Security error: {:?}",
        res
    );

    // 2. Restricted system directories must be rejected
    let etc_path = std::path::PathBuf::from("/etc");
    if etc_path.exists() {
        let res_etc = WorkspaceValidator::validate_and_canonicalize(&etc_path);
        assert!(
            matches!(res_etc, Err(RuntimeError::Security(_))),
            "/etc directory must be rejected with Security error: {:?}",
            res_etc
        );
    }

    // 3. Non-existent path must be rejected
    let non_existent = std::path::PathBuf::from("/tmp/plexis_non_existent_dir_99999");
    let res_non_exist = WorkspaceValidator::validate_and_canonicalize(&non_existent);
    assert!(
        matches!(res_non_exist, Err(RuntimeError::InvalidCommand(_))),
        "Non-existent workspace must be rejected with InvalidCommand error: {:?}",
        res_non_exist
    );
}

#[tokio::test]
async fn test_environment_sanitization_security() {
    // Set sensitive host environment variables
    std::env::set_var("TEST_SECRET_API_KEY", "sk-live-secret-never-leak-12345");
    std::env::set_var("TEST_GITHUB_TOKEN", "ghp_super_secret_token");
    std::env::set_var("TEST_DB_PASSWORD", "super_secret_db_pass");

    let custom_vars = std::collections::HashMap::new();
    let workspace = std::path::PathBuf::from("/tmp");

    let scrubbed =
        EnvironmentScrubber::prepare_child_environment(&custom_vars, "exec-test-123", &workspace);

    assert!(
        !scrubbed.contains_key("TEST_SECRET_API_KEY"),
        "Secret API key must be scrubbed from child environment"
    );
    assert!(
        !scrubbed.contains_key("TEST_GITHUB_TOKEN"),
        "GitHub token must be scrubbed from child environment"
    );
    assert!(
        !scrubbed.contains_key("TEST_DB_PASSWORD"),
        "DB password must be scrubbed from child environment"
    );

    // Safe variables must remain present
    assert!(
        scrubbed.contains_key("PATH") || scrubbed.contains_key("Path"),
        "PATH must be preserved for executable resolution"
    );
    assert_eq!(
        scrubbed.get("PLEXIS_EXECUTION_ID"),
        Some(&"exec-test-123".to_string()),
        "PLEXIS_EXECUTION_ID must be injected into child environment"
    );
}

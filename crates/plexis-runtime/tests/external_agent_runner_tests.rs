//! External Agent Runner Integration Tests
//!
//! Verifies that AgentRunner seamlessly delegates task execution to external
//! agent processes (plexis-fake-agent via FakeAgentBackend) across the process boundary,
//! streams output, captures Git commits, runs verifications, and recovers from failures.

use std::fs;
use std::process::Command as StdCommand;
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

use plexis_core::state::{AgentState, TaskState};
use plexis_core::{Agent, Command, CommandTarget, CommandType, ExecutionProfile, Task, Workflow};
use plexis_runtime::agent_host::LocalAgentHost;
use plexis_runtime::backend::FakeAgentBackend;
use plexis_runtime::recovery::RecoveryController;
use plexis_runtime::runner::AgentRunner;
use plexis_runtime::verifier::WorkspaceVerifier;
use plexis_storage::traits::{AgentStore, CommandStore, SessionStore, TaskStore, WorkflowStore};
use plexis_storage::SqliteStore;

use plexis_tools::ToolRegistry;

fn setup_test_workload(dir: &std::path::Path) {
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"calc_lib\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    fs::write(
        dir.join("src/lib.rs"),
        "pub fn compute(a: i32, b: i32) -> i32 { a + b }\n",
    )
    .unwrap();

    // Initialize git repository
    let _ = StdCommand::new("git")
        .args(["init"])
        .current_dir(dir)
        .output();
    let _ = StdCommand::new("git")
        .args(["config", "user.name", "Plexis Tester"])
        .current_dir(dir)
        .output();
    let _ = StdCommand::new("git")
        .args(["config", "user.email", "tester@sentinel.local"])
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
async fn test_external_agent_runner_end_to_end() {
    let temp = tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    setup_test_workload(&repo_dir);

    let db_path = temp.path().join("test_ext_runner.db");
    let store = Arc::new(SqliteStore::open(db_path.to_str().unwrap()).unwrap());

    let wf = Workflow::new(
        "Test External Agent Workflow",
        "Verify external agent backend",
    );
    store.create_workflow(&wf).await.unwrap();

    let mut agent = Agent::new(
        "External Developer Agent",
        "Developer",
        ExecutionProfile::new("fake_agent", "default"),
    );
    agent.configuration = serde_json::json!({
        "execution_mode": "external_agent",
        "backend": "fake_agent",
    });
    store.create_agent(&agent).await.unwrap();

    // Create session pointing to workload repo
    let mut session = plexis_core::Session::new(agent.id);
    session.working_directory = Some(repo_dir.to_string_lossy().to_string());
    store.create_session(&session).await.unwrap();

    let mut task = Task::new(wf.id, "Fix negative modulo bug in calc_lib");
    task.metadata = serde_json::json!({
        "execution_mode": "external_agent",
        "backend": "fake_agent",
    });
    store.create_task(&task).await.unwrap();

    // Setup AgentRunner with FakeAgentBackend
    let host = Arc::new(LocalAgentHost::with_default_binary());
    let backend = Arc::new(FakeAgentBackend::new(host));

    let verifier = Arc::new(WorkspaceVerifier::new(store.clone()));
    let recovery = Arc::new(RecoveryController::new(store.clone(), 3));

    let streamed_lines = Arc::new(Mutex::new(Vec::new()));
    let streamed_lines_cb = streamed_lines.clone();

    let mut runner = AgentRunner::new(store.clone(), ToolRegistry::new(), verifier)
        .with_recovery_controller(recovery)
        .with_terminal_callback(Arc::new(move |_task_id, stream, line| {
            streamed_lines_cb
                .lock()
                .unwrap()
                .push(format!("[{}] {}", stream, line));
        }));
    runner.register_backend(backend);

    // Create and execute command
    let cmd = Command::new(
        CommandTarget::Agent(agent.id),
        CommandType::ExecuteTask,
        serde_json::json!({
            "task_id": task.id.to_string(),
            "agent_id": agent.id.to_string(),
            "workflow_id": wf.id.to_string(),
        }),
        format!("cmd-{}", task.id),
    );
    store.enqueue_command(&cmd).await.unwrap();

    let execution = runner.execute_command(&cmd).await.expect("execute_command");
    if execution.state != plexis_core::state::ExecutionState::Completed {
        panic!("Execution failed with error: {:?}", execution.error_message);
    }
    assert_eq!(
        execution.state,
        plexis_core::state::ExecutionState::Completed
    );

    // Verify metadata recorded
    assert_eq!(
        execution.metadata.get("backend").and_then(|v| v.as_str()),
        Some("fake_agent")
    );
    assert_eq!(
        execution.metadata.get("exit_code").and_then(|v| v.as_i64()),
        Some(0)
    );

    let commit_sha = execution
        .metadata
        .get("commit_sha")
        .and_then(|v| v.as_str());
    assert!(commit_sha.is_some(), "Commit SHA should be recorded");

    // Verify git commit exists in git log
    let git_log = StdCommand::new("git")
        .args(["log", "--oneline", "-n", "1"])
        .current_dir(&repo_dir)
        .output()
        .expect("git log");
    let log_str = String::from_utf8_lossy(&git_log.stdout);
    assert!(
        log_str.contains("feat(calc): fix negative modulo arithmetic"),
        "Git log should contain autonomous agent commit, got: {}",
        log_str
    );

    // Verify streamed output was captured by terminal callback
    let lines = streamed_lines.lock().unwrap().clone();
    assert!(!lines.is_empty(), "Terminal lines should be streamed");
    assert!(
        lines.iter().any(|l| l.contains("plexis-fake-agent")),
        "Streamed output should contain agent log lines"
    );

    // Verify agent is returned to Idle state
    let updated_agent = store.get_agent(&agent.id).await.unwrap().unwrap();
    assert_eq!(updated_agent.state, AgentState::Idle);
    assert!(updated_agent.current_execution_id.is_none());
}

#[tokio::test]
async fn test_external_agent_runner_crash_recovery() {
    let temp = tempdir().unwrap();
    let repo_dir = temp.path().join("repo");
    fs::create_dir_all(&repo_dir).unwrap();
    setup_test_workload(&repo_dir);

    let db_path = temp.path().join("test_crash_recovery.db");
    let store = Arc::new(SqliteStore::open(db_path.to_str().unwrap()).unwrap());

    let wf = Workflow::new("Crash Test Workflow", "Test crash recovery");
    store.create_workflow(&wf).await.unwrap();

    let mut agent = Agent::new(
        "Crashing Agent",
        "Developer",
        ExecutionProfile::new("fake_agent", "default"),
    );
    agent.configuration = serde_json::json!({
        "execution_mode": "external_agent",
        "backend": "fake_agent",
    });
    store.create_agent(&agent).await.unwrap();

    let mut session = plexis_core::Session::new(agent.id);
    session.working_directory = Some(repo_dir.to_string_lossy().to_string());
    store.create_session(&session).await.unwrap();

    let mut task = Task::new(wf.id, "Objective that causes crash");
    task.metadata = serde_json::json!({
        "execution_mode": "external_agent",
        "backend": "fake_agent",
        "failure_mode": "crash",
        "timeout_secs": 10,
    });
    store.create_task(&task).await.unwrap();

    let host = Arc::new(LocalAgentHost::with_default_binary());
    let backend = Arc::new(FakeAgentBackend::new(host));

    let verifier = Arc::new(WorkspaceVerifier::new(store.clone()));
    let recovery = Arc::new(RecoveryController::new(store.clone(), 3));

    let mut runner = AgentRunner::new(store.clone(), ToolRegistry::new(), verifier)
        .with_recovery_controller(recovery);
    runner.register_backend(backend);

    let cmd = Command::new(
        CommandTarget::Agent(agent.id),
        CommandType::ExecuteTask,
        serde_json::json!({
            "task_id": task.id.to_string(),
            "agent_id": agent.id.to_string(),
            "workflow_id": wf.id.to_string(),
        }),
        format!("cmd-crash-{}", task.id),
    );
    store.enqueue_command(&cmd).await.unwrap();

    let execution = runner.execute_command(&cmd).await.expect("execute_command");
    assert_eq!(execution.state, plexis_core::state::ExecutionState::Failed);

    // Verify recovery controller diagnosed and recovered the task to Ready
    let updated_task = store.get_task(&task.id).await.unwrap().unwrap();
    assert_eq!(updated_task.state, TaskState::Ready);
    assert!(
        updated_task.metadata.get("recovery_advice").is_some(),
        "Recovery advice should be recorded"
    );
}

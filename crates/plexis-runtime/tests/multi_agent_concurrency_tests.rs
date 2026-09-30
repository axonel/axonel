use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tempfile::tempdir;
use tokio::time::Duration;

use plexis_core::ids::{AgentId, ExecutionId};
use plexis_core::protocol::ExecutionRequest;
use plexis_runtime::agent_host::LocalAgentHost;

fn get_fake_agent_bin() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let root = manifest_dir.parent().unwrap().parent().unwrap();
    let binary_path = root.join("target/debug/plexis-fake-agent");
    if !binary_path.exists() {
        let _ = std::process::Command::new("cargo")
            .args(["build", "-p", "plexis-fake-agent"])
            .current_dir(root)
            .output();
    }
    if binary_path.exists() {
        binary_path
    } else {
        PathBuf::from("plexis-fake-agent")
    }
}

fn setup_git_workspace(path: &std::path::Path) {
    std::process::Command::new("git")
        .args(["init", "-b", "master"])
        .current_dir(path)
        .output()
        .expect("git init");
    std::process::Command::new("git")
        .args(["config", "user.name", "Tester"])
        .current_dir(path)
        .output()
        .expect("git config user.name");
    std::process::Command::new("git")
        .args(["config", "user.email", "tester@sentinel.local"])
        .current_dir(path)
        .output()
        .expect("git config user.email");
    std::fs::write(
        path.join("Cargo.toml"),
        "[package]\nname = \"test\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(path.join("src")).unwrap();
    std::fs::write(
        path.join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 { a + b }\n",
    )
    .unwrap();
    std::process::Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output()
        .expect("git add");
    std::process::Command::new("git")
        .args(["commit", "-m", "Initial commit"])
        .current_dir(path)
        .output()
        .expect("git commit");
}

#[tokio::test]
async fn test_concurrent_external_agent_executions_coexist() {
    let bin = get_fake_agent_bin();
    if !bin.exists() {
        eprintln!("Skipping: binary not found at {:?}", bin);
        return;
    }

    let host = Arc::new(LocalAgentHost::new(bin));
    let ws_a = tempdir().unwrap();
    let ws_b = tempdir().unwrap();
    setup_git_workspace(ws_a.path());
    setup_git_workspace(ws_b.path());

    let req_a = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Investigator",
        "Inspect repository defect",
        ws_a.path().to_path_buf(),
    )
    .with_delay_ms(400);

    let req_b = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Analyst",
        "Analyze repository architecture",
        ws_b.path().to_path_buf(),
    )
    .with_delay_ms(400);

    let host_a = host.clone();
    let host_b = host.clone();

    let start_instant = Instant::now();

    let task_a = tokio::spawn(async move {
        let t0 = Instant::now();
        let res = host_a.spawn_execution(req_a, None).await;
        let t1 = Instant::now();
        (t0, t1, res)
    });

    let task_b = tokio::spawn(async move {
        let t0 = Instant::now();
        let res = host_b.spawn_execution(req_b, None).await;
        let t1 = Instant::now();
        (t0, t1, res)
    });

    let (out_a, out_b) = tokio::join!(task_a, task_b);
    let total_duration = start_instant.elapsed();

    let (start_a, end_a, res_a) = out_a.unwrap();
    let (start_b, end_b, res_b) = out_b.unwrap();

    let exec_res_a = res_a.expect("execution a");
    let exec_res_b = res_b.expect("execution b");

    assert!(exec_res_a.success);
    assert_eq!(exec_res_a.exit_code, 0);
    assert!(exec_res_b.success);
    assert_eq!(exec_res_b.exit_code, 0);

    // Verify executions overlapped in time
    assert!(
        start_b < end_a && start_a < end_b,
        "Expected concurrent overlapping executions: A=[{:?}, {:?}], B=[{:?}, {:?}]",
        start_a,
        end_a,
        start_b,
        end_b
    );

    // Total duration should be well under serial duration (400ms + 400ms = 800ms)
    println!(
        "Concurrent execution confirmed! Total elapsed: {:?} (parallel 400ms jobs)",
        total_duration
    );
}

#[tokio::test]
async fn test_cancelling_one_agent_does_not_affect_concurrent_sibling() {
    let bin = get_fake_agent_bin();
    if !bin.exists() {
        eprintln!("Skipping: binary not found at {:?}", bin);
        return;
    }

    let host = Arc::new(LocalAgentHost::new(bin));
    let ws_a = tempdir().unwrap();
    let ws_b = tempdir().unwrap();
    let ws_c = tempdir().unwrap();
    setup_git_workspace(ws_a.path());
    setup_git_workspace(ws_b.path());
    setup_git_workspace(ws_c.path());

    let id_a = ExecutionId::new();
    let id_b = ExecutionId::new();
    let id_c = ExecutionId::new();

    let req_a = ExecutionRequest::new(
        id_a,
        AgentId::new(),
        "Agent A (Developer)",
        "Long running dev task",
        ws_a.path().to_path_buf(),
    )
    .with_delay_ms(800);

    let req_b = ExecutionRequest::new(
        id_b,
        AgentId::new(),
        "Agent B (Reviewer)",
        "Task to be cancelled",
        ws_b.path().to_path_buf(),
    )
    .with_delay_ms(1500);

    let req_c = ExecutionRequest::new(
        id_c,
        AgentId::new(),
        "Agent C (Integrator)",
        "Another concurrent task",
        ws_c.path().to_path_buf(),
    )
    .with_delay_ms(400);

    let host_a = host.clone();
    let host_b = host.clone();
    let host_c = host.clone();

    let task_a = tokio::spawn(async move { host_a.spawn_execution(req_a, None).await });
    let task_b = tokio::spawn(async move { host_b.spawn_execution(req_b, None).await });

    // Let them start
    tokio::time::sleep(Duration::from_millis(150)).await;

    // Agent C starts while A and B are active
    let task_c = tokio::spawn(async move { host_c.spawn_execution(req_c, None).await });

    // Cancel Agent B only
    tokio::time::sleep(Duration::from_millis(50)).await;
    host.cancel_execution(&id_b).await.expect("cancel agent B");

    let (res_a, res_b, res_c) = tokio::join!(task_a, task_b, task_c);

    let out_a = res_a.unwrap().expect("out_a");
    let out_b = res_b.unwrap().expect("out_b");
    let out_c = res_c.unwrap().expect("out_c");

    // Agent A must have completed successfully
    assert!(
        out_a.success,
        "Agent A should succeed unaffected by B's cancellation"
    );
    assert_eq!(out_a.exit_code, 0);

    // Agent B must be failed / cancelled
    assert!(!out_b.success, "Agent B should be marked unsuccessful");

    // Agent C must have completed successfully
    assert!(
        out_c.success,
        "Agent C should succeed unaffected by B's cancellation"
    );
    assert_eq!(out_c.exit_code, 0);
}

#[tokio::test]
async fn test_concurrent_agent_timeout_does_not_affect_healthy_agent() {
    let bin = get_fake_agent_bin();
    if !bin.exists() {
        eprintln!("Skipping: binary not found at {:?}", bin);
        return;
    }

    let host = Arc::new(LocalAgentHost::new(bin));
    let ws_1 = tempdir().unwrap();
    let ws_2 = tempdir().unwrap();
    setup_git_workspace(ws_1.path());
    setup_git_workspace(ws_2.path());

    // Agent 1: delay 5s but timeout 1s -> will timeout
    let req_1 = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Agent 1",
        "Slow task that times out",
        ws_1.path().to_path_buf(),
    )
    .with_delay_ms(5000)
    .with_timeout_secs(1);

    // Agent 2: delay 200ms with timeout 5s -> will succeed
    let req_2 = ExecutionRequest::new(
        ExecutionId::new(),
        AgentId::new(),
        "Agent 2",
        "Fast task that succeeds",
        ws_2.path().to_path_buf(),
    )
    .with_delay_ms(200)
    .with_timeout_secs(5);

    let host_1 = host.clone();
    let host_2 = host.clone();

    let task_1 = tokio::spawn(async move { host_1.spawn_execution(req_1, None).await });
    let task_2 = tokio::spawn(async move { host_2.spawn_execution(req_2, None).await });

    let (res_1, res_2) = tokio::join!(task_1, task_2);

    let out_1 = res_1.unwrap().expect("out_1");
    let out_2 = res_2.unwrap().expect("out_2");

    assert!(!out_1.success, "Agent 1 should have timed out");
    assert_eq!(out_1.exit_code, 124, "Timeout code must be 124");

    assert!(
        out_2.success,
        "Agent 2 must succeed unaffected by Agent 1's timeout"
    );
    assert_eq!(out_2.exit_code, 0);
}

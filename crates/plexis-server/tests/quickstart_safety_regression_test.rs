use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use std::process::Command;
use tempfile::tempdir;
use tower::ServiceExt;

use plexis_server::{create_router, AppState};
use plexis_storage::SqliteStore;

fn setup_repo(dir: &std::path::Path) -> String {
    let run = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {:?}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    };

    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Test User"]);
    run(&["config", "user.email", "test@sentinel.local"]);

    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    )
    .unwrap();
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("src/lib.rs"),
        "pub fn hello() -> &'static str { \"hello\" }\n",
    )
    .unwrap();
    run(&["add", "Cargo.toml", "src/lib.rs"]);
    run(&["commit", "-m", "Initial baseline commit"]);

    let head_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .unwrap();
    String::from_utf8_lossy(&head_out.stdout).trim().to_string()
}

#[tokio::test]
async fn test_quickstart_never_commits_to_main_or_sweeps_untracked() {
    let temp_repo = tempdir().unwrap();
    let initial_sha = setup_repo(temp_repo.path());

    // Create untracked files that must never be swept up by git add
    std::fs::write(temp_repo.path().join("Cargo.lock"), "# lockfile").unwrap();
    std::fs::write(temp_repo.path().join("plexis.db"), "database content").unwrap();
    std::fs::write(
        temp_repo.path().join("sentinel.db"),
        "sentinel database content",
    )
    .unwrap();
    std::fs::write(
        temp_repo.path().join("untracked.txt"),
        "sensitive local notes",
    )
    .unwrap();

    let store = SqliteStore::open_in_memory().expect("open sqlite in-memory");
    let state = AppState::new(store);
    let app = create_router(state.clone());

    // 1. Create Workspace
    let ws_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/workspaces")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "Safety Test Workspace",
                        "canonical_path": temp_repo.path().to_str().unwrap()
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ws_res.status(), StatusCode::CREATED);
    let ws_body = ws_res.into_body().collect().await.unwrap().to_bytes();
    let ws_json: serde_json::Value = serde_json::from_slice(&ws_body).unwrap();
    let ws_id = ws_json["id"].as_str().unwrap();

    // 2. Create Mission using scripted backend for deterministic testing
    let mission_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/missions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Quickstart Safety Audit",
                        "objective": "Verify no direct commits on main",
                        "workspace_id": ws_id,
                        "backend": "scripted"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mission_res.status(), StatusCode::CREATED);
    let mission_body = mission_res.into_body().collect().await.unwrap().to_bytes();
    let mission_json: serde_json::Value = serde_json::from_slice(&mission_body).unwrap();
    let mission_id = mission_json["id"].as_str().unwrap();

    // 3. Start Mission
    let start_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/missions/{mission_id}/start"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(start_res.status(), StatusCode::OK);

    // 4. Step mission through execution
    for _ in 0..10 {
        let step_res = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/v1/missions/{mission_id}/step"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        if step_res.status() != StatusCode::OK {
            break;
        }
        let step_body = step_res.into_body().collect().await.unwrap().to_bytes();
        let step_json: serde_json::Value = serde_json::from_slice(&step_body).unwrap();
        let state = step_json["state"].as_str().unwrap();
        if state == "awaiting_acceptance"
            || state == "completed"
            || state == "failed"
            || state == "needs_human"
        {
            break;
        }
    }

    // 5. Invariant Assertion: Check git repository state on main
    let head_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    let current_sha = String::from_utf8_lossy(&head_out.stdout).trim().to_string();

    assert_eq!(
        current_sha, initial_sha,
        "CRITICAL INVARIANT VIOLATION: main branch commit SHA changed before human acceptance! Initial: {}, Current: {}",
        initial_sha, current_sha
    );

    // Verify git log contains only initial commit
    let log_out = Command::new("git")
        .args(["log", "--oneline"])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    let log_str = String::from_utf8_lossy(&log_out.stdout);
    assert!(
        !log_str.contains("Plexis Agent"),
        "CRITICAL INVARIANT VIOLATION: Agent committed directly to main: {}",
        log_str
    );
    assert!(
        !log_str.contains("Sentinel Agent"),
        "CRITICAL INVARIANT VIOLATION: Agent committed directly to main: {}",
        log_str
    );

    // Verify untracked files remain untracked
    let status_out = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    let status_str = String::from_utf8_lossy(&status_out.stdout);
    assert!(
        status_str.contains("?? Cargo.lock"),
        "Cargo.lock was swept into git index!"
    );
    assert!(
        status_str.contains("?? plexis.db"),
        "plexis.db was swept into git index!"
    );
    assert!(
        status_str.contains("?? sentinel.db"),
        "sentinel.db was swept into git index!"
    );
    assert!(
        status_str.contains("?? untracked.txt"),
        "untracked.txt was swept into git index!"
    );
}

fn setup_buggy_math_repo(dir: &std::path::Path) -> String {
    let run = |args: &[&str]| {
        let out = Command::new("git")
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?} failed: {:?}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    };

    run(&["init", "-b", "main"]);
    run(&["config", "user.name", "Test User"]);
    run(&["config", "user.email", "test@sentinel.local"]);

    std::fs::write(
        dir.join("Cargo.toml"),
        "[package]\nname = \"demo_math\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(dir.join(".gitignore"), "/target\ntarget/\n").unwrap();
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(
        dir.join("src/lib.rs"),
        "pub fn add(a: i32, b: i32) -> i32 {\n    a - b // BUG: subtraction instead of addition\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn test_add() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n",
    )
    .unwrap();
    run(&["add", "Cargo.toml", ".gitignore", "src/lib.rs"]);
    run(&["commit", "-m", "Initial buggy baseline commit"]);

    let head_out = Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .unwrap();
    String::from_utf8_lossy(&head_out.stdout).trim().to_string()
}

#[tokio::test]
async fn test_adversarial_full_lifecycle_and_git_sha_tracking() {
    use plexis_core::mission::{Mission, MissionOutcome};
    use plexis_core::state::MissionState;
    use plexis_storage::traits::MissionStore;

    let temp_repo = tempdir().unwrap();
    let initial_sha = setup_buggy_math_repo(temp_repo.path());

    let store = std::sync::Arc::new(SqliteStore::open_in_memory().expect("open sqlite in-memory"));
    let state = AppState::new((*store).clone());
    let app = create_router(state.clone());

    // Helper to get HEAD SHA on main
    let get_head_sha = || {
        let out = Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(temp_repo.path())
            .output()
            .unwrap();
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    };

    // Pre-execution checkpoint
    let sha_before_execution = get_head_sha();
    assert_eq!(sha_before_execution, initial_sha);

    // Register Workspace
    let ws_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/workspaces")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "name": "Adversarial Lifecycle Workspace",
                        "canonical_path": temp_repo.path().to_str().unwrap()
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ws_res.status(), StatusCode::CREATED);
    let ws_body = ws_res.into_body().collect().await.unwrap().to_bytes();
    let ws_json: serde_json::Value = serde_json::from_slice(&ws_body).unwrap();
    let ws_id = ws_json["id"].as_str().unwrap();

    // Create Mission
    let mission_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/api/v1/missions")
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "title": "Adversarial Math Fix Mission",
                        "objective": "Fix add function in src/lib.rs to add instead of subtract so cargo test passes. Commit to git.",
                        "workspace_id": ws_id,
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mission_res.status(), StatusCode::CREATED);
    let mission_body = mission_res.into_body().collect().await.unwrap().to_bytes();
    let mission_json: serde_json::Value = serde_json::from_slice(&mission_body).unwrap();
    let mission_id = mission_json["id"].as_str().unwrap().to_string();

    // Verify initial diff is clean
    let diff_res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/missions/{mission_id}/diff"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(diff_res.status(), StatusCode::OK);

    // 2. Simulate isolated worktree execution of agent modifying tracked file
    // Create dedicated worktree branch 'agent/developer-t1'
    let branch_out = Command::new("git")
        .args(["branch", "agent/developer-t1", "main"])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    assert!(branch_out.status.success());

    // In isolated worktree: agent patches tracked src/lib.rs
    let worktree_dir = tempdir().unwrap();
    let add_wt_out = Command::new("git")
        .args([
            "worktree",
            "add",
            worktree_dir.path().to_str().unwrap(),
            "agent/developer-t1",
        ])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    assert!(add_wt_out.status.success());

    // Agent applies patch: a - b -> a + b
    let fixed_src = "pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n    #[test]\n    fn test_add() {\n        assert_eq!(add(2, 3), 5);\n    }\n}\n";
    std::fs::write(worktree_dir.path().join("src/lib.rs"), fixed_src).unwrap();

    // Untracked files in agent workspace that must never be swept into agent commits
    std::fs::write(worktree_dir.path().join("Cargo.lock"), "# lockfile").unwrap();
    std::fs::write(worktree_dir.path().join("plexis.db"), "plexis db binary").unwrap();
    std::fs::write(
        worktree_dir.path().join("sentinel.db"),
        "sentinel db binary",
    )
    .unwrap();
    std::fs::write(
        worktree_dir.path().join("arbitrary_sensitive.env"),
        "SECRET=topsecret",
    )
    .unwrap();

    // Verify agent's unit test in worktree passes
    let wt_test = Command::new("cargo")
        .args(["test", "--lib"])
        .current_dir(worktree_dir.path())
        .output()
        .unwrap();
    assert!(wt_test.status.success());

    // Agent stages and commits ONLY modified tracked file using Sentinel git tools exclusion semantics
    let wt_add = Command::new("git")
        .args(["add", "-A"])
        .current_dir(worktree_dir.path())
        .output()
        .unwrap();
    assert!(wt_add.status.success());

    let _ = Command::new("git")
        .args([
            "reset",
            "-q",
            "--",
            ":(glob)**/Cargo.lock",
            ":(glob)**/target/**",
            ":(glob)**/*.db",
            ":(glob)**/*.db-shm",
            ":(glob)**/*.db-wal",
            ":(glob)**/plexis.db*",
            ":(glob)**/sentinel.db*",
            ":(glob)**/*.env*",
            ":(glob)**/.env*",
            ":(glob)**/*.pem",
            ":(glob)**/*.key",
            ":(glob)**/*credential*",
            ":(glob)**/*secret*",
            "Cargo.lock",
            "target",
            "*.db",
            "*.db-shm",
            "*.db-wal",
            "plexis.db*",
            "sentinel.db*",
            "*.env*",
            ".env*",
        ])
        .current_dir(worktree_dir.path())
        .output();

    let wt_commit = Command::new("git")
        .args([
            "-c",
            "user.name=Sentinel Agent",
            "-c",
            "user.email=agent@sentinel.local",
            "commit",
            "-m",
            "fix(math): implement addition in src/lib.rs",
        ])
        .current_dir(worktree_dir.path())
        .output()
        .unwrap();
    assert!(wt_commit.status.success());

    let agent_commit_sha = String::from_utf8_lossy(
        &Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(worktree_dir.path())
            .output()
            .unwrap()
            .stdout,
    )
    .trim()
    .to_string();
    assert_ne!(agent_commit_sha, initial_sha);

    // Verify untracked files in worktree were NOT committed and remain untracked
    let wt_status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(worktree_dir.path())
        .output()
        .unwrap();
    let wt_status_str = String::from_utf8_lossy(&wt_status.stdout);
    assert!(
        wt_status_str.contains("?? Cargo.lock"),
        "Cargo.lock swept into agent commit!"
    );
    assert!(
        wt_status_str.contains("?? plexis.db"),
        "plexis.db swept into agent commit!"
    );
    assert!(
        wt_status_str.contains("?? sentinel.db"),
        "sentinel.db swept into agent commit!"
    );
    assert!(
        wt_status_str.contains("?? arbitrary_sensitive.env"),
        "arbitrary_sensitive.env swept into agent commit!"
    );

    // Verify commit tree contains ONLY src/lib.rs
    let tree_out = Command::new("git")
        .args([
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            &agent_commit_sha,
        ])
        .current_dir(worktree_dir.path())
        .output()
        .unwrap();
    let tree_str = String::from_utf8_lossy(&tree_out.stdout);
    assert_eq!(
        tree_str.trim(),
        "src/lib.rs",
        "Agent commit swept unrelated files!"
    );

    // Remove worktree
    let _ = Command::new("git")
        .args([
            "worktree",
            "remove",
            "--force",
            worktree_dir.path().to_str().unwrap(),
        ])
        .current_dir(temp_repo.path())
        .output();

    // 3. Independent Verification & Transition to AwaitingAcceptance
    let m_id: plexis_core::ids::MissionId = mission_id.parse().unwrap();
    let mut mission_obj: Mission = store.get_mission(&m_id).await.unwrap().unwrap();
    let _ = mission_obj.state.transition_to(MissionState::Planning);
    let _ = mission_obj.state.transition_to(MissionState::Running);
    let _ = mission_obj.state.transition_to(MissionState::Verifying);
    let _ = mission_obj
        .state
        .transition_to(MissionState::AwaitingAcceptance);
    mission_obj.latest_verified_commit = Some(agent_commit_sha.clone());
    mission_obj.final_outcome = Some(MissionOutcome {
        success: true,
        summary: "Verified by independent cargo test suite".into(),
        verified_commit_sha: Some(agent_commit_sha.clone()),
        cycles_count: 1,
        completion_reason: "Tests pass and worktree clean".into(),
    });
    store.update_mission(&mission_obj).await.unwrap();

    // 4. Invariant Check: At AwaitingAcceptance, main HEAD MUST be untouched
    let sha_at_awaiting_acceptance = get_head_sha();
    assert_eq!(
        sha_at_awaiting_acceptance, initial_sha,
        "CRITICAL INVARIANT VIOLATION: Target branch HEAD modified prior to human acceptance!"
    );

    // 5. Invariant Check: Review API endpoint reports awaiting_acceptance
    let review_res = app
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/api/v1/missions/{mission_id}/review"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(review_res.status(), StatusCode::OK);
    let review_body = review_res.into_body().collect().await.unwrap().to_bytes();
    let review_json: serde_json::Value = serde_json::from_slice(&review_body).unwrap();
    assert_eq!(review_json["status"], "awaiting_acceptance");
    assert_eq!(review_json["can_accept"], true);
    assert_eq!(review_json["can_integrate"], false);
    assert_eq!(review_json["final_commit"], agent_commit_sha);

    // 6. Adversarial Check: Attempting integration before acceptance MUST return 409 Conflict
    let premature_int_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/missions/{mission_id}/integrate"))
                .header("content-type", "application/json")
                .body(Body::from(serde_json::json!({}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(
        premature_int_res.status(),
        StatusCode::CONFLICT,
        "Premature integration prior to human acceptance must return 409 Conflict"
    );
    assert_eq!(
        get_head_sha(),
        initial_sha,
        "Premature integration attempt must not mutate main branch"
    );

    // 7. Explicit Human Acceptance (integrate: false)
    let accept_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/missions/{mission_id}/accept"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "feedback": "LGTM verified by auditor",
                        "integrate": false
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(accept_res.status(), StatusCode::OK);
    let accept_body = accept_res.into_body().collect().await.unwrap().to_bytes();
    let accept_json: serde_json::Value = serde_json::from_slice(&accept_body).unwrap();
    assert_eq!(accept_json["state"], "accepted");
    assert_eq!(accept_json["integrated"], false);

    // 8. Invariant Check: After acceptance alone (without integration), main HEAD MUST remain untouched
    let sha_after_acceptance = get_head_sha();
    assert_eq!(
        sha_after_acceptance, initial_sha,
        "CRITICAL INVARIANT VIOLATION: Acceptance alone (integrate: false) must not mutate main branch!"
    );

    // 9. Explicit Integration
    let int_res = app
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/api/v1/missions/{mission_id}/integrate"))
                .header("content-type", "application/json")
                .body(Body::from(
                    serde_json::json!({
                        "target_branch": "main",
                        "commit_message": "Merge verified addition patch"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(int_res.status(), StatusCode::OK);
    let int_body = int_res.into_body().collect().await.unwrap().to_bytes();
    let int_json: serde_json::Value = serde_json::from_slice(&int_body).unwrap();
    assert_eq!(int_json["integrated"], true);

    // 10. Invariant Check: After integration, main HEAD MUST advance to the verified commit
    let sha_after_integration = get_head_sha();
    assert_eq!(
        sha_after_integration, agent_commit_sha,
        "Target branch HEAD should advance to verified commit!"
    );
    assert_ne!(
        sha_after_integration, initial_sha,
        "Target branch HEAD should advance from initial commit!"
    );

    // 11. Verify disk repository state: cargo test now passes on main!
    let cargo_test = Command::new("cargo")
        .args(["test"])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    assert!(
        cargo_test.status.success(),
        "cargo test should pass on main after integration! Stderr: {}",
        String::from_utf8_lossy(&cargo_test.stderr)
    );

    // 12. Final hygiene verification on disk: target commit contains ONLY src/lib.rs
    let tree_main = Command::new("git")
        .args(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
        .current_dir(temp_repo.path())
        .output()
        .unwrap();
    let tree_main_str = String::from_utf8_lossy(&tree_main.stdout);
    assert_eq!(
        tree_main_str.trim(),
        "src/lib.rs",
        "Main commit contains unexpected files!"
    );

    println!("=== ADVERSARIAL RELEASE AUDIT GIT SHA PROOF ===");
    println!("SHA before execution:     {}", sha_before_execution);
    println!("SHA at AwaitingAcceptance: {}", sha_at_awaiting_acceptance);
    println!("SHA after acceptance:     {}", sha_after_acceptance);
    println!("SHA after integration:    {}", sha_after_integration);
    println!("===============================================");
}

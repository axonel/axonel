use std::fs;
use std::process::Command;
use tempfile::tempdir;

use plexis_runtime::worktree::WorktreeManager;

fn setup_test_repo() -> tempfile::TempDir {
    let dir = tempdir().expect("tempdir");
    let path = dir.path();

    Command::new("git")
        .args(["init", "-b", "master"])
        .current_dir(path)
        .output()
        .expect("git init");

    Command::new("git")
        .args(["config", "user.name", "Test User"])
        .current_dir(path)
        .output()
        .expect("git config name");

    Command::new("git")
        .args(["config", "user.email", "test@sentinel.local"])
        .current_dir(path)
        .output()
        .expect("git config email");

    fs::write(path.join("README.md"), "# Multi-Agent Test Repo\n").expect("write file");

    Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output()
        .expect("git add");

    Command::new("git")
        .args(["commit", "-m", "Initial commit"])
        .current_dir(path)
        .output()
        .expect("git commit");

    dir
}

#[test]
fn test_worktree_creation_isolation_and_integration() {
    let repo_dir = setup_test_repo();
    let mgr = WorktreeManager::new(repo_dir.path());

    // 1. Create worktree for Investigator
    let inv_wt = mgr
        .create_worktree("agent/investigator", None)
        .expect("create investigator worktree");
    assert!(inv_wt.exists());
    assert!(inv_wt.join("README.md").exists());
    assert_eq!(
        mgr.get_worktree_branch(&inv_wt),
        Some("agent/investigator".to_string())
    );

    // 2. Create worktree for Analyst (concurrently)
    let an_wt = mgr
        .create_worktree("agent/analyst", None)
        .expect("create analyst worktree");
    assert!(an_wt.exists());
    assert_eq!(
        mgr.get_worktree_branch(&an_wt),
        Some("agent/analyst".to_string())
    );

    // Verify list_worktrees sees both
    let list = mgr.list_worktrees().expect("list worktrees");
    assert!(list.iter().any(|w| w.path == inv_wt));
    assert!(list.iter().any(|w| w.path == an_wt));

    // 3. Mutate files in investigator worktree
    fs::write(
        inv_wt.join("investigator_notes.txt"),
        "Defect isolated in src/lib.rs",
    )
    .expect("write inv notes");
    Command::new("git")
        .current_dir(&inv_wt)
        .args(["add", "-A"])
        .output()
        .expect("git add");
    Command::new("git")
        .current_dir(&inv_wt)
        .args(["commit", "-m", "feat: add investigator diagnostic notes"])
        .output()
        .expect("git commit");

    // 4. Verify analyst worktree is completely isolated
    assert!(!an_wt.join("investigator_notes.txt").exists());
    assert!(!repo_dir.path().join("investigator_notes.txt").exists());

    // 5. Mutate files in analyst worktree
    fs::write(
        an_wt.join("analyst_report.txt"),
        "Architecture review complete",
    )
    .expect("write an notes");
    Command::new("git")
        .current_dir(&an_wt)
        .args(["add", "-A"])
        .output()
        .expect("git add");
    Command::new("git")
        .current_dir(&an_wt)
        .args(["commit", "-m", "feat: add architecture analyst report"])
        .output()
        .expect("git commit");

    // Verify investigator worktree does not see analyst notes
    assert!(!inv_wt.join("analyst_report.txt").exists());

    // 6. Integrate analyst branch into master
    let initial_sha = Command::new("git")
        .current_dir(repo_dir.path())
        .args(["rev-parse", "HEAD"])
        .output()
        .expect("rev-parse");
    let initial_sha_str = String::from_utf8_lossy(&initial_sha.stdout)
        .trim()
        .to_string();

    let new_sha = mgr
        .integrate_branch(
            "agent/analyst",
            "master",
            "merge: integrate analyst branch into master",
        )
        .expect("integrate branch");

    assert_ne!(new_sha, initial_sha_str);
    assert!(repo_dir.path().join("analyst_report.txt").exists());

    // 7. Clean up all worktrees
    mgr.cleanup_all().expect("cleanup all");
    let remaining = mgr.list_worktrees().expect("list worktrees");
    // Only root repo remains
    assert_eq!(remaining.len(), 1);
    assert!(!inv_wt.exists());
    assert!(!an_wt.exists());
}

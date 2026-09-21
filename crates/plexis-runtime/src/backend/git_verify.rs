//! Independent Git Provenance Verifier
//!
//! Shared, backend-agnostic Git verification used by every external coding
//! agent backend. Verifies repository status, changed files, and commits on
//! disk before and after external agent execution, rather than trusting
//! model text output.

use std::path::Path;
use std::process::Command;

use crate::error::RuntimeError;

/// Pre-execution snapshot of a Git workspace repository.
#[derive(Debug, Clone)]
pub struct GitPreState {
    pub is_git_repo: bool,
    pub head_sha: Option<String>,
    pub initial_uncommitted: Vec<String>,
}

/// Verified post-execution outcome determined directly from Git.
#[derive(Debug, Clone, Default)]
pub struct GitVerificationResult {
    pub before_sha: Option<String>,
    pub after_sha: Option<String>,
    pub commit_created: bool,
    pub commit_sha: Option<String>,
    pub commit_message: Option<String>,
    pub changed_files: Vec<String>,
    pub is_working_tree_clean: bool,
}

/// Independent Git verifier querying `git` CLI directly in the workspace.
pub struct GitVerifier;

impl GitVerifier {
    /// Takes a pre-execution snapshot of the repository.
    pub fn snapshot_pre_execution(workspace: &Path) -> GitPreState {
        let is_git_repo = workspace.join(".git").exists();
        if !is_git_repo {
            return GitPreState {
                is_git_repo: false,
                head_sha: None,
                initial_uncommitted: Vec::new(),
            };
        }

        let head_sha = Self::run_git(workspace, &["rev-parse", "HEAD"]).ok();
        let uncommitted = Self::get_uncommitted_files(workspace);

        GitPreState {
            is_git_repo: true,
            head_sha,
            initial_uncommitted: uncommitted,
        }
    }

    /// Verifies post-execution changes and Git commit provenance.
    pub fn verify_post_execution(
        workspace: &Path,
        pre_state: &GitPreState,
    ) -> Result<GitVerificationResult, RuntimeError> {
        if !pre_state.is_git_repo {
            return Ok(GitVerificationResult::default());
        }

        let after_sha = Self::run_git(workspace, &["rev-parse", "HEAD"]).ok();
        let current_uncommitted = Self::get_uncommitted_files(workspace);

        let mut changed_files = Vec::new();
        let mut commit_created = false;
        let mut commit_sha = None;
        let mut commit_message = None;

        // 1. Check if a new commit was created
        if let (Some(ref pre_sha), Some(ref post_sha)) = (&pre_state.head_sha, &after_sha) {
            if pre_sha != post_sha {
                commit_created = true;
                commit_sha = Some(post_sha.clone());

                // Read commit message
                if let Ok(msg) = Self::run_git(workspace, &["log", "-1", "--pretty=%B", post_sha]) {
                    commit_message = Some(msg.trim().to_string());
                }

                // Read files changed between commits
                if let Ok(diff_output) = Self::run_git(
                    workspace,
                    &["diff", "--name-only", &format!("{}..{}", pre_sha, post_sha)],
                ) {
                    for line in diff_output.lines() {
                        let trimmed = line.trim();
                        if !trimmed.is_empty() && !changed_files.contains(&trimmed.to_string()) {
                            changed_files.push(trimmed.to_string());
                        }
                    }
                }
            }
        }

        // 2. Add any working-tree uncommitted changes (modified/untracked)
        for f in current_uncommitted {
            if !changed_files.contains(&f) {
                changed_files.push(f);
            }
        }

        let is_clean = Self::run_git(workspace, &["status", "--porcelain"])
            .map(|out| out.trim().is_empty())
            .unwrap_or(true);

        Ok(GitVerificationResult {
            before_sha: pre_state.head_sha.clone(),
            after_sha,
            commit_created,
            commit_sha,
            commit_message,
            changed_files,
            is_working_tree_clean: is_clean,
        })
    }

    fn get_uncommitted_files(workspace: &Path) -> Vec<String> {
        let mut files = Vec::new();
        if let Ok(output) = Self::run_git(workspace, &["status", "--porcelain"]) {
            for line in output.lines() {
                let trimmed = line.trim();
                if trimmed.len() >= 3 {
                    // Git status format: " M path/to/file" or "?? path/to/file"
                    let path = trimmed[2..].trim();
                    if !path.is_empty() {
                        files.push(path.to_string());
                    }
                }
            }
        }
        files
    }

    fn run_git(workspace: &Path, args: &[&str]) -> Result<String, RuntimeError> {
        let output = Command::new("git")
            .current_dir(workspace)
            .args(args)
            .output()
            .map_err(|e| RuntimeError::Execution(format!("Failed to run git: {}", e)))?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
        } else {
            Err(RuntimeError::Execution(format!(
                "Git command failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn setup_test_git_repo(dir: &Path) {
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
            .args(["config", "user.email", "test@test.local"])
            .output()
            .expect("git config email");

        std::fs::write(dir.join("test.txt"), "hello initial\n").expect("write test.txt");
        Command::new("git")
            .current_dir(dir)
            .args(["add", "test.txt"])
            .output()
            .expect("git add");
        Command::new("git")
            .current_dir(dir)
            .args(["commit", "-m", "Initial commit"])
            .output()
            .expect("git commit");
    }

    #[test]
    fn test_git_verification_detects_commit_and_changes() {
        let dir = tempdir().expect("tempdir");
        setup_test_git_repo(dir.path());

        let pre = GitVerifier::snapshot_pre_execution(dir.path());
        assert!(pre.is_git_repo);
        assert!(pre.head_sha.is_some());

        // Simulate agent editing test.txt and committing
        std::fs::write(dir.path().join("test.txt"), "hello modified\n").expect("edit");
        Command::new("git")
            .current_dir(dir.path())
            .args(["commit", "-am", "Fix test.txt"])
            .output()
            .expect("commit");

        let post = GitVerifier::verify_post_execution(dir.path(), &pre).expect("post verification");
        assert!(post.commit_created);
        assert!(post.commit_sha.is_some());
        assert_ne!(post.before_sha, post.after_sha);
        assert_eq!(post.commit_message.as_deref(), Some("Fix test.txt"));
        assert!(post.changed_files.contains(&"test.txt".to_string()));
        assert!(post.is_working_tree_clean);
    }
}

//! Git version control tool for inspecting and recording changes in repositories.

use async_trait::async_trait;
use serde::Deserialize;
use std::process::Stdio;
use tokio::process::Command;

use crate::error::ToolError;
use crate::sandbox::{AuthorizationResult, Capability};
use crate::traits::{Tool, ToolInvocationContext, ToolOutput};

/// Tool for performing Git operations within an authorized workspace.
pub struct GitTool;

#[derive(Deserialize)]
struct GitArguments {
    action: Option<String>,
    subcommand: Option<String>,
    message: Option<String>,
    args: Option<Vec<String>>,
    max_commits: Option<usize>,
    branch: Option<String>,
    create_branch: Option<bool>,
    path: Option<String>,
    staged: Option<bool>,
}

#[async_trait]
impl Tool for GitTool {
    fn name(&self) -> &str {
        "git"
    }

    fn description(&self) -> &str {
        "Perform Git version control operations (status, diff, log, commit, checkout, branch, conflicts) within the workspace"
    }

    fn schema(&self) -> serde_json::Value {
        serde_json::json!({
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["status", "diff", "log", "commit", "checkout", "branch", "conflicts"],
                    "description": "Git subcommand to execute"
                },
                "message": {
                    "type": "string",
                    "description": "Commit message (required for 'commit' action)"
                },
                "branch": {
                    "type": "string",
                    "description": "Branch name (for 'checkout' or 'branch' action)"
                },
                "create_branch": {
                    "type": "boolean",
                    "description": "Whether to create a new branch (e.g. checkout -b)"
                },
                "max_commits": {
                    "type": "integer",
                    "description": "Maximum number of commits to list (for 'log' action, default 10)"
                },
                "staged": {
                    "type": "boolean",
                    "description": "Whether to diff staged changes"
                },
                "path": {
                    "type": "string",
                    "description": "Optional file path to scope diff"
                }
            },
            "required": ["action"]
        })
    }

    async fn execute(&self, context: &ToolInvocationContext) -> Result<ToolOutput, ToolError> {
        context.validate_confinement()?;
        let args: GitArguments = serde_json::from_value(context.arguments.clone())
            .map_err(|e| ToolError::InvalidArguments(format!("Failed to parse git args: {}", e)))?;

        let action = args
            .action
            .or(args.subcommand)
            .unwrap_or_else(|| "status".to_string());

        // Authorize Git capability
        let capability = Capability::GitOp(action.clone());
        match context.sandbox.policy.authorize(&capability) {
            AuthorizationResult::Allowed => {}
            AuthorizationResult::Denied { reason } => {
                return Err(ToolError::PermissionDenied(reason));
            }
        }

        match action.as_str() {
            "status" => {
                let output = Command::new("git")
                    .arg("status")
                    .arg("--short")
                    .current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await
                    .map_err(|e| {
                        ToolError::ExecutionFailed(format!("Failed to run git status: {}", e))
                    })?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);
                Ok(ToolOutput::process(stdout, stderr, exit_code))
            }
            "diff" => {
                let mut cmd = Command::new("git");
                cmd.arg("diff");
                if args.staged == Some(true)
                    || args
                        .args
                        .as_ref()
                        .map(|a| a.iter().any(|s| s == "--staged" || s == "--cached"))
                        .unwrap_or(false)
                {
                    cmd.arg("--staged");
                }
                if let Some(ref p) = args.path {
                    cmd.arg("--").arg(p);
                }
                cmd.current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                let output = cmd.output().await.map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to run git diff: {}", e))
                })?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);
                Ok(ToolOutput::process(stdout, stderr, exit_code))
            }
            "log" => {
                let limit = args.max_commits.unwrap_or(10);
                let output = Command::new("git")
                    .arg("log")
                    .arg(format!("-n{}", limit))
                    .arg("--oneline")
                    .current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await
                    .map_err(|e| {
                        ToolError::ExecutionFailed(format!("Failed to run git log: {}", e))
                    })?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);
                Ok(ToolOutput::process(stdout, stderr, exit_code))
            }
            "checkout" => {
                let branch_name = args
                    .branch
                    .or_else(|| {
                        args.args
                            .as_ref()
                            .and_then(|a| a.iter().rev().find(|s| !s.starts_with('-')).cloned())
                    })
                    .ok_or_else(|| {
                        ToolError::InvalidArguments("'branch' is required for 'checkout'".into())
                    })?;

                let should_create = args.create_branch == Some(true)
                    || args
                        .args
                        .as_ref()
                        .map(|a| a.iter().any(|s| s == "-b" || s == "-B"))
                        .unwrap_or(false);

                let mut cmd = Command::new("git");
                cmd.arg("checkout");
                if should_create {
                    cmd.arg("-b");
                }
                cmd.arg(&branch_name);
                cmd.current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                let output = cmd.output().await.map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to run git checkout: {}", e))
                })?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);
                Ok(ToolOutput::process(stdout, stderr, exit_code))
            }
            "branch" => {
                let mut cmd = Command::new("git");
                cmd.arg("branch");
                if let Some(ref branch_name) = args.branch {
                    cmd.arg(branch_name);
                } else if let Some(ref a) = args.args {
                    for arg in a {
                        cmd.arg(arg);
                    }
                } else {
                    cmd.arg("--list");
                }
                cmd.current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped());

                let output = cmd.output().await.map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to run git branch: {}", e))
                })?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&output.stderr).to_string();
                let exit_code = output.status.code().unwrap_or(-1);
                Ok(ToolOutput::process(stdout, stderr, exit_code))
            }
            "conflicts" | "check_conflicts" => {
                let output = Command::new("git")
                    .arg("status")
                    .arg("--porcelain")
                    .current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await
                    .map_err(|e| {
                        ToolError::ExecutionFailed(format!("Failed to check git conflicts: {}", e))
                    })?;

                let stdout = String::from_utf8_lossy(&output.stdout).to_string();
                let mut conflicted_files = Vec::new();

                for line in stdout.lines() {
                    if line.len() >= 3 {
                        let status_code = &line[0..2];
                        if matches!(status_code, "UU" | "AA" | "DD" | "AU" | "UD" | "UA" | "DU") {
                            let file = line[3..].trim();
                            conflicted_files.push(file.to_string());
                        }
                    }
                }

                let has_conflicts = !conflicted_files.is_empty();
                let message = if has_conflicts {
                    format!("Found {} conflicted file(s)", conflicted_files.len())
                } else {
                    "No merge conflicts detected".to_string()
                };

                Ok(ToolOutput {
                    data: serde_json::json!({
                        "has_conflicts": has_conflicts,
                        "conflicted_files": conflicted_files,
                        "message": message
                    }),
                    stdout: Some(message),
                    stderr: None,
                    exit_code: Some(0),
                })
            }
            "commit" => {
                let msg = args
                    .message
                    .or_else(|| {
                        args.args
                            .as_ref()
                            .and_then(|a| a.iter().rev().find(|s| !s.starts_with('-')).cloned())
                    })
                    .ok_or_else(|| {
                        ToolError::InvalidArguments("'message' is required for 'commit'".into())
                    })?;

                // Governance guard: NEVER allow direct commits to main or master
                let branch_check = Command::new("git")
                    .args(["rev-parse", "--abbrev-ref", "HEAD"])
                    .current_dir(&context.working_directory)
                    .output()
                    .await;
                if let Ok(out) = branch_check {
                    let branch_name = String::from_utf8_lossy(&out.stdout).trim().to_string();
                    if branch_name == "main" {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Direct agent commits to target branch '{}' are strictly prohibited by Sentinel safety governance. Agent mutations must occur in an isolated worktree.",
                            branch_name
                        )));
                    }
                }

                // Stage changes: stage all changes except runtime databases and state files
                let mut add_cmd = Command::new("git");
                add_cmd.current_dir(&context.working_directory);
                if let Some(path) = args.path.as_ref().filter(|p| !p.trim().is_empty()) {
                    let p = path.trim();
                    if p == "Cargo.lock"
                        || p.ends_with("/Cargo.lock")
                        || p.ends_with(".db")
                        || p.ends_with(".db-shm")
                        || p.ends_with(".db-wal")
                        || p.contains("plexis.db")
                        || p.contains("sentinel.db")
                    {
                        return Err(ToolError::ExecutionFailed(format!(
                            "Staging protected runtime file '{}' is strictly prohibited by Sentinel safety governance.",
                            p
                        )));
                    }
                    add_cmd.arg("add").arg("--").arg(p);
                } else {
                    add_cmd.args(["add", "-A"]);
                }
                let add_output = add_cmd.output().await.map_err(|e| {
                    ToolError::ExecutionFailed(format!("Failed to run git add: {}", e))
                })?;

                if !add_output.status.success() {
                    let err = String::from_utf8_lossy(&add_output.stderr).to_string();
                    return Err(ToolError::ExecutionFailed(format!(
                        "git add failed: {}",
                        err
                    )));
                }

                // Unstage protected database, lock, and sensitive credential/environment files
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
                    .current_dir(&context.working_directory)
                    .output()
                    .await;

                // git commit -m msg with explicit agent author identity
                let commit_output = Command::new("git")
                    .arg("-c")
                    .arg("user.name=Sentinel Agent")
                    .arg("-c")
                    .arg("user.email=agent@sentinel.local")
                    .arg("commit")
                    .arg("-m")
                    .arg(&msg)
                    .current_dir(&context.working_directory)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .output()
                    .await
                    .map_err(|e| {
                        ToolError::ExecutionFailed(format!("Failed to run git commit: {}", e))
                    })?;

                let stdout = String::from_utf8_lossy(&commit_output.stdout).to_string();
                let stderr = String::from_utf8_lossy(&commit_output.stderr).to_string();
                let exit_code = commit_output.status.code().unwrap_or(-1);
                Ok(ToolOutput::process(stdout, stderr, exit_code))
            }
            unknown => Err(ToolError::InvalidArguments(format!(
                "Unknown git action: '{}'",
                unknown
            ))),
        }
    }
}

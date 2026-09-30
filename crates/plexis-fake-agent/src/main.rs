//! Plexis Fake Agent
//!
//! A deterministic external coding agent OS executable for testing
//! the process boundary, protocol exchange, process group isolation,
//! timeout, cancellation, and recovery mechanisms in Plexis.

use std::fs;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Instant;

use clap::Parser;
use plexis_core::protocol::{ExecutionEvent, ExecutionRequest, ExecutionResult};
use serde_json::json;

#[derive(Parser, Debug)]
#[command(
    name = "plexis-fake-agent",
    about = "Deterministic external coding agent OS process"
)]
struct CliArgs {
    /// Read ExecutionRequest from stdin
    #[arg(long, default_value_t = true)]
    stdin: bool,

    /// Optional path to a file containing the ExecutionRequest JSON
    #[arg(long)]
    request_file: Option<PathBuf>,

    /// Override target workspace directory
    #[arg(long)]
    workspace: Option<PathBuf>,

    /// Override failure mode ("crash", "non_zero_exit", "hang", "syntax_error")
    #[arg(long)]
    failure_mode: Option<String>,

    /// Execution delay in milliseconds
    #[arg(long)]
    delay_ms: Option<u64>,
}

fn emit_event(event: &ExecutionEvent) {
    if let Ok(line) = serde_json::to_string(event) {
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", line);
        let _ = handle.flush();
    }
}

fn emit_result(result: &ExecutionResult) {
    if let Ok(line) = serde_json::to_string(result) {
        let stdout = io::stdout();
        let mut handle = stdout.lock();
        let _ = writeln!(handle, "{}", line);
        let _ = handle.flush();
    }
}

#[tokio::main]
async fn main() {
    let start_time = Instant::now();
    let args = CliArgs::parse();

    // 1. Ingest ExecutionRequest
    let mut request: ExecutionRequest = if let Some(ref path) = args.request_file {
        let content = fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("Failed to read request file {:?}: {}", path, e);
            std::process::exit(1);
        });
        serde_json::from_str(&content).unwrap_or_else(|e| {
            eprintln!("Failed to parse request JSON: {}", e);
            std::process::exit(1);
        })
    } else {
        let mut buffer = String::new();
        io::stdin().read_to_string(&mut buffer).unwrap_or_else(|e| {
            eprintln!("Failed to read ExecutionRequest from stdin: {}", e);
            std::process::exit(1);
        });
        serde_json::from_str(&buffer).unwrap_or_else(|e| {
            eprintln!("Failed to parse ExecutionRequest from stdin: {}", e);
            std::process::exit(1);
        })
    };

    // Apply CLI overrides if specified
    if let Some(ws) = args.workspace {
        request.workspace_path = ws;
    }
    if let Some(fm) = args.failure_mode {
        request.failure_mode = Some(fm);
    }
    if let Some(d) = args.delay_ms {
        request.delay_ms = Some(d);
    }

    let exec_id = request.execution_id;
    let pid = std::process::id();

    // 2. Announce process startup
    emit_event(&ExecutionEvent::started(exec_id, pid));
    emit_event(&ExecutionEvent::stdout(
        exec_id,
        format!(
            "[plexis-fake-agent] Started OS process PID {} for execution {}",
            pid, exec_id
        ),
    ));

    // 3. Handle intentional delay (for cancellation / timeout testing)
    if let Some(delay_ms) = request.delay_ms {
        emit_event(&ExecutionEvent::stdout(
            exec_id,
            format!(
                "[plexis-fake-agent] Applying configured execution delay of {}ms",
                delay_ms
            ),
        ));
        tokio::time::sleep(tokio::time::Duration::from_millis(delay_ms)).await;
    }

    // 4. Handle deliberate failure modes
    if let Some(ref mode) = request.failure_mode {
        match mode.as_str() {
            "hang" => {
                emit_event(&ExecutionEvent::warning(
                    exec_id,
                    "Deliberate hang triggered: sleeping to test timeout/cancellation",
                ));
                emit_event(&ExecutionEvent::stdout(
                    exec_id,
                    "[plexis-fake-agent] Process entering infinite wait state...",
                ));
                // Sleep for 10 minutes or until cancelled/killed
                tokio::time::sleep(tokio::time::Duration::from_secs(600)).await;
                std::process::exit(0);
            }
            "crash" => {
                emit_event(&ExecutionEvent::stderr(
                    exec_id,
                    "FATAL: Simulated process crash via abort",
                ));
                eprintln!("[plexis-fake-agent] Process terminating abruptly with exit code 139");
                std::process::exit(139);
            }
            "non_zero_exit" => {
                emit_event(&ExecutionEvent::failed(
                    exec_id,
                    "Simulated intentional agent failure",
                    Some(1),
                ));
                let duration = start_time.elapsed().as_millis() as u64;
                emit_result(&ExecutionResult::failure(
                    exec_id,
                    1,
                    "Simulated intentional agent failure",
                    duration,
                ));
                std::process::exit(1);
            }
            _ => {}
        }
    }

    // 5. Normal Autonomous Coding Flow
    let workspace = &request.workspace_path;
    emit_event(&ExecutionEvent::progress(
        exec_id,
        0.1,
        format!("Inspecting target workspace at: {}", workspace.display()),
    ));

    if !workspace.exists() {
        let err_msg = format!("Workspace does not exist: {}", workspace.display());
        emit_event(&ExecutionEvent::failed(exec_id, &err_msg, Some(2)));
        let duration = start_time.elapsed().as_millis() as u64;
        emit_result(&ExecutionResult::failure(exec_id, 2, err_msg, duration));
        std::process::exit(2);
    }

    let mut changed_files = Vec::new();
    let src_lib = workspace.join("src/lib.rs");

    // 5a. Inspect repository source
    emit_event(&ExecutionEvent::tool_action(
        exec_id,
        "filesystem",
        "inspect",
        json!({ "path": "src/lib.rs" }),
    ));

    if src_lib.exists() {
        let content = fs::read_to_string(&src_lib).unwrap_or_default();
        emit_event(&ExecutionEvent::stdout(
            exec_id,
            format!(
                "[plexis-fake-agent] Read {} ({} bytes)",
                src_lib.display(),
                content.len()
            ),
        ));
    }

    // 5b. Handle syntax_error failure mode
    if request.failure_mode.as_deref() == Some("syntax_error") {
        emit_event(&ExecutionEvent::tool_action(
            exec_id,
            "filesystem",
            "write_file",
            json!({ "path": "src/lib.rs", "cause": "deliberate_syntax_error" }),
        ));
        let bad_code = "pub fn broken_syntax( { this is invalid rust code ! }";
        let _ = fs::write(&src_lib, bad_code);
        changed_files.push("src/lib.rs".to_string());

        emit_event(&ExecutionEvent::stdout(
            exec_id,
            "[plexis-fake-agent] Injected syntax error, executing compiler test...",
        ));

        let output = Command::new("cargo")
            .args(["test", "--lib"])
            .current_dir(workspace)
            .output();

        let (exit_code, stderr_str) = match output {
            Ok(out) => (
                out.status.code().unwrap_or(1),
                String::from_utf8_lossy(&out.stderr).to_string(),
            ),
            Err(e) => (1, e.to_string()),
        };

        emit_event(&ExecutionEvent::stderr(exec_id, &stderr_str));
        emit_event(&ExecutionEvent::failed(
            exec_id,
            "Compilation failed due to syntax error",
            Some(exit_code),
        ));

        let duration = start_time.elapsed().as_millis() as u64;
        emit_result(
            &ExecutionResult::failure(
                exec_id,
                exit_code,
                "Compilation failed due to syntax error",
                duration,
            )
            .with_pid(pid),
        );
        std::process::exit(exit_code);
    }

    // Check if role is read-only or inspection (Investigator, Analyst, Reviewer)
    let role_lower = request.role.to_lowercase();
    if role_lower.contains("investigator") {
        emit_event(&ExecutionEvent::tool_action(
            exec_id,
            "analysis",
            "diagnose",
            json!({ "target": "src/lib.rs", "finding": "Comments not stripped before parsing" }),
        ));
        emit_event(&ExecutionEvent::stdout(
            exec_id,
            "[plexis-fake-agent] Investigator analysis: diagnosed root cause - comments starting with '#' are not stripped in parse_config.",
        ));
        emit_event(&ExecutionEvent::progress(
            exec_id,
            1.0,
            "Investigation completed.",
        ));
        emit_event(&ExecutionEvent::completed(exec_id));
        let duration = start_time.elapsed().as_millis() as u64;
        let summary =
            "Investigator analysis complete: diagnosed comment parsing failure in src/lib.rs"
                .to_string();
        let result =
            ExecutionResult::success(exec_id, summary, vec![], None, duration).with_pid(pid);
        emit_result(&result);
        std::process::exit(0);
    }

    if role_lower.contains("analyst") {
        emit_event(&ExecutionEvent::tool_action(
            exec_id,
            "analysis",
            "audit_tests",
            json!({ "target": "tests/config_tests.rs", "requirement": "Strip '#' comments and trim whitespace" }),
        ));
        emit_event(&ExecutionEvent::stdout(
            exec_id,
            "[plexis-fake-agent] Analyst review: verified tests assert comment stripping and trimming around key/value pairs.",
        ));
        emit_event(&ExecutionEvent::progress(
            exec_id,
            1.0,
            "Analysis completed.",
        ));
        emit_event(&ExecutionEvent::completed(exec_id));
        let duration = start_time.elapsed().as_millis() as u64;
        let summary =
            "Analyst specification complete: verified requirements in tests/config_tests.rs"
                .to_string();
        let result =
            ExecutionResult::success(exec_id, summary, vec![], None, duration).with_pid(pid);
        emit_result(&result);
        std::process::exit(0);
    }

    if role_lower.contains("reviewer") {
        emit_event(&ExecutionEvent::progress(
            exec_id,
            0.5,
            "Reviewer executing cargo test verification...",
        ));
        let test_output = Command::new("cargo")
            .args(["test"])
            .current_dir(workspace)
            .output();

        let (exit_code, stdout_str, stderr_str) = match test_output {
            Ok(out) => (
                out.status.code().unwrap_or(1),
                String::from_utf8_lossy(&out.stdout).to_string(),
                String::from_utf8_lossy(&out.stderr).to_string(),
            ),
            Err(e) => (1, String::new(), e.to_string()),
        };

        for line in stdout_str.lines().chain(stderr_str.lines()) {
            if !line.trim().is_empty() {
                emit_event(&ExecutionEvent::stdout(exec_id, line));
            }
        }

        if exit_code != 0 {
            emit_event(&ExecutionEvent::failed(
                exec_id,
                "Reviewer audit failed: cargo test failed",
                Some(exit_code),
            ));
            let duration = start_time.elapsed().as_millis() as u64;
            let result = ExecutionResult::failure(
                exec_id,
                exit_code,
                "Reviewer audit failed: cargo test failed",
                duration,
            )
            .with_pid(pid);
            emit_result(&result);
            std::process::exit(exit_code);
        }

        emit_event(&ExecutionEvent::stdout(
            exec_id,
            "[plexis-fake-agent] Reviewer audit passed: cargo test verified cleanly.",
        ));
        emit_event(&ExecutionEvent::progress(
            exec_id,
            1.0,
            "Review audit passed.",
        ));
        emit_event(&ExecutionEvent::completed(exec_id));
        let duration = start_time.elapsed().as_millis() as u64;
        let summary = "Reviewer audit complete: verified all tests pass in workspace".to_string();
        let result =
            ExecutionResult::success(exec_id, summary, vec![], None, duration).with_pid(pid);
        emit_result(&result);
        std::process::exit(0);
    }

    // 5c. Apply Real Source Code Fix
    emit_event(&ExecutionEvent::progress(
        exec_id,
        0.3,
        "Applying implementation patch...",
    ));

    let existing_src = fs::read_to_string(&src_lib).unwrap_or_default();
    let fixed_lib_code = if existing_src.contains("multiply") && existing_src.contains("a + b") {
        existing_src.replace("a + b", "a * b")
    } else if existing_src.contains("pub fn add") && existing_src.contains("a - b") {
        existing_src.replace("a - b", "a + b")
    } else if existing_src.contains("parse_config") {
        let fixed = existing_src.replace(
            "let trimmed = line.trim();\n            if trimmed.is_empty() {",
            "let stripped = line.split('#').next().unwrap_or(\"\");\n            let trimmed = stripped.trim();\n            if trimmed.is_empty() {"
        );
        if fixed != existing_src {
            fixed
        } else {
            existing_src.replace(
                "line.trim()",
                "line.split('#').next().unwrap_or(\"\").trim()",
            )
        }
    } else {
        r#"pub fn compute(a: i32, b: i32) -> i32 {
    a + b
}

/// Computes Euclidean modulo handling negative operands correctly.
pub fn modulo(a: i32, b: i32) -> i32 {
    ((a % b) + b) % b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute() {
        assert_eq!(compute(2, 3), 5);
    }

    #[test]
    fn test_modulo_positive() {
        assert_eq!(modulo(7, 3), 1);
    }

    #[test]
    fn test_modulo_negative_operands() {
        assert_eq!(modulo(-1, 5), 4);
        assert_eq!(modulo(-7, 3), 2);
    }
}
"#
        .to_string()
    };

    if let Some(parent) = src_lib.parent() {
        let _ = fs::create_dir_all(parent);
    }
    fs::write(&src_lib, &fixed_lib_code).unwrap_or_else(|e| {
        emit_event(&ExecutionEvent::failed(
            exec_id,
            format!("Failed to write {}: {}", src_lib.display(), e),
            Some(3),
        ));
        std::process::exit(3);
    });
    changed_files.push("src/lib.rs".to_string());

    emit_event(&ExecutionEvent::tool_action(
        exec_id,
        "filesystem",
        "write_file",
        json!({
            "path": "src/lib.rs",
            "bytes_written": fixed_lib_code.len()
        }),
    ));
    emit_event(&ExecutionEvent::stdout(
        exec_id,
        "[plexis-fake-agent] Successfully patched src/lib.rs with negative modulo implementation",
    ));

    // 5d. Execute Automated Test Suite via cargo test
    emit_event(&ExecutionEvent::progress(
        exec_id,
        0.6,
        "Executing automated cargo test verification...",
    ));
    emit_event(&ExecutionEvent::tool_action(
        exec_id,
        "shell",
        "exec",
        json!({ "command": "cargo test --lib" }),
    ));

    let test_output = Command::new("cargo")
        .args(["test", "--lib"])
        .current_dir(workspace)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    match test_output {
        Ok(out) => {
            let stdout_str = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr_str = String::from_utf8_lossy(&out.stderr).to_string();

            for line in stdout_str.lines() {
                if !line.trim().is_empty() {
                    emit_event(&ExecutionEvent::stdout(exec_id, line));
                }
            }
            for line in stderr_str.lines() {
                if !line.trim().is_empty() {
                    emit_event(&ExecutionEvent::stderr(exec_id, line));
                }
            }

            if !out.status.success() {
                let code = out.status.code().unwrap_or(1);
                emit_event(&ExecutionEvent::failed(
                    exec_id,
                    "Cargo test suite failed",
                    Some(code),
                ));
                let duration = start_time.elapsed().as_millis() as u64;
                emit_result(&ExecutionResult::failure(
                    exec_id,
                    code,
                    "Cargo test suite failed",
                    duration,
                ));
                std::process::exit(code);
            }
            emit_event(&ExecutionEvent::stdout(
                exec_id,
                "[plexis-fake-agent] All unit tests passed cleanly.",
            ));
        }
        Err(e) => {
            emit_event(&ExecutionEvent::warning(
                exec_id,
                format!("Could not run cargo test (skipping): {}", e),
            ));
        }
    }

    // 5e. Create Real Git Commit if inside Git repository
    emit_event(&ExecutionEvent::progress(
        exec_id,
        0.8,
        "Creating authoritative Git commit...",
    ));
    let mut commit_sha: Option<String> = None;

    if workspace.join(".git").exists() {
        // Stage modified files explicitly to avoid sweeping up untracked databases or lockfiles
        if !changed_files.is_empty() {
            let mut add_cmd = Command::new("git");
            add_cmd.arg("add");
            for f in &changed_files {
                add_cmd.arg(f);
            }
            let _ = add_cmd.current_dir(workspace).output();
        } else {
            let _ = Command::new("git")
                .args(["add", "-A"])
                .current_dir(workspace)
                .output();
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
                .current_dir(workspace)
                .output();
        }

        // Run git commit
        let commit_msg = format!(
            "feat(calc): fix negative modulo arithmetic (autonomous external agent run {})\n\nExecuted by plexis-fake-agent PID {}",
            exec_id, pid
        );
        let commit_res = Command::new("git")
            .args(["commit", "-m", &commit_msg])
            .current_dir(workspace)
            .output();

        if let Ok(out) = commit_res {
            if out.status.success() {
                // Query git rev-parse HEAD
                let rev_res = Command::new("git")
                    .args(["rev-parse", "HEAD"])
                    .current_dir(workspace)
                    .output();
                if let Ok(rev_out) = rev_res {
                    let sha = String::from_utf8_lossy(&rev_out.stdout).trim().to_string();
                    if !sha.is_empty() {
                        commit_sha = Some(sha.clone());
                        emit_event(&ExecutionEvent::tool_action(
                            exec_id,
                            "git",
                            "commit",
                            json!({ "commit_sha": sha }),
                        ));
                        emit_event(&ExecutionEvent::stdout(
                            exec_id,
                            format!("[plexis-fake-agent] Created Git commit: {}", sha),
                        ));
                    }
                }
            } else {
                emit_event(&ExecutionEvent::stdout(
                    exec_id,
                    "[plexis-fake-agent] Working tree clean, no new commit needed.",
                ));
            }
        }
    }

    // 6. Complete Execution and Output Result
    emit_event(&ExecutionEvent::progress(
        exec_id,
        1.0,
        "Objective achieved: source patched, verified, and committed.",
    ));
    emit_event(&ExecutionEvent::completed(exec_id));

    let duration = start_time.elapsed().as_millis() as u64;
    let summary = format!(
        "Plexis external fake-agent successfully resolved arithmetic modulo bug in {} and verified via cargo test",
        workspace.display()
    );

    let result = ExecutionResult::success(exec_id, summary, changed_files, commit_sha, duration)
        .with_pid(pid);
    emit_result(&result);

    std::process::exit(0);
}

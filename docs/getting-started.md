# Getting Started with Sentinel

This guide walks you through setting up Sentinel, running the supervisor daemon, and executing your first autonomous coding mission with both a real external coding agent (Google Gemini CLI) and an offline test agent.

---

## 1. Prerequisites & Installation

### System Requirements
- **OS**: Linux x86_64 (`x86_64-unknown-linux-gnu`)
- **Rust Toolchain**: Rust $\ge$ 1.88.0 (`rustup update stable`)
- **Node.js & npm**: Node.js $\ge$ 18.0, npm $\ge$ 9.0 (to build Web Dashboard assets)
- **Git**: Git $\ge$ 2.34 (with `git worktree` support)
- **Google Gemini CLI**: Optional, required for live agent missions (`gemini --version` $\ge$ 0.60.0)

### Build from Source
```bash
# 1. Clone the repository
git clone https://github.com/axonel/sentinel.git
cd sentinel

# 2. Build the Web Dashboard static assets
npm --prefix web ci
npm --prefix web run build

# 3. Compile the production release binary
cargo build --release -p plexis-server --bin sentinel

# 4. Verify installation
./target/release/sentinel --version
# Outputs: sentinel 0.1.1
```

*(Optional)* Install to your system PATH:
```bash
sudo cp target/release/sentinel /usr/local/bin/
```

---

## 2. Quickstart Safety Recommendation

> [!WARNING]
> **Always start with a disposable test repository.**
> Do not point Sentinel at an important production repository on your first run. Testing in a disposable repository lets you observe the worktree isolation, out-of-band verification, and human review gate firsthand.

---

## 3. Path A: Real Google Gemini CLI Execution

This walkthrough uses the official Google Gemini CLI to execute tool calls, repair code, and commit inside an isolated worktree.

### Step 1: Verify Gemini CLI Credentials
Ensure you have authenticated the Gemini CLI:
```bash
gemini auth login
# OR
export GEMINI_API_KEY="your-api-key"

# Quick smoke test:
gemini -m gemini-3.1-flash-lite -p "Respond only with PONG"
```

### Step 2: Create a Disposable Test Repository
Create a minimal Rust project with an intentional bug in `add()`:
```bash
mkdir -p /tmp/sentinel-demo && cd /tmp/sentinel-demo
git init -b main
git config user.name "Demo User" && git config user.email "demo@example.com"

cat << 'EOF' > Cargo.toml
[package]
name = "math_demo"
version = "0.1.0"
edition = "2021"
EOF

mkdir -p src
cat << 'EOF' > src/lib.rs
pub fn add(a: i32, b: i32) -> i32 {
    a - b // BUG: subtraction instead of addition
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn test_add() {
        assert_eq!(add(2, 3), 5);
    }
}
EOF

echo -e "/target\n" > .gitignore
git add -A && git commit -m "Initial commit with buggy add"
```

Confirm that the test fails in your target repository:
```bash
cargo test
# Fails with: assertion `left == right` failed (left: -1, right: 5)
```

### Step 3: Start the Sentinel Daemon
In a separate terminal, start the daemon:
```bash
sentinel serve
# Binds safely to 127.0.0.1:3000 (loopback default)
```

### Step 4: Register the Workspace
Register `/tmp/sentinel-demo` with the running daemon:
```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/workspaces \
  -H "Content-Type: application/json" \
  -d '{"name": "math-demo", "canonical_path": "/tmp/sentinel-demo"}'
```
*Note the returned `id` (e.g. `ws_01...`).*

### Step 5: Dispatch the Mission
Dispatch the coding task to the Gemini CLI:
```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/missions \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix math addition bug",
    "objective": "Fix the subtraction bug in src/lib.rs so that add(2, 3) equals 5. Run cargo test to verify, then commit your fix.",
    "workspace_id": "<YOUR_WORKSPACE_ID>",
    "backend": "gemini_cli",
    "stopping_condition": {
      "required_tests_pass": true,
      "working_tree_clean": true,
      "required_commit_exists": true
    },
    "auto_start": true
  }'
```
*Note the returned mission `id` (e.g. `msn_01...`).*

### Step 6: Observe Execution in the Web Dashboard
1. Open your browser to **`http://127.0.0.1:3000`**.
2. Watch the mission transition through `PLANNING` $\to$ `RUNNING` $\to$ `VERIFYING` $\to$ `READY FOR REVIEW` (`AwaitingAcceptance`).
3. Check `/tmp/sentinel-demo` on disk: `cargo test` **still fails** because the agent executed exclusively in `.plexis/worktrees/<task_id>`. Your main branch remains completely untouched.

### Step 7: Review and Accept
1. In the Web Dashboard, click **Review Package** to inspect the unified diff, changed files list, and independent test receipts.
2. Click **Accept & Integrate** in the UI, or execute via CLI:
   ```bash
   sentinel mission accept <MISSION_ID> --integrate
   ```

### Step 8: Verify the Result on Disk
```bash
cd /tmp/sentinel-demo
git log -n 1 --oneline # Shows the integrated commit from Sentinel Agent
cargo test             # test tests::test_add ... ok
```

---

## 4. Path B: Offline / Deterministic Test Execution (`fake_agent`)

If you want to test Sentinel without an external API key or without installing the Gemini CLI, use the built-in deterministic test agent:

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/missions \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Deterministic offline test",
    "objective": "Fix failing test",
    "workspace_id": "<YOUR_WORKSPACE_ID>",
    "backend": "fake_agent",
    "auto_start": true
  }'
```

The `fake_agent` mock runs locally, simulates multi-turn tool calling, edits the file in the isolated worktree, commits the fix, passes independent verification, and halts at `AwaitingAcceptance` for your review.

---

## 5. Next Steps

- 📖 **[CLI Reference](cli.md)**: Full command-line options for `sentinel`.
- 🔌 **[REST API Reference](api.md)**: Endpoints, payloads, and SSE event streaming.
- 🛡️ **[Security Model](security.md)**: Trust boundaries, process confinement, and secret redaction.
- ⚠️ **[Operational Limitations](limitations.md)**: Supported backends, platforms, and known constraints.

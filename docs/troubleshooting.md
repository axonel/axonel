# Troubleshooting Guide

This guide covers common issues, error messages, and operational resolutions when running Sentinel.

---

## 1. Server Startup & Network Issues

### "Refusing to bind to non-loopback address without auth token"

**Cause:** You configured Sentinel to bind to `0.0.0.0` or an external IP address, but did not supply an authentication token. By default, Sentinel enforces loopback-only access (`127.0.0.1`) to prevent exposing your local filesystem and agent execution engine to the local network.

**Resolution:**
- If you only need local access, omit the host flag or bind to `127.0.0.1`:
  ```bash
  sentinel serve --host 127.0.0.1 --port 3000
  ```
- If you genuinely require external network access (e.g., inside a Docker container or remote dev server), provide a secure bearer token:
  ```bash
  sentinel serve --host 0.0.0.0 --port 3000 --auth-token "your-secure-token"
  # or via environment variable:
  export SENTINEL_AUTH_TOKEN="your-secure-token"
  sentinel serve --host 0.0.0.0 --port 3000
  ```

---

### "Address already in use (os error 98 / 48)"

**Cause:** Another process is already listening on the requested port (default `3000`).

**Resolution:**
Specify an alternate port using `--port`:
```bash
sentinel serve --port 4000
```

---

## 2. Git & Worktree Issues

### "Primary working tree has uncommitted changes"

**Cause:** You attempted to integrate an accepted mission, but your active working directory contains unstaged or uncommitted changes. To protect your work from being clobbered or causing merge conflicts, Sentinel refuses to mutate the working tree.

**Resolution:**
1. Stash or commit your local working changes:
   ```bash
   git stash
   # or
   git commit -am "WIP: save current work"
   ```
2. Retry the integration:
   ```bash
   sentinel mission integrate <mission-id>
   ```
3. If you stashed changes, reapply them:
   ```bash
   git stash pop
   ```

---

### "Git worktree lock error" or "Worktree already exists"

**Cause:** A previous mission was forcefully killed (e.g. `kill -9`) before Git could clean up the worktree reference in `.git/worktrees/`.

**Resolution:**
Run Git's built-in worktree prune command:
```bash
git worktree prune
```
If a leftover directory remains in `.plexis/worktrees/<mission-id>`, you can safely remove it:
```bash
rm -rf .plexis/worktrees/<mission-id>
git worktree prune
```

---

## 3. Agent Execution & Provider Issues

### "gemini: command not found"

**Cause:** Sentinel was instructed to use the Gemini CLI adapter, but the `gemini` binary is not found in your system `$PATH`.

**Resolution:**
1. Install the official Gemini CLI following Google's installation guide.
2. Verify it is accessible in your terminal:
   ```bash
   which gemini
   gemini --version
   ```
3. For testing without installing Gemini CLI, use Sentinel's offline fake agent:
   ```bash
   cargo build -p plexis-fake-agent --bin fake_agent
   sentinel mission create ... --agent-bin "./target/debug/fake_agent"
   ```

---

### "GEMINI_API_KEY environment variable is not set"

**Cause:** The Gemini CLI requires a valid API key to communicate with Google's Gemini models.

**Resolution:**
Export your API key before launching the daemon or CLI:
```bash
export GEMINI_API_KEY="AIzaSy..."
```

---

### "Agent execution timed out after N seconds"

**Cause:** The agent exceeded the configured monotonic wall-clock timeout (`max_execution_time_secs`). Sentinel terminated the process group to prevent infinite loops.

**Resolution:**
If your task requires long-running compilations or extensive exploration, increase the timeout when creating the mission:
```bash
sentinel mission create \
  --prompt "Refactor parser module" \
  --timeout 600 \
  ...
```

---

## 4. Verification Failures

### "Verification command failed with exit code 1"

**Cause:** The agent finished editing files, but the independent physical verifier executed the stopping conditions (e.g. `cargo test`, `npm test`) and encountered test failures or compiler errors.

**Behavior:**
- Sentinel **does not** mark the mission as ready for review.
- If remaining cycles are available in the mission budget, Sentinel feeds the compiler/test error output back to the agent for self-repair.
- If the budget is exhausted, the mission transitions to `Failed`.

**Resolution:**
1. Inspect the verification output in the Web UI or via:
   ```bash
   sentinel mission get <mission-id>
   ```
2. You can create a follow-up mission with more specific prompt guidance or relax over-restrictive stopping conditions.

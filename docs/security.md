# Sentinel Security & Threat Model

**Version:** 1.0  
**Status:** Canonical Reference  
**Scope:** Sentinel Execution Engine, Daemon Control Plane, and Local Agent Host Substrate

---

## 1. Executive Summary & Philosophy

Sentinel is an **autonomous software engineering execution engine and supervisor daemon** designed to execute development tasks locally or in controlled developer environments.

Unlike SaaS agents that execute code in remote multitenant cloud environments, Sentinel operates directly on developer workstations and on-premises infrastructure. Consequently, the primary security objective of Sentinel is **containment, repository integrity, and defense against unauthorized remote exposure**.

> [!IMPORTANT]
> **Honest Positioning:**
> Sentinel provides process-group isolation and Git worktree isolation, but it **does not provide a cryptographic hardware sandbox (such as gVisor, Firecracker, or SELinux containers)** out of the box. Running arbitrary, untrusted agent prompts or malicious repositories on your host machine always carries risks.

---

## 2. Trust Boundaries & Architecture

Sentinel defines four distinct trust zones:

```text
       ┌────────────────────────────────────────────────────────┐
       │                ZONE 0: Network Clients                 │
       │   Browser UI, Developer CLI, Remote Webhook Integrators │
       └───────────────────────────┬────────────────────────────┘
                                   │  HTTP / SSE
                                   │  [Auth Bearer Token or Loopback]
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │                ZONE 1: Supervisor Daemon               │
       │   Sentinel Server (Axum), SQLite Store, FSM Engine       │
       │   - Authoritative State & Audit Event Log              │
       │   - Out-of-Band Workspace Verifier                     │
       └───────────────────────────┬────────────────────────────┘
                                   │  OS Process Spawn (PGID)
                                   │  Local Filesystem Mounts
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │           ZONE 2: Agent Subprocess Substrate           │
       │   LocalAgentHost, Gemini CLI, External Coding Agents   │
       │   - Sandboxed to dedicated Git Worktree                │
       │   - Isolated Process Group (POSIX PGID kill)           │
       └───────────────────────────┬────────────────────────────┘
                                   │  LLM Provider APIs
                                   │  HTTPS Network Outbound
                                   ▼
       ┌────────────────────────────────────────────────────────┐
       │              ZONE 3: External LLM Providers            │
       │   Google Gemini API, Anthropic, OpenAI                 │
       └────────────────────────────────────────────────────────┘
```

### Zone 0: Network Clients
- **Default Policy:** Loopback interface only (`127.0.0.1`).
- **Remote Exposure:** Binding to external network interfaces (`0.0.0.0` or physical IP) **strictly requires** an authentication bearer token via `--auth-token` or `SENTINEL_AUTH_TOKEN`. Startup unconditionally terminates with a fatal exit code if an external bind is attempted without authentication.
- **Endpoints:** All mutation and control plane APIs require valid Bearer token authentication when configured. `/api/v1/auth/status` truthfully discloses whether authentication is enforced and whether the daemon is bound to loopback.

### Zone 1: Supervisor Daemon
- Runs with the privileges of the invoking OS user.
- Maintains authoritative SQLite storage (WAL mode) for mission states, audit events, checkpoints, and leases.
- Acts as the sole gatekeeper for Git repository mutations (worktree creation, candidate commits, and target branch integration).

### Zone 2: Agent Subprocess Substrate
- External coding agents (e.g. Gemini CLI, Claude Code stubs, test agents) execute as OS child processes.
- **Process Group Isolation:** Every agent process is assigned a dedicated POSIX Process Group ID (PGID). When an execution completes, times out, or is cancelled, Sentinel sends `SIGTERM` followed by `SIGKILL` to the entire process group, terminating child shells, compilers, and leaked subprocesses.
- **Git Worktree Confinement:** Agents operate in dedicated, isolated Git worktrees located under `.plexis/worktrees/` or configured temp directories. Agents do not write directly to the primary working tree or target branch.

### Zone 3: External LLM Providers
- External agents communicate outbound via HTTPS with provider APIs (e.g., Google Cloud).
- **Data Egress:** When using external model providers, prompt text and relevant repository context (file snippets, compiler error outputs) are transmitted to the provider in accordance with the provider's terms of service and privacy settings. Sentinel does not claim "Zero Code Egress" when external providers are configured.

---

## 3. Worktree Confinement & Git Integrity

To protect the developer's primary repository from corruptions, partial edits, or broken HEAD commits:
1. **Isolated Worktrees:** All agent tool invocations (`edit`, `write`, `shell`) are directed to a clean Git worktree branched from a verified target commit.
2. **Deterministic Checkpoints:** After each cycle, Sentinel records the worktree commit SHA. If an agent loops, stalls, or introduces broken syntax, Sentinel rolls back the worktree to the last green checkpoint.
3. **Canonical Integration Gate:** A candidate commit cannot be merged into the target branch without:
   - Verification passing against configured stopping conditions (clean exit codes, passing tests).
   - Explicit human operator acceptance via `POST /api/v1/missions/{id}/accept` or `sentinel mission accept <id>`.
   - Target freshness validation (ensuring target HEAD has not drifted since verification).
   - Durable `Integrating` state recorded before invoking physical Git operations.
   - Atomic rollback to `Accepted` on Git merge conflicts or dirty primary tree errors.

---

## 4. Shell & Command Execution Risks

### Risk Analysis
Agents execute shell commands (e.g., `cargo test`, `npm test`, `pytest`) to verify fixes. A compromised agent or adversarial prompt could attempt to:
- Run destructive commands (`rm -rf /`, `mkfs`).
- Access files outside the worktree (e.g. `~/.ssh`, `~/.aws/credentials`).
- Open reverse shells or download malicious binaries.

### Mitigation Strategies in Sentinel:
1. **Directory Root Jailing (Path Normalization):**
   Built-in tool operations (file read/write) canonicalize target paths and reject any path resolving outside the workspace root.
2. **Timeout Enforcement:**
   All agent executions are constrained by monotonic wall-clock timeouts (`max_execution_time_secs`). Expired processes are killed via PGID signals.
3. **Execution Audit Log:**
   Every command dispatched to an agent is recorded with timestamps, arguments, exit codes, and stdout/stderr in the SQLite audit log.

### Limitations:
- Sentinel does **not** employ Linux `seccomp`, `chroot`, or network namespace jailing by default. If your project executes untrusted agent instructions, run Sentinel inside a Docker container, virtual machine, or dedicated cloud runner.

---

## 5. Secret Redaction & Credential Hygiene

1. **Environment Filtering:**
   Sentinel scrubs sensitive environment variables (such as `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, and `SENTINEL_AUTH_TOKEN`) before logging command payloads to the database or emitting events over SSE streams.
2. **Review Package Redaction:**
   Git diffs generated for human review packages are truncated if they exceed safety limits, and known credential patterns are masked.
3. **Local Database Permissions:**
   The SQLite database (`plexis.db`) contains operational history and audit records. Ensure file permissions restrict read access to the owning user (`chmod 600 plexis.db`).

---

## 6. Threat Matrix & Known Non-Goals

| Threat Vector | Mitigation in Sentinel | Status |
| :--- | :--- | :--- |
| **Unauthorized Remote API Access** | Mandatory bind to `127.0.0.1`; fatal exit on external bind without `--auth-token` | **Enforced** |
| **Primary Branch Corruption** | Worktree isolation + two-phase acceptance (`Accepted` -> `Integrating` -> `Integrated`) | **Enforced** |
| **Stale Integration Overwrites** | Target branch freshness validation + merge conflict abort & rollback | **Enforced** |
| **Runaway Agent Subprocesses** | POSIX Process Group ID (PGID) termination + wall-clock timeouts | **Enforced** |
| **Agent Prompt Injection** | Independent out-of-band disk verifier ignoring agent self-reports | **Enforced** |
| **Malicious Host OS Compromise** | OS user-level permissions only; no kernel-level container sandbox | **Documented Limitation** |
| **Network Egress to Cloud LLMs** | Dependent on configured agent provider; control plane is local | **Documented Truth** |

---

## 7. Reporting Security Vulnerabilities

If you discover a security vulnerability in Sentinel, please do not file a public GitHub issue. Instead, report it privately to:

- **Email:** `security@axonel.dev`
- We aim to acknowledge reports within 48 hours and provide patches within 14 days.

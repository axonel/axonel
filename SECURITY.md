# Security Policy

Sentinel takes the security and integrity of developer environments seriously. This document outlines our security model, threat boundaries, and the process for reporting vulnerabilities.

---

## 1. Reporting a Vulnerability

If you discover a security vulnerability in Sentinel, please **do not create a public issue**. Instead, report it privately:

- **Email:** `security@axonel.dev`
- **Response Target:** Initial acknowledgment within 48 hours; status updates and remediation within 14 business days.
- Include reproduction steps, environment details (OS, Rust version), and a proof-of-concept if available.

---

## 2. Security Model & Trust Boundaries

Sentinel is designed as a **local supervisor and execution control plane** for coding agents. It prioritizes workstation safety, Git repository integrity, and defense against unauthorized remote exposure.

### Trust Zones

```text
       ┌────────────────────────────────────────────────────────┐
       │                ZONE 0: Network Clients                 │
       │   Browser UI, Developer CLI, Remote Webhook Integrators │
       └───────────────────────────┬────────────────────────────┘
                                   │  HTTP / SSE
                                   │  [Bearer Token or Loopback]
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
       │   Gemini CLI, External Coding Agents, Test Agents       │
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

### Key Security Controls

1. **Loopback by Default & Forced Auth on External Interfaces:**
   - Sentinel binds exclusively to `127.0.0.1` by default.
   - Binding to external interfaces (`0.0.0.0` or a physical IP) **strictly requires** an authentication token (`--auth-token <TOKEN>` or `SENTINEL_AUTH_TOKEN`). The daemon refuses to start if external access is requested without authentication.
2. **Git Worktree Isolation:**
   - Coding agents never write directly to your working tree or target branch.
   - Agents operate in dedicated, isolated Git worktrees under `.plexis/worktrees/`. If an agent fails or corrupts a file, your primary working directory remains untouched.
3. **Independent Verification Gate:**
   - Sentinel does not trust the agent's claim of completion.
   - The supervisor independently runs verification commands (`cargo test`, `pytest`, etc.) directly against the worktree on disk before generating a review package.
4. **POSIX Process Group Termination:**
   - Agent processes are launched in their own process groups. On timeout, cancellation, or failure, signals (`SIGTERM` then `SIGKILL`) are dispatched to the entire process group to terminate child shells, compilers, and leaked processes.
5. **Two-Phase Human Acceptance:**
   - Candidate commits cannot be merged automatically. Integration requires explicit human operator acceptance via CLI or Web UI, followed by target freshness checks and atomic rollback if merge conflicts occur.

---

## 3. Explicit Boundaries & Limitations

To ensure engineering transparency, Sentinel explicitly documents what it does **not** protect against:

- **No Hardware or Kernel Sandbox:** Sentinel isolates file changes using Git worktrees and process groups. It does **not** run agents inside a cryptographic microVM (like Firecracker) or kernel-jailed container (like gVisor/Docker) by default. Agent shell commands run with the permissions of the invoking OS user.
- **Untrusted Code / Prompts:** If you run agents on untrusted prompts or malicious repositories, run Sentinel inside a dedicated container, VM, or disposable runner.
- **Cloud LLM Egress:** When configured with external providers (such as Google Gemini), repository snippets and error messages are sent outbound over HTTPS to provider APIs in accordance with their terms of service. Sentinel does not claim zero data egress when cloud LLMs are used.

For an exhaustive threat model, see [docs/security.md](docs/security.md).

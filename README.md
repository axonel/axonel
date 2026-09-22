<p align="center">
  <img src="web/public/logo.jpeg" alt="Axonel Logo" width="100" style="border-radius: 12px; margin-bottom: 12px;">
</p>

<h1 align="center">Axonel</h1>

<p align="center">
  <strong>The control plane for coding agents.</strong><br>
  Run coding agents in isolated Git worktrees, independently verify their changes, and require human approval before integration.
</p>

<p align="center">
  <a href="https://github.com/axonel/axonel/actions/workflows/ci.yml"><img src="https://github.com/axonel/axonel/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/axonel/axonel/releases/tag/v0.1.1"><img src="https://img.shields.io/badge/release-v0.1.1-brightgreen.svg" alt="Release"></a>
  <a href="https://www.rust-lang.org"><img src="https://img.shields.io/badge/rust-1.88%2B-orange.svg" alt="Rust"></a>
  <a href="https://img.shields.io/github/stars/axonel/axonel"><img src="https://img.shields.io/github/stars/axonel/axonel?style=flat&logo=github" alt="Stars"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-MIT%2FApache--2.0-blue.svg" alt="License"></a>
  <a href="docs/limitations.md"><img src="https://img.shields.io/badge/platform-Linux%20x86__64-blue.svg" alt="Platform"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> •
  <a href="#why-axonel">Why Axonel?</a> •
  <a href="#the-workflow">The Workflow</a> •
  <a href="#feature-tour">Features</a> •
  <a href="#architecture">Architecture</a> •
  <a href="#contributing">Contributing</a>
</p>

---

## What is Axonel?

Coding agents are useful, but giving an agent direct control of your working tree creates a simple problem: **the agent is both making the change and deciding whether the change is finished**.

Axonel separates those responsibilities.

It is a **local supervisor and execution control plane for coding agents**:

- **Isolate execution** in a dedicated Git worktree so the active branch and working files stay untouched.
- **Verify independently** by running tests and inspecting the resulting workspace on disk instead of trusting the agent's success message.
- **Stop for human review** at `READY FOR REVIEW` before candidate changes can be integrated.
- **Integrate deliberately** with target-freshness checks and transactional merge handling.

Axonel does not replace your coding agent. It supervises it.

## The Workflow

```text
                    AXONEL CONTROL LOOP

Task Goal
    │
    ▼
┌───────────────────┐
│ Isolated Worktree │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│   Coding Agent    │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ Verify on Disk    │ ◄──── fix & retry
│ tests + workspace │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│ READY FOR REVIEW  │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│   Human Review    │
│      + Diff       │
└─────────┬─────────┘
          │
          ▼
┌───────────────────┐
│   Safe Integrate  │
└───────────────────┘
```

The central rule is simple:

> **An agent can propose a change. Axonel verifies it. A human decides whether it gets integrated.**

## Quickstart

> **Platform:** Axonel is currently certified for Linux x86_64. See [Operational Limitations](docs/limitations.md).

### 1. Build Axonel

Requirements: Rust 1.88+, Node.js 20+, npm, and Git with worktree support.

```bash
git clone https://github.com/axonel/axonel.git
cd axonel

npm --prefix web ci
npm --prefix web run build
cargo build --release -p plexis-server --bin axonel
```

Start the local supervisor:

```bash
./target/release/axonel serve
```

The dashboard is available at:

```text
http://127.0.0.1:3000
```

### 2. Dispatch a Mission

Initialize a workspace for an existing repository:

```bash
axonel init /path/to/repo --name "my-project"
```

Then dispatch a task:

```bash
axonel mission create /path/to/repo \
  -o "Fix failing unit tests in parser.rs. Run cargo test and commit your fix." \
  -t "Fix parser tests"
```

### 3. Review and Integrate

When the stopping conditions pass, the mission halts at:

```text
READY FOR REVIEW
```

Inspect the candidate diff:

```bash
axonel mission diff <MISSION_ID>
```

Then integrate only after review:

```bash
axonel mission accept <MISSION_ID> --integrate
```

For a complete walkthrough, including a disposable repository and an offline deterministic agent, see the [Getting Started Guide](docs/getting-started.md).

---

## Why Axonel?

### Agents should not share your working directory

An autonomous agent can create, delete, or rewrite files while it works. Axonel runs mission execution inside an isolated Git worktree under `.plexis/worktrees/`.

Your active branch remains separate from the mission workspace.

### “Tests passed” should be independently verifiable

Axonel does not treat an agent's own report as the verification boundary. It independently executes configured stopping conditions such as:

```text
cargo test
npm test
pytest
```

and inspects exit status and workspace state on disk.

### Integration should be an explicit decision

A successful mission does not automatically mean code lands on your target branch.

Axonel creates a review boundary where you can inspect:

- changed files
- unified diffs
- verification results
- Git provenance
- mission audit history

Only an explicit acceptance action proceeds to integration.

### Automation needs recovery semantics

Long-running agent processes can fail, time out, or leave partial state behind. Axonel tracks durable mission state in SQLite, supervises process groups, and reconciles Git/worktree state during recovery.

See [Crash Recovery](docs/recovery.md) for the detailed state-reconciliation model.

---

## Feature Tour

### 1. Isolated Worktree Execution

Agents execute inside isolated Git worktrees. The dashboard's Executive Summary shows mission status, recent events, and verified Git provenance.

<p align="center">
  <img src="docs/readme-assets/screenshots/01-isolated-worktree.png" alt="Axonel isolated worktree execution and executive summary" width="90%">
</p>

### 2. Independent Physical Verification

Axonel runs verification out-of-band and checks the resulting workspace rather than relying on the agent's claim that the task succeeded.

<p align="center">
  <img src="docs/readme-assets/screenshots/02-independent-verification.png" alt="Axonel independent physical verification" width="90%">
</p>

### 3. Review Package and Unified Diff

Verified candidate commits stop at an explicit review gate. Inspect file statistics, unified diffs, verification metrics, and audit events before integration.

<p align="center">
  <img src="docs/readme-assets/screenshots/03-review-diff.png" alt="Axonel review package and unified diff" width="90%">
</p>

### 4. Human Acceptance Gate

The dashboard provides explicit actions for accepting and integrating, accepting without integrating, or rejecting a deliverable. Rejection feedback can feed into autonomous replanning.

<p align="center">
  <img src="docs/readme-assets/screenshots/04-human-acceptance.png" alt="Axonel human acceptance gate" width="90%">
</p>

### 5. Transactional Git Integration

Candidate commits are integrated through a stateful merge flow with target-freshness validation and rollback handling for merge conflicts.

<p align="center">
  <img src="docs/readme-assets/screenshots/05-git-integration.png" alt="Axonel Git integration state" width="90%">
</p>

### 6. Operations Dashboard

Monitor control-plane health, parallel task leases, agent activity, governance gates, and provider latency across registered workspaces.

<p align="center">
  <img src="docs/readme-assets/screenshots/06-operational-overview.png" alt="Axonel operations dashboard" width="90%">
</p>

### 7. Agent Fleet Governance

Inspect registered runtimes, roles, capabilities, active leases, execution state, assigned scope, and operator directives.

<p align="center">
  <img src="docs/readme-assets/screenshots/07-agent-fleet.png" alt="Axonel agent fleet governance" width="90%">
</p>

---

## Providers

Axonel supervises multiple agent execution paths:

| Provider / Adapter | Execution Mode | Requirements | Primary Use Case |
| :--- | :--- | :--- | :--- |
| **Gemini CLI** (`gemini`) | Subprocess (`LocalAgentHost`) | `gemini` CLI + `GEMINI_API_KEY` | Real-world autonomous coding tasks |
| **Fake Agent** (`fake`) | Subprocess (`plexis-fake-agent`) | Built-in Cargo binary | Offline testing and reproducible CI |
| **Gemini API** (`gemini-api`) | HTTP API client | `GEMINI_API_KEY` | Direct API-driven planning and synthesis |
| **OpenAI API** (`openai`) | HTTP API client | `OPENAI_API_KEY` | API-driven agent execution |
| **Ollama** (`ollama`) | HTTP API client | Local Ollama daemon | Local / air-gapped execution |

See [Provider Configuration](docs/providers.md) for setup details and custom adapter development.

---

## Architecture

Axonel is an API-first local supervisor daemon backed by SQLite (WAL mode) and POSIX process supervision.

| Layer / Crate | Purpose |
| :--- | :--- |
| **`axonel` / `plexis-server`** | Axum HTTP daemon, REST API, SSE streaming, and CLI entrypoint. |
| **`plexis-runtime`** | Worktree lifecycle, POSIX process supervision, and timeout enforcement. |
| **`plexis-storage`** | Persistent SQLite store for missions, checkpoints, and leases. |
| **`plexis-providers`** | Adapters for external coding agents. |
| **`plexis-tools`** | Filesystem tools with path canonicalization and workspace containment. |
| **`plexis-planner`** | Task breakdown and planning logic. |
| **`plexis-memory`** | Session context and history. |
| **`plexis-fake-agent`** | Deterministic mock agent for offline regression testing and CI. |
| **`web/`** | Embedded React + Vite Mission Control dashboard. |

See [System Architecture](docs/architecture.md) for the subsystem and state-machine details.

---

## Security Boundaries

Axonel is designed to constrain agent execution at the process and Git-worktree level, but it is **not a hardware sandbox**.

- **Loopback by default:** the daemon binds to `127.0.0.1`. Binding externally requires an authentication token.
- **Process-group isolation:** mission subprocesses run in dedicated POSIX process groups so cancellation and timeout handling can reap child processes.
- **Workspace containment:** filesystem operations are canonicalized and checked against the workspace boundary.
- **No microVM boundary:** Axonel does not provide Firecracker/gVisor-style hardware virtualization. Agent commands run with the permissions of the invoking OS user.
- **Current platform scope:** Linux x86_64 is the certified target.

See [Security Policy](SECURITY.md), [Threat Model](docs/security.md), and [Operational Limitations](docs/limitations.md).

---

## Documentation

| Guide | What it covers |
| :--- | :--- |
| [Getting Started](docs/getting-started.md) | Hands-on first mission with Gemini CLI or the offline fake agent |
| [CLI Reference](docs/cli.md) | Complete `axonel` command reference |
| [REST API](docs/api.md) | HTTP endpoints, request/response payloads, and SSE events |
| [Architecture](docs/architecture.md) | Crate boundaries, state machines, and supervisor internals |
| [Product Overview](docs/product.md) | Core thesis, target users, and non-goals |
| [Provider Configuration](docs/providers.md) | Provider setup and custom adapter development |
| [Crash Recovery](docs/recovery.md) | Durable state, reconciliation, and Git ancestry |
| [Validation & Receipts](docs/validation.md) | Automated validation evidence and benchmark telemetry |
| [Troubleshooting](docs/troubleshooting.md) | Port conflicts, authentication, and worktree errors |
| [Security](docs/security.md) | Trust boundaries, process confinement, and secret redaction |
| [Limitations](docs/limitations.md) | Supported platforms, backends, and known non-goals |
| [Release Engineering](docs/releasing.md) | Release checklist, packaging, and checksums |
| [Development History](docs/history.md) | Milestone archive and project history |

---

## Contributing

Axonel is intended to be built with contributors, not just around them.

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for development prerequisites, repository structure, testing commands, coding invariants, and the pull-request process.

Before opening a PR, run:

```bash
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```

For changes that affect mission state, worktree isolation, process supervision, or integration semantics, read the relevant architecture and security documentation first.

---

## License

Axonel is dual-licensed under the [MIT License](LICENSE-MIT) and [Apache License, Version 2.0](LICENSE-APACHE), at your option.

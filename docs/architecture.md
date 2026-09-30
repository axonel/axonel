# Sentinel System Architecture

Sentinel is structured as a modular, local-first supervisor daemon and execution control plane for coding agents. It separates agent execution from the primary developer workspace, enforcing strict verification gates and durable state persistence.

---

## 1. High-Level Architecture

```text
┌────────────────────────────────────────────────────────────────────────┐
│                             OPERATOR LAYER                             │
│       Web Dashboard (React/Vite)       │      Developer CLI (sentinel)   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ HTTP API / Server-Sent Events (SSE)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                        SUPERVISOR DAEMON LAYER                         │
│                                                                        │
│   ┌───────────────────────────┐      ┌─────────────────────────────┐   │
│   │   Axum HTTP Server        │      │    SQLite Store (WAL Mode)  │   │
│   │   - REST Endpoints        │◄────►│    - Missions & Checkpoints │   │
│   │   - SSE Event Broadcaster │      │    - Leases & Audit Events  │   │
│   └─────────────┬─────────────┘      └─────────────────────────────┘   │
│                 │                                                      │
│                 ▼                                                      │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │                     FSM Engine & Coordinator                   │   │
│   │  Initialized ──> Running ──> ReadyForReview ──> Integrated     │   │
│   └─────────────┬──────────────────────────────────┬───────────────┘   │
└─────────────────┼──────────────────────────────────┼───────────────────┘
                  │                                  │
                  │ Subprocess Spawn (POSIX PGID)    │ Out-of-band Verification
                  ▼                                  ▼
┌───────────────────────────────────┐  ┌─────────────────────────────────┐
│        AGENT HOST SUBSTRATE       │  │       VERIFICATION ENGINE       │
│  Gemini CLI / External Agent /    │  │  Executes stopping conditions   │
│  Deterministic Fake Agent         │  │  (cargo test, npm test, pytest) │
└─────────────────┬─────────────────┘  └─────────────────┬───────────────┘
                  │                                      │
                  └──────────────────┬───────────────────┘
                                     │ Direct File Operations
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│                     GIT WORKSPACE & REPOSITORY                         │
│                                                                        │
│   Target Branch (main/HEAD)           Isolated Mission Worktree        │
│   [Untouched during execution]   ◄──  [.plexis/worktrees/<mission-id>] │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Workspace Crate Layering

The codebase is organized into modular Rust crates under `crates/`:

| Crate | Responsibility |
| :--- | :--- |
| **`plexis-core`** | Domain types (`Mission`, `Checkpoint`, `Budget`), state machine definitions, errors, and common traits. |
| **`plexis-storage`** | Persistent SQLite storage with Write-Ahead Logging (WAL), connection pooling, migrations, and audit logging. |
| **`plexis-runtime`** | Subprocess execution supervisor, POSIX Process Group ID (PGID) management, timeout enforcement, and Git worktree orchestration. |
| **`plexis-server`** | Axum-based HTTP REST API, Server-Sent Events (SSE) broadcast hub, and user-facing `sentinel` CLI binary. |
| **`plexis-providers`** | Provider adapters interfacing external agents (e.g. Gemini CLI, OpenAI, Anthropic) into the runtime contract. |
| **`plexis-tools`** | File system tools (read, write, diff, search) with path canonicalization and workspace containment checks. |
| **`plexis-planner`** | Task decomposition, execution strategies, and stopping condition synthesis. |
| **`plexis-memory`** | Context tracking, session history, and checkpoint caching. |
| **`plexis-fake-agent`**| Deterministic mock agent implementation for offline regression tests and reproducible benchmarks. |

> **Naming Note:** Internal crates use the `plexis-*` prefix for crate registry isolation and modular stability. The public CLI binary and brand name is **Sentinel**.

---

## 3. Core Subsystems

### 3.1 Isolated Worktree Lifecycle

To guarantee that an agent cannot corrupt an active developer workspace or dirty the primary Git index:
1. **Creation:** When a mission starts, the supervisor runs `git worktree add` to create an isolated working tree at `.plexis/worktrees/<mission-id>` branched off the target commit.
2. **Execution:** All agent file edits, compilations, and command executions are constrained to this directory.
3. **Checkpoints:** After significant edit cycles, the supervisor creates Git checkpoints to allow rolling back stalled or broken cycles.
4. **Pruning:** When the mission reaches a terminal state (`Integrated`, `Cancelled`, `Failed`), the worktree is automatically pruned and removed.

### 3.2 Out-of-Band Physical Verification

Agents frequently hallucinate success, report tests passing when they never ran, or claim fixes that do not compile. Sentinel solves this via **independent physical verification**:
- The supervisor reads the `stopping_conditions` declared in the mission contract (e.g., `cargo test`, `npm test`).
- The supervisor itself executes the command inside the worktree as a fresh process.
- The supervisor inspects exit codes, stdout, and stderr on disk.
- If and only if the stopping conditions exit with code `0`, the mission transitions to `ReadyForReview`.

### 3.3 The Integration State Machine

Integrating changes into the developer's primary branch is protected by a two-phase transactional state machine:

```text
               ┌────────────────┐
               │  Initialized   │
               └───────┬────────┘
                       │
                       ▼
               ┌────────────────┐
               │    Running     │
               └───────┬────────┘
                       │ (Verification passes)
                       ▼
               ┌────────────────┐
               │ ReadyForReview │
               └───────┬────────┘
                       │ (Operator calls /accept)
                       ▼
               ┌────────────────┐
               │    Accepted    │◄──────────────────────────┐
               └───────┬────────┘                           │
                       │                                    │ Merge conflict or
                       │ (Operator calls /integrate)        │ dirty primary tree
                       ▼                                    │ (Atomic rollback)
               ┌────────────────┐                           │
               │  Integrating   │───────────────────────────┘
               └───────┬────────┘
                       │ (Git fast-forward/merge succeeds)
                       ▼
               ┌────────────────┐
               │   Integrated   │
               └────────────────┘
```

1. **`ReadyForReview`**: Verification has passed. A unified review package with diffs and execution metrics is available.
2. **`Accepted`**: The operator has signed off on the diff. The candidate commit is locked.
3. **`Integrating`**: Sentinel checks target branch freshness. If the target commit has drifted or the primary tree is dirty, integration aborts and rolls back to `Accepted`.
4. **`Integrated`**: The changes are safely merged into the target branch.

### 3.4 Process Group (PGID) Containment

Runaway agent processes, dangling compilers, or background subshells are prevented by POSIX process group isolation:
- Each agent execution is spawned into a dedicated process group (`setpgid`).
- When a command times out or is cancelled, Sentinel sends `SIGTERM` followed by `SIGKILL` to `-pgid`.
- This guarantees all child and grandchild processes are cleanly reaped without orphaned daemons consuming host resources.

---

## 4. Related Architecture Documentation

- 🔄 **[Integration State Machine](integration-state-machine.md)** — Complete FSM specification, legal transitions, and error states.
- 🛡️ **[Security & Threat Model](security.md)** — Detailed trust zones, network constraints, and secret redaction.
- 🔄 **[Crash Recovery & Reconciliation](recovery.md)** — Mid-flight crash resilience and authoritative Git ancestry recovery.
- 🤖 **[Agent Providers](providers.md)** — Subprocess host substrate and provider adapters.

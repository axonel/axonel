# Sentinel Contributor & Agent Guidelines

This document defines the rules, invariants, and conventions for engineers and AI agents implementing or extending **Sentinel**.

---

## 1. Source of Truth Hierarchy

When making architectural or implementation decisions, adhere strictly to this hierarchy:

```text
1. Sentinel Architecture Specification & Invariants (docs/architecture.md)
2. Domain Invariants and Type Safety (crates/plexis-core)
3. Storage & Concurrency Guarantees (crates/plexis-storage, crates/plexis-runtime)
4. Existing Passing Test Suites and Verification Contracts
5. Platform / Compiler Constraints
```

---

## 2. Inviolable Architectural Invariants

1. **Durable State is Authoritative**:
   - Live processes, LLM worker threads, and network connections are ephemeral.
   - Any state needed to resume, recover, or audit work must be stored durably in SQLite (WAL mode).
   - In-flight mission state must be reconstructible upon restart.

2. **Isolated Worktree Execution**:
   - Coding agents must **never** edit the developer's primary working directory or active branch directly.
   - All agent file edits, compilations, and command executions must be constrained to a dedicated Git worktree (`.plexis/worktrees/<mission_id>`).

3. **Deterministic Invariants Stay Deterministic**:
   - **Never** use an LLM for dependency validation, state-transition legality, lease token checks, budget enforcement, or authorization.
   - LLMs handle semantic reasoning, code generation, and plan suggestions.

4. **Independent Physical Verification**:
   - A task cannot transition to `ReadyForReview` simply because an agent claims completion.
   - Verification commands (`cargo test`, `npm test`, `pytest`) must be executed out-of-band by the supervisor daemon directly against the worktree on disk.

5. **Explicit Human Review Gate**:
   - Direct automatic merging to `main` is strictly forbidden.
   - All candidate deliverables must halt at `ReadyForReview` and require operator acceptance (`/api/v1/missions/{id}/accept`) before integration.

6. **Transactional Git Integration**:
   - Integrations follow a two-phase state transition: `Accepted` -> `Integrating` -> `Integrated`.
   - On merge conflicts or dirty primary working trees, integration aborts cleanly and rolls back to `Accepted`.

7. **Process Group Containment & Cleanup**:
   - All spawned subprocesses must be assigned a dedicated POSIX Process Group ID (PGID).
   - On timeout, cancellation, or drop, termination signals (`SIGTERM` followed by `SIGKILL`) must be dispatched to the entire process group.

8. **Secret Protection & Data Hygiene**:
   - Sensitive credentials, API keys (`sk-`, `ghp_`, `AKIA`, `Bearer`, `AIza`), and tokens must be sanitized by `SecretRedactor` before being logged, persisted, or emitted over SSE streams.

---

## 3. Crate and Dependency Boundaries

Sentinel strictly prohibits circular dependencies and reverse-layer dependencies:

- **`plexis-core`**: Pure domain logic only. Zero database drivers, zero network code, zero async runtime dependencies.
- **`plexis-storage`**: Implements repository traits (`MissionStore`, `TaskStore`, etc.) using SQLite. SQL queries and migrations belong here.
- **`plexis-providers`**: LLM and CLI agent provider traits and adapters (Gemini CLI, OpenAI, Ollama).
- **`plexis-tools`**: Tool definitions, execution backends, and sandbox containment.
- **`plexis-memory`**: Session context, memory scopes, and search engines.
- **`plexis-planner`**: Task decomposition, prompt templates, and plan validation budgets.
- **`plexis-runtime`**: Supervisor engine, worktree lifecycle, lease manager, and process group containment.
- **`plexis-server`**: Axum HTTP daemon, SSE event streaming, and user-facing `sentinel` CLI binary.
- **`plexis-fake-agent`**: Deterministic mock agent for offline regression testing and CI.

---

## 4. Coding Standards

- **Strict Clippy Compliance**: Zero warnings tolerated:
  ```bash
  cargo clippy --workspace --all-targets -- -D warnings
  ```
- **Code Formatting**: Conforms strictly to Rustfmt:
  ```bash
  cargo fmt --all -- --check
  ```
- **Strongly Typed Errors**: Use `thiserror` for library error definitions (`DomainError`, `StorageError`, `ToolError`, `ProviderError`, `RuntimeError`).
- **Bounded Buffers**: Subprocess streams flow through bounded ring buffers with automatic pattern-based secret redaction.

---

## 5. Verification & Testing Workflow

Before committing any change:
```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

# Contributing to Sentinel

Thank you for your interest in contributing to Sentinel! We welcome issues, documentation improvements, bug fixes, and feature contributions.

---

## 1. Development Prerequisites

- **Rust:** Stable toolchain (1.88+ recommended, minimum 1.80+).
- **Node.js:** v20.x or higher (for building the Web UI).
- **Git:** 2.38+ with worktree support enabled.
- **Optional Tools:** `cargo-audit`, Playwright (for UI tests).

---

## 2. Repository Structure

Sentinel is organized as a Cargo workspace with a Vite/React frontend:

```text
sentinel/
├── crates/
│   ├── plexis-core/         # Domain types, errors, configuration
│   ├── plexis-storage/      # SQLite persistence layer (WAL mode)
│   ├── plexis-providers/    # LLM & CLI agent adapters (Gemini, Fake)
│   ├── plexis-tools/        # File edit, shell execution, path validation
│   ├── plexis-runtime/      # Supervisor engine, worktree management, PGID lifecycle
│   ├── plexis-server/       # Axum HTTP daemon, SSE event streaming, CLI entrypoint
│   ├── plexis-planner/      # Task breakdown and planning logic
│   ├── plexis-memory/       # Session context and history
│   └── plexis-fake-agent/   # Deterministic mock agent for offline testing
├── web/                     # React + Vite Mission Control Web UI
├── docs/                    # Architecture, API, CLI, and integration guides
└── tests/                   # Workspace integration and end-to-end test suites
```

> **Note on crate naming:** Internal crates are prefixed with `plexis-*` for modular stability. The user-facing binary and product name is `sentinel`.

---

## 3. Building & Testing

### Building the Web UI

The Web UI assets are embedded into the `sentinel` binary during release builds.

```bash
cd web
npm install
npm run build
cd ..
```

### Building the Server & CLI

```bash
# Debug build
cargo build --workspace

# Release build
cargo build --release -p plexis-server --bin sentinel
```

### Running Tests

Every change must pass the full workspace test suite:

```bash
# Run all unit and integration tests
cargo test --workspace

# Check formatting
cargo fmt --all -- --check

# Run Clippy with zero warnings
cargo clippy --workspace --all-targets -- -D warnings
```

---

## 4. Code Standards & Guidelines

1. **Truthful & Documented Invariants:**
   - Never compromise the integration state machine. State transitions must remain strictly forward-progressing and durable in SQLite.
   - Do not claim features or capabilities that are not backed by automated tests.
2. **Subprocess Isolation:**
   - Always assign new subprocesses to a dedicated POSIX process group (PGID) and ensure cleanup logic kills the entire group.
3. **Path Canonicalization:**
   - Any filesystem operation dealing with worktrees or user workspaces must be canonicalized and checked against path traversal outside the target directory.
4. **Git Worktree Hygiene:**
   - Always ensure worktrees created for missions are pruned or cleaned up when missions reach terminal states (`Integrated`, `Cancelled`, `Failed`).

---

## 5. Pull Request Process

1. Fork the repository and create a descriptive feature branch:
   ```bash
   git checkout -b feature/your-feature-name
   ```
2. Ensure your code compiles cleanly and all workspace tests pass:
   ```bash
   cargo test --workspace && cargo fmt --all -- --check && cargo clippy --workspace --all-targets -- -D warnings
   ```
3. Commit your changes with clear, concise commit messages following conventional commits (e.g., `feat: ...`, `fix: ...`, `docs: ...`).
4. Push to your fork and submit a Pull Request against `main`.
5. Ensure continuous integration (GitHub Actions) runs cleanly on your PR.

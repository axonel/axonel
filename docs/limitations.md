# Axonel Operational Limitations & Boundaries

This document provides a transparent accounting of Axonel's operational assumptions, supported integrations, known failure modes, and boundaries.

---

## 1. Provider Support Tiers

| Provider / Tool | Support Tier | Status | Operational Notes |
| :--- | :--- | :--- | :--- |
| **Google Gemini CLI** (`gemini_cli`) | **Tier 1 (Production)** | **Production-Verified** | Full lifecycle verified: worktree isolation, headless execution, out-of-band test verification, review package, human acceptance, and Git integration. Requires `gemini` CLI installed with valid credentials (`gemini auth login` or `GEMINI_API_KEY`). |
| **Fake Agent** (`fake_agent`) | **Tier 1 (Test / CI)** | **Fully Verified** | Deterministic local test double for offline regression testing, demonstration, and CI/CD pipelines. |
| **Anthropic Claude Code** (`claude_code`) | **Tier 1 (Production)** | **Production-Verified** | Full adapter implemented: stream-json stream translation, capability probing, permission-mode translation from requested capabilities, PGID-isolated subprocess supervision, shared Git verification. Requires `claude` CLI installed with valid credentials (`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN`). |
| **OpenAI Codex / Aider** (`codex`) | Tier 3 (Experimental) | Scaffold Stub | Interface stub registered; not certified for live production execution. |
| **Local OpenCode** (`opencode`) | Tier 3 (Experimental) | Scaffold Stub | Interface stub registered; requires local Ollama server tooling. |

> [!WARNING]
> Google Gemini CLI (`gemini_cli`), Anthropic Claude Code (`claude_code`), and the deterministic Fake Agent (`fake_agent`) are the backends certified for autonomous execution in v0.1.x.

---

## 2. Operating System & Platform Support

- **Certified Supported:** **Linux x86_64** (`x86_64-unknown-linux-gnu`). Tested and verified in continuous integration.
- **Minimum Supported Rust Version (MSRV):** **Rust 1.88.0+** (Rust 2024 edition).
- **Planned / Unverified:** **Linux aarch64** (`aarch64-unknown-linux-gnu`). Architecturally compatible, but unverified on hardware runners.
- **Experimental:** **macOS**. Git worktrees and SQLite operate cleanly; Bubblewrap sandboxing is disabled on Darwin.
- **Unsupported:** **Windows** (all versions). Axonel relies on POSIX process tree isolation (`killpg`, `setpgid`, `SIGTERM`/`SIGKILL`) and Unix domain sockets.

---

## 3. Network Egress & LLM Privacy Model

- **Local Control Plane:** The Axonel supervisor daemon, REST API, SQLite database (`plexis.db`), Git worktrees, unified diffs, and verification receipts remain strictly on your local disk.
- **Cloud LLM Egress:** When using external providers (such as Google Gemini CLI), prompts, repository file context, and error messages are transmitted outbound over HTTPS to provider APIs in accordance with your provider agreement.
- **Secret Redaction:** Axonel runs an in-memory regex redactor (`SecretRedactor`) over all terminal streaming buffers, logs, and events, scrubbing Bearer tokens, OpenAI/Anthropic keys (`sk-...`), Google API keys (`AIza...`), and GitHub tokens (`ghp_...`).

---

## 4. Verification & Correctness Boundaries

- **Authoritative Disk Authority:** Verification is strictly physical (`cargo test`, `npm test`, `pytest`, `working_tree_clean == true`, `required_commit_exists == true`).
- **No Mathematical Correctness Proof:** Axonel guarantees that *your test suite passed cleanly on disk*. It does not mathematically prove program correctness beyond what your test suite covers.
- **Flaky Test Sensitivity:** Non-deterministic tests with network or timing race conditions can cause false-negative verification rejections or trigger unnecessary replanning cycles.

---

## 5. Repository & Workspace Constraints

- **Single-Repository Scope:** Each mission is strictly confined to a single Git repository workspace. Multi-repository transactions are out of scope.
- **Git Worktree Requirement:** The target repository must be a valid Git repository with `git worktree` support (`git >= 2.34`).
- **Merge Conflicts:** If the target branch has moved concurrently and a merge conflict arises during integration, Axonel aborts the merge cleanly (`git merge --abort`) and returns HTTP 409 Conflict. Axonel does not automatically resolve conflicting merge hunks.

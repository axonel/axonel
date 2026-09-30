# Sentinel Development History & Milestone Archive

This document preserves the architectural progression and milestone history of Sentinel from inception through the v0.1.1 release.

---

## 1. Project Inception & Subsystem Foundation (Milestones 1–10)

- **Domain Model & Types (`plexis-core`):** Designed a strongly typed domain model using UUIDv7 identifiers and 10 explicit finite state machines governing workflows, tasks, and missions.
- **Storage Layer (`plexis-storage`):** Built asynchronous SQLite repositories running in WAL mode with foreign key enforcement and embedded migrations.
- **Provider Abstraction (`plexis-providers`):** Created a unified interface for LLM backends (OpenAI, Anthropic, Gemini, Ollama) with latency and error tracking.
- **Tool Sandbox (`plexis-tools`):** Implemented execution boundaries with `BubblewrapBackend` (Linux namespaces) and `HostProcessBackend`, path canonicalization, and automated secret redaction.
- **Memory & Planning (`plexis-memory`, `plexis-planner`):** Built scoped long-term memory with hybrid vector/keyword retrieval and DAG-based task decomposition.

---

## 2. Worktree Isolation & The Supervisory Loop (Milestones 11–13)

- **Isolated Git Worktrees:** Shifted agent execution away from the developer's primary working tree to dedicated worktrees under `.plexis/worktrees/`.
- **Out-of-Band Physical Verifier:** Solved the "hallucinated pass" failure mode of coding agents by implementing an independent verification engine that executes compilers and test suites directly on disk.
- **Replanning & Recovery:** Introduced multi-cycle replanning to feed compiler and test error outputs back to the agent for self-repair within bounded budget caps.

---

## 3. Mission Control Dashboard & Real-Time Streaming (Milestones 14–15)

- **Web Operations Dashboard:** Developed a React + Vite dashboard for real-time mission monitoring.
- **Server-Sent Events (SSE):** Implemented high-throughput event broadcasting with cursor reconnection support.
- **Interactive Review Package:** Added unified diff viewers, file modification trees, and terminal log stream replay with sensitive secret masking.

---

## 4. Competitive Analysis & Positioning (Milestone 16)

- Benchmarked Sentinel against existing coding tools (Cursor, Aider, Claude Code, Devin).
- Solidified Sentinel's core thesis: a local, transparent supervisor daemon providing worktree isolation, independent verification, and explicit human governance.

---

## 5. Human Acceptance & Empirical Benchmarking (Milestones 17–19)

- **Human Acceptance Gate:** Enforced an explicit stop at `ReadyForReview`, blocking unreviewed candidate merges with HTTP 409 Conflict.
- **Empirical Benchmarks (M18):** Ran head-to-head trials comparing raw Gemini CLI execution against Sentinel-supervised execution across 3 standard workloads:
  - Raw Gemini CLI left repositories in a dirty state 100% of the time, requiring 4 manual developer actions per run.
  - Sentinel achieved 100% clean primary working trees with 0 manual developer actions required prior to the review gate.
- **Structured Review Deliverables (M19):** Added unified diff inspection, changed file manifests, and candidate commit SHA tracking.

---

## 6. Transactional Git Integration & Crash Durability (Milestone 20)

- **Two-Phase Integration State Machine:** Established transactional states: `Accepted` -> `Integrating` -> `Integrated`.
- **Crash Recovery & Reconciliation:** Verified that if the daemon is killed with `SIGKILL` mid-integration, restart reconciliation uses authoritative Git ancestry (`git merge-base --is-ancestor`) to restore consistency with zero data loss.
- **Merge Conflict & Dirty Tree Defense:** Implemented atomic rollback (`git merge --abort`) to `Accepted` if target branch conflicts occur, and refused integration if the primary working tree has uncommitted changes.

---

## 7. External Audit Remediation & Release Hardening (Milestone 21 / v0.1.1)

- Corrected all 10 findings from an independent external audit:
  - Eliminated premature auto-merging roles.
  - Hardened untracked file exclusions (`:!*.db*`).
  - Added deterministic command-lease claiming to eliminate concurrency race flakes.
  - Certified platform bounds strictly on Linux x86_64.
  - Established MSRV at Rust 1.88.0+.

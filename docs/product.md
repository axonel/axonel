# Sentinel Product Overview & Design Principles

Sentinel is an **autonomous software engineering supervisor daemon and control plane**. It enables developers to delegate real programming tasks to external coding agents while maintaining total repository safety, independent verification, and explicit human governance.

---

## 1. Problem Statement & Core Thesis

### The Problem with Raw Coding Agents
When coding agents execute directly inside a developer's repository:
1. **Working Tree Hijacking:** Agents edit active files in place, conflicting with the developer's ongoing work and dirtying the Git index.
2. **Hallucinated Success:** LLMs frequently assert "all tests pass" when compilations failed silently or tests were never run.
3. **Dirty Working Trees:** Agents leave untracked build artifacts, lockfile residue, and temporary files that accidentally get swept into commits.
4. **Zero Durability:** Process crashes, network disconnects, or machine restarts lose all in-flight work.

### The Sentinel Thesis
Developers do not need another chatbot in their IDE. They need an **operating system and supervisor layer** for coding agents that treats agents as untrusted background workers:
- Confine agents to isolated Git worktrees.
- Verify deliverables on disk using the repository's ground-truth test suite out-of-band.
- Halt at an explicit human review gate with unified diff inspection.
- Integrate verified commits into the target branch transactionally.

---

## 2. Target Users & Use Cases

### Target Users
- **Backend & Systems Engineers:** Developers working on compiled codebases (Rust, Go, C++) where compilation times and test determinism matter.
- **Platform & Infrastructure Teams:** Teams seeking to automate repetitive maintenance tasks (dependency upgrades, linting remediation, flaky-test fixes).
- **Open-Source Maintainers:** Maintainers who want to delegate issue reproduction and PR triage without granting unrestricted repository access.

### Core Use Cases
- **Autonomous Bug Fixing:** Diagnosing and fixing reproducible failing unit tests.
- **Flaky-Test Remediation:** Running multi-cycle test iterations to isolate race conditions.
- **Refactoring & Code Modernization:** Applying systematic changes across multiple modules while ensuring tests pass.
- **Dependency Upgrades:** Updating library versions, resolving breaking API changes, and validating against the compiler.

---

## 3. Design Principles

1. **Local-First Control Plane:** The supervisor daemon, SQLite storage, and Git operations run 100% locally on your workstation or private server.
2. **Physical Over Qualitative Verification:** An agent's self-report of completion is disregarded. The supervisor independently executes compilers and test suites directly on disk.
3. **Primary Branch Immutability:** Agents never write to `main` or active development branches. All mutations occur in ephemeral Git worktrees.
4. **Explicit Human Governance:** Autonomous work stops at `ReadyForReview`. Candidate deliverables require human operator sign-off before merging.
5. **Durable State & Crash Reconciliation:** All mission states, audit events, and checkpoints are stored in SQLite (WAL mode). If the daemon is abruptly terminated, it recovers authoritative state upon restart.

---

## 4. Non-Goals

- **Not an IDE or Chat Extension:** Sentinel does not provide code completion popups or in-editor chat sidebars.
- **Not a Black-Box SaaS:** Sentinel does not execute code in untrusted multi-tenant cloud sandboxes.
- **Not "Zero Babysitting":** Sentinel automates execution and testing, but human engineers retain authority over review and merging.
- **Not a Mathematical Prover:** Sentinel proves that your test suite passed on disk; it does not claim formal mathematical correctness beyond test coverage.

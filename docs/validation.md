# Sentinel Validation & Verification Receipts

Sentinel adheres to strict empirical verification standards. Every architectural claim, security boundary, and reliability guarantee in Sentinel is backed by automated test suites, reproducible benchmarks, and physical artifacts.

---

## 1. Automated Test Suite Receipts

| Test Layer | Test Suite / Harness | Assertions / Cases | Pass Rate | Invariants Verified |
| :--- | :--- | :--- | :--- | :--- |
| **Workspace Unit Tests** | `cargo test --workspace` | 74 test cases | **100%** (74/74) | Domain types, SQLite WAL storage, tool containment, PGID handling, parser logic |
| **Code Formatting** | `cargo fmt --all -- --check` | Entire workspace | **100%** | Zero formatting deviations |
| **Static Analysis** | `cargo clippy --workspace --all-targets -- -D warnings` | All crates | **100%** | Zero clippy warnings across all workspace crates |
| **Concurrency Stress** | `test_concurrent_command_claiming` | 20 concurrent threads | **100%** (20/20) | Zero race conditions on command lease claims |
| **Security Gates** | `crates/plexis-server/tests/security_tests.rs` | 6 test cases | **100%** (6/6) | Loopback bind default, rejected external bind without auth, auth token validation |
| **Safety Regression** | `quickstart_safety_regression_test.rs` | Integration test | **100%** | Main branch protection, worktree isolation, refusal of unverified merges |
| **Browser E2E** | `web/tests/e2e_release_candidate.mjs` (Playwright) | 15 assertions | **100%** (15/15) | Full mission lifecycle, diff viewer, review package modal, operator acceptance |
| **Adversarial Audit** | `m20_integration_reliability_tests.mjs` | 15 scenarios | **100%** (15/15) | Crash recovery (`SIGKILL`), merge conflict abort, dirty working tree protection |
| **Real Gemini CLI** | `web/tests/e2e_honest_validation.mjs` (M18/M19) | 12 empirical runs | **100%** (12/12) | Real Gemini CLI agent autonomously fixing code in isolated worktrees |
| **Continuous Integration** | GitHub Actions (`.github/workflows/ci.yml`) | Remote pipeline | **100% GREEN** | Clean build, test, format, and clippy passes on remote runner |

---

## 2. Empirical Benchmark: Raw Agent vs. Sentinel Supervisor (M18)

We evaluated direct headless execution of Google Gemini CLI against Sentinel's supervised execution across 3 standard coding workloads (12 total runs):

| Metric | Raw Gemini CLI (Baseline A) | Sentinel Supervised (Baseline B) |
| :--- | :--- | :--- |
| **Test Pass Rate** | 6/6 (100%) | 6/6 (100%) |
| **Primary Working Tree State** | **100% Dirty** (untracked files, build artifacts) | **100% Clean** (isolated worktrees) |
| **Manual Developer Actions** | **4 actions per run** (monitor, clean, test, commit) | **0 actions required** (autonomous supervision) |
| **Verification Authority** | Agent self-report (unverified) | **Independent physical disk verification** |
| **Average Wall-Clock Duration** | 38.8s | 39.8s (~1s supervisor overhead) |

### Workload Telemetry Summary

1. **Concurrency Gate (`concurrency_gate`):** Fix uncoordinated race condition in atomic compare-and-swap logic.
   - Raw CLI: Left uncommitted lockfiles and target build artifacts. Required 4 developer actions.
   - Sentinel: Isolated in worktree; Cycle 0 diagnosed, Cycle 1 patched and verified on disk. Integrated with 0 developer actions.
2. **API Gateway (`api_gateway`):** Fix HTTP route authentication bypass.
   - Raw CLI: Patched file in place, leaving working tree dirty. Required 4 developer actions.
   - Sentinel: Isolated in worktree; tests passed on disk. 0 developer actions.
3. **Query Parser (`query_parser`):** Fix AST traversal off-by-one error.
   - Raw CLI: Patched in place, dirty repository. 4 developer actions.
   - Sentinel: Isolated in worktree; tests passed on disk. 0 developer actions.

---

## 3. Adversarial & Crash Recovery Receipts (M20)

During adversarial fault-injection audits, Sentinel was subjected to deliberate crash and conflict scenarios:

1. **Mid-Flight Termination (`SIGKILL`):**
   - The supervisor daemon was killed via `SIGKILL` while a mission was in the `Integrating` state.
   - Upon restart, Sentinel performed authoritative Git ancestry recovery (`git merge-base --is-ancestor`) and reconciled state with zero data corruption.
2. **Merge Conflict Abort:**
   - A conflicting commit was pushed to the target branch while an agent was executing in its worktree.
   - Sentinel detected the conflict during integration, rejected the merge with HTTP 409 Conflict, and atomically rolled back the mission state to `Accepted` without dirtying the repository.
3. **Dirty Primary Tree Defense:**
   - Sentinel refused to integrate candidate commits when the primary working tree contained unstaged changes, preventing developer data loss.

---

## 4. 20-Task Benchmark Corpus & Multi-Language Telemetry

To ensure evaluation across diverse tech stacks, Sentinel tracks a **20-task benchmark corpus** spanning Rust, TypeScript, and Python:
- The corpus specification is maintained in [`docs/validation/dataset.json`](validation/dataset.json).
- Executed empirical trials and machine-readable telemetry are recorded in [`docs/validation/results.json`](validation/results.json).
- Benchmark runner scripts:
  - `web/tests/real_world_validation_runner.mjs`
  - `web/tests/real_world_multi_lang_runner.mjs`

---

## 5. Claims Audit & Truthfulness Ledger

Sentinel explicitly audits all public claims into standardized categories:

| Dimension | Claim Statement | Status | Evidence / Invariant |
| :--- | :--- | :--- | :--- |
| **Durability** | State survives process crash / restart without losing unmerged work | **SUPPORTED** | Tested in M19 & M20 crash recovery suites |
| **Git Safety** | Candidate commits are confined to isolated worktrees; primary tree is untouched | **SUPPORTED** | `plexis-runtime`, verified in M19 & M20 suites |
| **Reconciliation** | Daemon reconciles intermediate `Integrating` states on restart using Git as truth | **SUPPORTED** | `reconcile_startup()`, verified in M20 Scenarios C & D |
| **Human Boundary** | Integration is strictly blocked until explicit human review & acceptance | **SUPPORTED** | Verified in M19 & M20 test suites |
| **External Agent** | Google Gemini CLI runs as external OS process and completes end-to-end fixes | **SUPPORTED** | `GeminiCliBackend`, proven in M20 Scenario O & M18 benchmarks |
| **Security Defaults** | Default bind is loopback (`127.0.0.1`); non-loopback bind without auth fails startup | **SUPPORTED** | `crates/plexis-server/tests/security_tests.rs` (Tests A through F) |
| **Workspace Locking** | Concurrent integration requests on the same workspace are serialized | **SUPPORTED** | `WorkspaceLockManager`, verified in M20 Scenarios E & F |
| **Conflict Rollback** | Merge conflicts cleanly abort integration and roll back state to `Accepted` | **SUPPORTED** | Verified in M20 Scenario H |
| **Stale Target Guard**| Target branch drift triggers re-verification warning and prevents silent overwrites | **SUPPORTED** | Verified in M20 Scenario J |
| **Multi-Provider Hub**| Supports Claude Code, Codex, and OpenCode out of the box | **NOT YET VALIDATED** | Only scaffold adapter stubs exist (`adapters.rs`); labeled as stubs |
| **Privacy & Egress**  | "100% Local (Zero Code Egress)" | **RETRACTED** | External LLMs receive prompt and code context. Control plane is local. |
| **Developer Effort** | "Zero Babysitting (Walk Away)" | **RETRACTED** | Replaced with "Supervised autonomous background execution with human sign-off." |
| **Verification Authority** | "Guaranteed correct / Formal proof of correctness" | **RETRACTED** | "Verified" strictly denotes passing configured tests and stopping conditions. |

# Crash Recovery & State Reconciliation

Sentinel is engineered for local-first durability. If the supervisor daemon crashes, the host machine reboots, or an operator forcibly kills the process (`kill -9`), Sentinel ensures that in-flight missions, candidate commits, and repository integrity are preserved and durably reconciled upon restart.

---

## 1. Durability Architecture

Sentinel maintains authoritative state across two complementary storage engines:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        SUPERVISOR DAEMON CRASH                         │
│                    (SIGKILL / Power Loss / Panic)                      │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       RESTART & RECONCILIATION                         │
│                                                                        │
│   ┌─────────────────────────────┐      ┌───────────────────────────┐   │
│   │   SQLite Database (WAL)     │      │   Physical Git Repository │   │
│   │   - Durable mission state   │◄────►│   - Target branch HEAD    │   │
│   │   - Candidate commit SHAs   │      │   - Worktree state on disk│   │
│   │   - Monotonic lease tokens  │      │   - Git ancestry checks   │   │
│   └─────────────────────────────┘      └───────────────────────────┘   │
│                                  │                                     │
│                                  ▼                                     │
│                 Authoritative State Determination                      │
│             (git merge-base --is-ancestor target commit)               │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
           ┌────────────────────────┴────────────────────────┐
           ▼                                                 ▼
┌───────────────────────┐                         ┌──────────────────────┐
│ Commit is Ancestor    │                         │ Commit NOT Ancestor  │
│ State -> `Integrated` │                         │ State -> `Accepted`  │
└───────────────────────┘                         └──────────────────────┘
```

1. **SQLite Write-Ahead Logging (WAL Mode):**
   - Every state transition, checkpoint, lease grant, and audit event is committed synchronously to SQLite before external actions execute.
   - Foreign key constraints prevent orphaned records.
2. **Authoritative Git Ancestry:**
   - Physical Git commits are immutable. Sentinel uses Git's commit graph as the physical ground truth to resolve ambiguous intermediate states.

---

## 2. Reconciling Intermediate States

The most dangerous failure window occurs when the daemon is killed during the integration phase (`Integrating` state):
- Did the Git merge succeed before the crash?
- Did Git fail or leave a merge lock?
- Is the candidate commit already part of the target branch?

### The Startup Reconciler

Upon launching (`sentinel serve`), Sentinel automatically invokes `reconcile_startup()`:

1. **Query In-Flight Missions:** The daemon scans SQLite for missions in non-terminal states (`Running`, `Verifying`, `Integrating`).
2. **Git Ancestry Query:** For any mission marked `Integrating`:
   ```bash
   git merge-base --is-ancestor <candidate_commit_sha> <target_branch_head>
   ```
3. **Deterministic Resolution:**
   - **If the candidate commit is an ancestor of the target branch:** The merge succeeded physically before the crash. Sentinel promotes the mission state in SQLite to `Integrated`.
   - **If the candidate commit is NOT an ancestor:** The merge did not complete. Sentinel rolls back the mission state to `Accepted`, releases any locks, and allows the operator to retry or reject the integration safely.
4. **Active Subprocess Cleanup:** If any leaked child process groups remain, Sentinel dispatches `SIGTERM` and `SIGKILL` to clean up orphaned compilers or agents.

---

## 3. Manual Reconciliation via CLI

Operators can also trigger reconciliation manually from the command line:

```bash
# Reconcile all in-flight missions against physical Git state
sentinel reconcile

# Inspect mission status after reconciliation
sentinel mission status <mission_id>
```

---

## 4. Worktree Cleanup & Hygiene

When missions reach terminal states (`Integrated`, `Cancelled`, `Failed`):
- Sentinel automatically removes the isolated worktree directory from `.plexis/worktrees/`.
- Git's internal worktree references are pruned via `git worktree prune`.
- If a hard crash left orphaned worktrees, running `git worktree prune` cleans them up safely without touching the primary repository.

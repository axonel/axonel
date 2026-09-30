# Sentinel REST API Reference

Sentinel is designed as an API-first supervisor daemon. The Web Operations Dashboard and developer integrations communicate through standard JSON HTTP endpoints.

All endpoints are prefixed with `/api/v1` unless noted otherwise. When authentication is enabled, requests must include the header:
```text
Authorization: Bearer <SENTINEL_AUTH_TOKEN>
```

---

## 1. System & Health

### `GET /health` or `GET /api/v1/health`
Basic liveness probe.
- **Response**: `200 OK`
```json
{
  "status": "healthy",
  "version": "0.1.1"
}
```

### `GET /api/v1/system/status`
Returns daemon operational status, memory usage, and active execution leases.

### `GET /api/v1/auth/status`
Discloses whether authentication is required and whether the server is bound to loopback.
- **Response**: `200 OK`
```json
{
  "auth_required": false,
  "is_loopback": true,
  "configured": true
}
```

---

## 2. Workspaces

### `POST /api/v1/workspaces`
Registers a repository directory as a managed workspace.

**Request**:
```json
{
  "name": "my-project",
  "canonical_path": "/home/user/projects/my-project"
}
```

**Response**: `201 Created`
```json
{
  "id": "ws_01a0bafbd0af729a8291422c7f392677",
  "name": "my-project",
  "canonical_path": "/home/user/projects/my-project",
  "created_at": "2026-09-20T00:00:00Z"
}
```

### `GET /api/v1/workspaces`
Lists all registered workspaces.

### `GET /api/v1/workspaces/{id}/git/status`
Inspects the physical Git status (current branch, HEAD commit, clean status, uncommitted files) of the registered workspace.

---

## 3. Missions

### `POST /api/v1/missions`
Creates and dispatches an autonomous engineering mission.

**Request**:
```json
{
  "title": "Fix failing integration test",
  "objective": "Fix test_auth_token in tests/auth_test.rs by stripping bearer prefix. Run cargo test to verify and commit.",
  "workspace_id": "ws_01a0bafbd0af729a8291422c7f392677",
  "backend": "gemini_cli",
  "stopping_condition": {
    "required_tests_pass": true,
    "working_tree_clean": true,
    "required_commit_exists": true,
    "custom_verifier": null
  },
  "auto_start": true
}
```

**Response**: `201 Created`
```json
{
  "id": "msn_01a0bafbd0d974d3a0e379c2441e2274",
  "title": "Fix failing integration test",
  "objective": "Fix test_auth_token in tests/auth_test.rs...",
  "state": "planning",
  "workspace_id": "ws_01a0bafbd0af729a8291422c7f392677",
  "backend": "gemini_cli",
  "created_at": "2026-09-20T00:00:00Z"
}
```

### `GET /api/v1/missions/{id}`
Returns full mission metadata, lifecycle state, resource consumption, and checkpoints.

### `GET /api/v1/missions/{id}/review`
Returns the comprehensive human review package when a mission reaches `AwaitingAcceptance`.

**Response**: `200 OK`
```json
{
  "mission_id": "msn_01a0bafbd0d974d3a0e379c2441e2274",
  "title": "Fix failing integration test",
  "status": "awaiting_acceptance",
  "target_branch": "main",
  "duration_secs": 42,
  "files_changed": ["src/auth.rs"],
  "diff_summary": {
    "insertions": 4,
    "deletions": 1,
    "files_changed": 1
  },
  "full_diff": "diff --git a/src/auth.rs b/src/auth.rs\n...",
  "verification": {
    "tests_passed": true,
    "working_tree_clean": true,
    "commit_exists": true
  },
  "can_accept": true,
  "can_integrate": true,
  "can_reject": true,
  "reverification_required": false
}
```

### `POST /api/v1/missions/{id}/accept`
Explicitly accepts a verified deliverable.

**Request**:
```json
{
  "integrate": true,
  "target_branch": "main",
  "commit_message": "fix(auth): strip bearer prefix"
}
```

**Response**: `200 OK`
```json
{
  "mission_id": "msn_01a0bafbd0d974d3a0e379c2441e2274",
  "state": "integrated",
  "accepted_at": "2026-09-20T00:01:00Z",
  "integrated": true,
  "verified_commit": "6189f377d2596fabb18652108566e51e8bc8a391"
}
```

### `POST /api/v1/missions/{id}/reject`
Rejects a candidate deliverable with an auditable reason.

**Request**:
```json
{
  "reason": "Fix did not handle empty header edge case",
  "continue_mission": true
}
```

### `POST /api/v1/missions/{id}/integrate`
Safely integrates an already-accepted deliverable into the target branch.
- Returns `409 Conflict` if the mission is not in `Accepted` state, if the target repository has uncommitted changes, or if concurrent commits cause a merge conflict.

---

## 4. Live Events & Terminal Streaming

### `GET /api/v1/events/stream`
Server-Sent Events (SSE) endpoint providing real-time streaming of all mission state transitions, execution starts/completions, and verification receipts.

### `GET /api/v1/tasks/{id}/terminal`
Returns the bounded, secret-redacted terminal output buffer for a specific agent execution task.

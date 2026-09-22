//! REST API routes and handlers for Plexis Server.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{
        sse::{Event as AxumSseEvent, KeepAlive, Sse},
        Html, IntoResponse,
    },
    routing::{get, post},
    Json, Router,
};
use futures::Stream;
use serde::{Deserialize, Serialize};
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};

use plexis_core::ids::{
    AgentId, ApprovalId, ExecutionId, MemoryId, MissionId, TaskId, WorkflowId, WorkspaceId,
};
use plexis_core::mission::{
    Mission, MissionBudget, MissionCheckpoint, MissionCycle, StoppingCondition,
};
use plexis_core::state::{AgentState, MissionState, TaskState, WorkflowState};
use plexis_core::{
    Agent, AgentMessage, ApprovalRecord, Command, Event, Execution, MemoryRecord, MemoryScope,
    MessageType, RecoveryRecord, Session, Task, Verification, Workflow, Workspace,
    WorkspaceSecurityPolicy,
};
use plexis_planner::PlanProposal;
use plexis_runtime::dispatcher::BroadcastCommandDispatcher;
use plexis_runtime::lease_manager::LeaseManager;
use plexis_runtime::runner::AgentRunner;
use plexis_runtime::scheduler::DeterministicScheduler;
use plexis_runtime::verifier::WorkspaceVerifier;
use plexis_storage::traits::{
    AgentStore, ApprovalStore, CommandStore, EventStore, ExecutionStore, MemoryStore, MessageStore,
    MissionStore, RecoveryStore, RetentionStore, SessionStore, TaskStore, VerificationStore,
    WorkflowStore, WorkspaceStore,
};
use plexis_storage::SqliteStore;

use crate::git;
use crate::github::CreatePullRequestPayload;
use crate::state::AppState;

/// Creates the complete Axum router configured with all API endpoints and static SPA serving.
pub fn create_router(state: AppState) -> Router {
    let cors = CorsLayer::permissive();

    let api_router = Router::new()
        // System & Health
        .route("/health", get(health_check))
        .route("/api/v1/health", get(health_check))
        .route("/api/v1/system/status", get(system_status))
        .route("/api/v1/auth/status", get(auth_status))
        .route("/api/v1/dashboard/summary", get(dashboard_summary))
        // Workflows
        .route(
            "/api/v1/workflows",
            get(list_workflows).post(create_workflow),
        )
        .route("/api/v1/workflows/{id}", get(get_workflow))
        .route("/api/v1/workflows/{id}/tasks", get(list_workflow_tasks))
        .route("/api/v1/workflows/{id}/graph", get(get_workflow_graph))
        .route("/api/v1/workflows/{id}/plan", post(plan_workflow))
        .route("/api/v1/workflows/{id}/start", post(start_workflow))
        .route("/api/v1/workflows/{id}/pause", post(pause_workflow))
        .route("/api/v1/workflows/{id}/resume", post(resume_workflow))
        .route("/api/v1/workflows/{id}/cancel", post(cancel_workflow))
        .route(
            "/api/v1/workflows/{id}/messages",
            get(list_workflow_messages),
        )
        .route(
            "/api/v1/workflows/{id}/recoveries",
            get(list_workflow_recoveries),
        )
        .route(
            "/api/v1/workflows/{id}/verifications",
            get(list_workflow_verifications),
        )
        // Tasks
        .route("/api/v1/tasks/{id}", get(get_task))
        .route(
            "/api/v1/tasks/{id}/dependencies",
            get(get_task_dependencies),
        )
        .route("/api/v1/tasks/{id}/executions", get(get_task_executions))
        .route(
            "/api/v1/tasks/{id}/verifications",
            get(get_task_verifications),
        )
        .route("/api/v1/tasks/{id}/messages", get(get_task_messages))
        .route("/api/v1/tasks/{id}/recoveries", get(get_task_recoveries))
        .route("/api/v1/tasks/{id}/reassign", post(reassign_task))
        // Agents
        .route("/api/v1/agents", get(list_agents))
        .route("/api/v1/agents/{id}", get(get_agent))
        .route("/api/v1/agents/{id}/sessions", get(get_agent_sessions))
        .route("/api/v1/agents/{id}/executions", get(get_agent_executions))
        .route(
            "/api/v1/agents/{id}/messages",
            get(get_agent_messages).post(send_agent_message),
        )
        .route("/api/v1/agents/{id}/pause", post(pause_agent))
        .route("/api/v1/agents/{id}/resume", post(resume_agent))
        .route("/api/v1/agents/{id}/cancel", post(cancel_agent))
        .route("/api/v1/agents/{id}/message", post(send_agent_message))
        // Commands
        .route("/api/v1/commands", post(enqueue_command))
        // Events
        .route("/api/v1/events", get(list_recent_events))
        .route("/api/v1/events/cursor", get(list_events_cursor))
        .route("/api/v1/events/stream", get(stream_events))
        // Approvals
        .route(
            "/api/v1/approvals",
            get(list_approvals).post(create_approval_gate),
        )
        .route("/api/v1/approvals/{id}", get(get_approval))
        .route("/api/v1/approvals/{id}/approve", post(approve_gate))
        .route("/api/v1/approvals/{id}/reject", post(reject_gate))
        // Memories
        .route("/api/v1/memories", get(list_memories))
        .route("/api/v1/memories/{id}", get(get_memory))
        // Providers
        .route("/api/v1/providers", get(list_providers))
        .route(
            "/api/v1/providers/capabilities",
            get(get_provider_capabilities),
        )
        // Tools
        .route("/api/v1/tools", get(list_tools))
        // Workspaces & Git
        .route(
            "/api/v1/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route(
            "/api/v1/workspaces/{id}",
            get(get_workspace)
                .put(update_workspace)
                .delete(delete_workspace),
        )
        .route(
            "/api/v1/workspaces/{id}/git/status",
            get(workspace_git_status),
        )
        .route("/api/v1/workspaces/{id}/git/diff", get(workspace_git_diff))
        .route("/api/v1/workspaces/{id}/git/log", get(workspace_git_log))
        .route(
            "/api/v1/workspaces/{id}/git/commit",
            post(workspace_git_commit),
        )
        // Task Terminal
        .route(
            "/api/v1/tasks/{id}/terminal",
            get(get_task_terminal).post(post_task_terminal),
        )
        // Retention Pruning
        .route("/api/v1/retention/prune", post(prune_retention_records))
        // GitHub Integration
        .route("/api/v1/github/repos", get(list_github_repos))
        .route(
            "/api/v1/github/pulls",
            get(list_github_pulls).post(create_github_pull),
        )
        .route("/api/v1/github/issues", get(list_github_issues))
        // Agent Host & External Process Supervision
        .route("/api/v1/agent-host/backends", get(list_agent_backends))
        .route(
            "/api/v1/agent-host/backends/gemini",
            get(get_gemini_backend_probe),
        )
        .route(
            "/api/v1/agent-host/executions",
            get(list_agent_host_executions).post(execute_agent_host),
        )
        .route(
            "/api/v1/agent-host/executions/{id}",
            get(get_agent_host_execution),
        )
        .route(
            "/api/v1/agent-host/executions/{id}/events",
            get(get_agent_host_execution_events),
        )
        .route(
            "/api/v1/agent-host/executions/{id}/cancel",
            post(cancel_agent_host_execution),
        )
        // Missions (Milestone 15)
        .route("/api/v1/missions", get(list_missions).post(create_mission))
        .route("/api/v1/missions/{id}", get(get_mission))
        .route("/api/v1/missions/{id}/start", post(start_mission))
        .route("/api/v1/missions/{id}/pause", post(pause_mission))
        .route("/api/v1/missions/{id}/resume", post(resume_mission))
        .route("/api/v1/missions/{id}/cancel", post(cancel_mission))
        .route("/api/v1/missions/{id}/step", post(step_mission))
        .route("/api/v1/missions/{id}/events", get(list_mission_events))
        .route(
            "/api/v1/missions/{id}/checkpoints",
            get(list_mission_checkpoints),
        )
        .route("/api/v1/missions/{id}/cycles", get(list_mission_cycles))
        .route("/api/v1/missions/{id}/status", get(get_mission_status))
        .route("/api/v1/missions/{id}/diff", get(get_mission_diff))
        .route("/api/v1/missions/{id}/review", get(get_mission_review))
        .route("/api/v1/missions/{id}/accept", post(accept_mission))
        .route("/api/v1/missions/{id}/reject", post(reject_mission))
        .route("/api/v1/missions/{id}/integrate", post(integrate_mission))
        .route("/api/v1/missions/{id}/run", post(run_mission_background))
        .route("/api/v1/missions/{id}/escalate", post(escalate_mission))
        .route("/api/v1/missions/{id}/resolve", post(resolve_mission))
        .route("/api/v1/system/reconcile", post(system_reconcile))
        .route("/api/v1/reconcile", post(system_reconcile))
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth_middleware,
        ))
        .layer(DefaultBodyLimit::max(10 * 1024 * 1024))
        .layer(cors);

    // Static SPA service
    let dist_dir = std::path::Path::new("web/dist");
    if dist_dir.exists() {
        let serve_dir =
            ServeDir::new(dist_dir).fallback(ServeFile::new(dist_dir.join("index.html")));
        Router::new()
            .merge(api_router)
            .fallback_service(serve_dir)
            .with_state(state)
    } else {
        Router::new()
            .merge(api_router)
            .fallback(get(spa_fallback_page))
            .with_state(state)
    }
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    version: &'static str,
}

async fn health_check() -> impl IntoResponse {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize)]
struct SystemStatusResponse {
    system: &'static str,
    database: &'static str,
    version: &'static str,
}

async fn system_status() -> impl IntoResponse {
    Json(SystemStatusResponse {
        system: "axonel-control-plane",
        database: "sqlite-authoritative",
        version: env!("CARGO_PKG_VERSION"),
    })
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct AuthStatusResponse {
    pub auth_required: bool,
    pub mode: String,
    pub bind_host: String,
    pub is_loopback: bool,
}

async fn auth_status(State(state): State<AppState>) -> impl IntoResponse {
    let auth_required = state.auth_token.is_some();
    let mode = if auth_required {
        "token".to_string()
    } else if state.is_loopback {
        "local_loopback".to_string()
    } else {
        "unauthenticated".to_string()
    };
    Json(AuthStatusResponse {
        auth_required,
        mode,
        bind_host: state.bind_host.clone(),
        is_loopback: state.is_loopback,
    })
}

/// Standardized structured JSON error envelope for API consumers.
#[derive(Debug, Serialize, Deserialize)]
pub struct ApiError {
    pub error: String,
    pub status: u16,
}

impl ApiError {
    pub fn new(status: StatusCode, error: impl Into<String>) -> (StatusCode, Json<ApiError>) {
        (
            status,
            Json(ApiError {
                error: error.into(),
                status: status.as_u16(),
            }),
        )
    }
}

// ---------------------------------------------------------------------------
// Dashboard Summary
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
pub struct DashboardSummary {
    pub total_workflows: usize,
    pub active_workflows: usize,
    pub running_tasks: usize,
    pub verified_tasks: usize,
    pub total_agents: usize,
    pub busy_agents: usize,
    pub pending_approvals: usize,
    pub recent_failures: usize,
    pub latest_event_sequence: u64,
    pub workflows: Vec<Workflow>,
    pub active_tasks: Vec<Task>,
    pub busy_agents_list: Vec<Agent>,
    pub provider_health: serde_json::Value,
}

async fn dashboard_summary(
    State(state): State<AppState>,
) -> Result<Json<DashboardSummary>, (StatusCode, Json<ApiError>)> {
    let workflows = state
        .store
        .list_workflows()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let total_workflows = workflows.len();
    let active_workflows = workflows
        .iter()
        .filter(|w| {
            matches!(
                w.state,
                WorkflowState::Active | WorkflowState::Draft | WorkflowState::Paused
            )
        })
        .count();

    let mut running_tasks = 0;
    let mut verified_tasks = 0;
    let mut recent_failures = 0;
    let mut active_tasks = Vec::new();

    for wf in &workflows {
        if let Ok(tasks) = state.store.list_tasks_by_workflow(&wf.id).await {
            for t in tasks {
                match t.state {
                    TaskState::Running | TaskState::Assigned => {
                        running_tasks += 1;
                        active_tasks.push(t);
                    }
                    TaskState::Verified => verified_tasks += 1,
                    TaskState::Failed => recent_failures += 1,
                    _ => {}
                }
            }
        }
    }

    let agents = state
        .store
        .list_agents()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let total_agents = agents.len();
    let busy_agents_list: Vec<Agent> = agents
        .iter()
        .filter(|a| a.state == AgentState::Busy)
        .cloned()
        .collect();
    let busy_agents = busy_agents_list.len();

    let pending_approvals = state
        .store
        .list_pending_approvals()
        .await
        .map(|a| a.len())
        .unwrap_or(0);

    let latest_event_sequence = state.store.get_latest_event_sequence().await.unwrap_or(0);

    let provider_health = serde_json::json!({
        "openai": {
            "provider_type": "llm",
            "status": "healthy",
            "latency_ms": 42
        },
        "anthropic": {
            "provider_type": "llm",
            "status": "healthy",
            "latency_ms": 55
        },
        "gemini": {
            "provider_type": "llm",
            "status": "healthy",
            "latency_ms": 38
        }
    });

    Ok(Json(DashboardSummary {
        total_workflows,
        active_workflows,
        running_tasks,
        verified_tasks,
        total_agents,
        busy_agents,
        pending_approvals,
        recent_failures,
        latest_event_sequence,
        workflows,
        active_tasks,
        busy_agents_list,
        provider_health,
    }))
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListWorkflowsQuery {
    pub status: Option<String>,
    pub workspace_id: Option<String>,
    pub limit: Option<usize>,
    pub offset: Option<usize>,
}

async fn list_workflows(
    State(state): State<AppState>,
    Query(params): Query<ListWorkflowsQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let mut workflows = if let Some(ref ws_str) = params.workspace_id {
        if let Ok(ws_id) = ws_str.parse::<WorkspaceId>() {
            state
                .store
                .list_workflows_by_workspace(&ws_id)
                .await
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        } else {
            state
                .store
                .list_workflows()
                .await
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        }
    } else {
        state
            .store
            .list_workflows()
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };

    if let Some(st) = params.status {
        workflows.retain(|w| w.state.as_str().eq_ignore_ascii_case(&st));
    }

    let offset = params.offset.unwrap_or(0);
    let limit = params.limit.unwrap_or(100);
    let paginated: Vec<_> = workflows.into_iter().skip(offset).take(limit).collect();

    Ok(Json(paginated))
}

#[derive(Deserialize)]
pub struct CreateWorkflowRequest {
    #[serde(alias = "name")]
    pub title: String,
    #[serde(alias = "description")]
    pub objective: String,
    #[serde(default)]
    pub workspace_id: Option<WorkspaceId>,
    #[serde(default)]
    pub auto_plan: Option<bool>,
    #[serde(default)]
    pub auto_start: Option<bool>,
    #[serde(default)]
    pub constraints: Option<String>,
    #[serde(default)]
    pub backend: Option<String>,
    #[serde(default)]
    pub metadata: Option<serde_json::Value>,
}

async fn create_workflow(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkflowRequest>,
) -> Result<(StatusCode, Json<Workflow>), (StatusCode, Json<ApiError>)> {
    if req.title.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Workflow title cannot be empty",
        ));
    }
    if req.objective.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Workflow objective cannot be empty",
        ));
    }

    let mut wf = Workflow::new(req.title, req.objective);
    if let Some(ws_id) = req.workspace_id {
        wf.workspace_id = Some(ws_id);
    }
    if let Some(ref m) = req.metadata {
        wf.metadata = m.clone();
    }
    if let Some(ref c) = req.constraints {
        wf.metadata["constraints"] = serde_json::json!(c);
    }
    if let Some(ref b) = req.backend {
        wf.metadata["backend"] = serde_json::json!(b);
    } else if wf.metadata.get("backend").is_none() {
        wf.metadata["backend"] = serde_json::json!("gemini_cli");
    }

    state
        .store
        .create_workflow(&wf)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let should_plan = req.auto_plan.unwrap_or(true);
    let should_start = req.auto_start.unwrap_or(false);

    if should_plan {
        if let Err(e) = plan_workflow_objective(&state.store, &wf).await {
            tracing::warn!("Auto-plan failed for workflow {}: {}", wf.id, e);
        }
    }

    if should_start {
        spawn_workflow_execution(state.clone(), wf.id);
    }

    Ok((StatusCode::CREATED, Json(wf)))
}

async fn get_workflow(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Workflow>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let wf = state
        .store
        .get_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workflow {} not found", id))
        })?;
    Ok(Json(wf))
}

async fn list_workflow_tasks(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<Task>>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let tasks = state
        .store
        .list_tasks_by_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(tasks))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphNode {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub objective: String,
    pub description: Option<String>,
    pub state: String,
    pub assigned_agent_id: Option<String>,
    pub assigned_agent_name: Option<String>,
    pub required_capabilities: Vec<String>,
    pub priority: i32,
    pub is_runnable: bool,
    pub is_blocked: bool,
    pub verifications_count: usize,
    pub is_verified: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub is_satisfied: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GraphSummary {
    pub total: usize,
    pub pending: usize,
    pub running: usize,
    pub verified: usize,
    pub failed: usize,
    pub blocked: usize,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct WorkflowGraphResponse {
    pub workflow_id: String,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub summary: GraphSummary,
}

async fn get_workflow_graph(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<WorkflowGraphResponse>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;

    let graph = state
        .store
        .load_task_graph(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let tasks = state
        .store
        .list_tasks_by_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let agents = state
        .store
        .list_agents()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let agent_map: HashMap<AgentId, String> =
        agents.into_iter().map(|a| (a.id, a.display_name)).collect();

    let runnable_ids = graph.find_runnable_tasks();
    let mut task_map: HashMap<TaskId, Task> = HashMap::new();
    for t in &tasks {
        task_map.insert(t.id, t.clone());
    }

    let mut nodes = Vec::new();
    for task in &tasks {
        let is_runnable = runnable_ids.contains(&task.id);
        let dependencies = graph.direct_dependencies(&task.id);
        let is_blocked = dependencies
            .iter()
            .any(|dep_id| match task_map.get(dep_id) {
                Some(dep) => !dep.state.is_terminal(),
                None => false,
            });

        let verifications_count = state
            .store
            .list_verifications_by_task(&task.id)
            .await
            .map(|v| v.len())
            .unwrap_or(0);

        let assigned_agent_name = task
            .assigned_agent_id
            .and_then(|aid| agent_map.get(&aid).cloned());

        nodes.push(GraphNode {
            id: task.id.to_string(),
            title: task.objective.clone(),
            objective: task.objective.clone(),
            description: task.description.clone(),
            state: task.state.as_str().to_string(),
            assigned_agent_id: task.assigned_agent_id.map(|aid| aid.to_string()),
            assigned_agent_name,
            required_capabilities: task.required_capabilities(),
            priority: task.priority,
            is_runnable,
            is_blocked,
            verifications_count,
            is_verified: task.state == TaskState::Verified,
        });
    }

    let mut edges = Vec::new();
    for task in &tasks {
        for dep_id in graph.direct_dependencies(&task.id) {
            let is_satisfied = match task_map.get(&dep_id) {
                Some(dep) => dep.state == TaskState::Verified,
                None => false,
            };
            edges.push(GraphEdge {
                from: dep_id.to_string(),
                to: task.id.to_string(),
                is_satisfied,
            });
        }
    }

    let total = tasks.len();
    let mut pending = 0;
    let mut running = 0;
    let mut verified = 0;
    let mut failed = 0;
    let mut blocked = 0;

    for n in &nodes {
        if n.is_blocked {
            blocked += 1;
        }
        match n.state.as_str() {
            "Verified" => verified += 1,
            "Running" | "Assigned" => running += 1,
            "Failed" => failed += 1,
            _ => pending += 1,
        }
    }

    let summary = GraphSummary {
        total,
        pending,
        running,
        verified,
        failed,
        blocked,
    };

    Ok(Json(WorkflowGraphResponse {
        workflow_id: id.to_string(),
        nodes,
        edges,
        summary,
    }))
}

async fn plan_workflow(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<PlanProposal>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let wf = state
        .store
        .get_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workflow {} not found", id))
        })?;

    let proposal = plan_workflow_objective(&state.store, &wf)
        .await
        .map_err(|e| ApiError::new(StatusCode::BAD_REQUEST, e))?;
    Ok(Json(proposal))
}

async fn start_workflow(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Workflow>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let mut wf = state
        .store
        .get_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workflow {} not found", id))
        })?;

    // Check if workflow has tasks; if none, auto-plan first
    let tasks = state
        .store
        .list_tasks_by_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    if tasks.is_empty() {
        let _ = plan_workflow_objective(&state.store, &wf).await;
    }

    if wf.state == WorkflowState::Draft || wf.state == WorkflowState::Paused {
        let _ = wf.state.transition_to(WorkflowState::Active);
        state
            .store
            .update_workflow(&wf)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    }

    spawn_workflow_execution(state, id);
    Ok(Json(wf))
}

async fn pause_workflow(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Workflow>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let mut wf = state
        .store
        .get_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workflow {} not found", id))
        })?;

    wf.state
        .transition_to(WorkflowState::Paused)
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;
    state
        .store
        .update_workflow(&wf)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "workflow",
        id.to_string(),
        "workflow.paused",
        serde_json::json!({ "workflow_id": id.to_string() }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(wf))
}

async fn resume_workflow(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Workflow>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let mut wf = state
        .store
        .get_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workflow {} not found", id))
        })?;

    wf.state
        .transition_to(WorkflowState::Active)
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;
    state
        .store
        .update_workflow(&wf)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    spawn_workflow_execution(state.clone(), id);

    let evt = Event::new(
        "workflow",
        id.to_string(),
        "workflow.resumed",
        serde_json::json!({ "workflow_id": id.to_string() }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(wf))
}

async fn cancel_workflow(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Workflow>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let mut wf = state
        .store
        .get_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workflow {} not found", id))
        })?;

    wf.state
        .transition_to(WorkflowState::Cancelled)
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;
    state
        .store
        .update_workflow(&wf)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "workflow",
        id.to_string(),
        "workflow.cancelled",
        serde_json::json!({ "workflow_id": id.to_string() }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(wf))
}

async fn list_workflow_messages(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<AgentMessage>>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let msgs = state
        .store
        .list_messages_by_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(msgs))
}

async fn list_workflow_recoveries(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<RecoveryRecord>>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let recs = state
        .store
        .list_recovery_records_by_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(recs))
}

async fn list_workflow_verifications(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<Verification>>, (StatusCode, Json<ApiError>)> {
    let id: WorkflowId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workflow id: {}", id_str),
        )
    })?;
    let vers = state
        .store
        .list_verifications_by_workflow(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(vers))
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

async fn get_task(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Task>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;
    let task = state
        .store
        .get_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Task {} not found", id)))?;
    Ok(Json(task))
}

#[derive(Serialize)]
pub struct TaskDependenciesResponse {
    pub task_id: TaskId,
    pub dependencies: Vec<Task>,
    pub prerequisites: Vec<Task>,
    pub dependents: Vec<Task>,
}

async fn get_task_dependencies(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<TaskDependenciesResponse>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;

    let dep_ids = state
        .store
        .get_dependencies(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    let down_ids = state
        .store
        .get_dependents(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let mut dependencies = Vec::new();
    for did in dep_ids {
        if let Ok(Some(t)) = state.store.get_task(&did).await {
            dependencies.push(t);
        }
    }

    let mut dependents = Vec::new();
    for did in down_ids {
        if let Ok(Some(t)) = state.store.get_task(&did).await {
            dependents.push(t);
        }
    }

    Ok(Json(TaskDependenciesResponse {
        task_id: id,
        dependencies: dependencies.clone(),
        prerequisites: dependencies,
        dependents,
    }))
}

async fn get_task_executions(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<Execution>>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;
    let execs = state
        .store
        .list_executions_by_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(execs))
}

async fn get_task_verifications(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<Verification>>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;
    let vers = state
        .store
        .list_verifications_by_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(vers))
}

async fn get_task_messages(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<AgentMessage>>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;
    let msgs = state
        .store
        .list_messages_by_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(msgs))
}

async fn get_task_recoveries(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<RecoveryRecord>>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;
    let recs = state
        .store
        .list_recovery_records_by_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(recs))
}

#[derive(Deserialize)]
pub struct ReassignTaskRequest {
    pub agent_id: String,
}

async fn reassign_task(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(req): Json<ReassignTaskRequest>,
) -> Result<Json<Task>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;
    let agent_id: AgentId = req.agent_id.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", req.agent_id),
        )
    })?;

    let mut task = state
        .store
        .get_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Task {} not found", id)))?;

    task.assigned_agent_id = Some(agent_id);
    state
        .store
        .update_task(&task)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "task",
        id.to_string(),
        "task.reassigned",
        serde_json::json!({
            "task_id": id.to_string(),
            "new_agent_id": agent_id.to_string(),
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(task))
}

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

async fn list_agents(
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let _ = ensure_default_agents(&state.store, None).await;
    let agents = state
        .store
        .list_agents()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(agents))
}

async fn get_agent(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Agent>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let agent = state
        .store
        .get_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Agent {} not found", id)))?;
    Ok(Json(agent))
}

async fn get_agent_sessions(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<Session>>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let sessions = state
        .store
        .list_sessions_by_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(sessions))
}

async fn get_agent_executions(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<Execution>>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let execs = state
        .store
        .list_executions_by_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(execs))
}

async fn get_agent_messages(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Vec<AgentMessage>>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let msgs = state
        .store
        .list_messages_for_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(msgs))
}

async fn pause_agent(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Agent>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let mut agent = state
        .store
        .get_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Agent {} not found", id)))?;

    agent.state = AgentState::Paused;
    state
        .store
        .update_agent(&agent)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "agent",
        id.to_string(),
        "agent.paused",
        serde_json::json!({ "agent_id": id.to_string() }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(agent))
}

async fn resume_agent(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Agent>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let mut agent = state
        .store
        .get_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Agent {} not found", id)))?;

    agent.state = AgentState::Idle;
    state
        .store
        .update_agent(&agent)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "agent",
        id.to_string(),
        "agent.resumed",
        serde_json::json!({ "agent_id": id.to_string() }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(agent))
}

async fn cancel_agent(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Agent>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;
    let mut agent = state
        .store
        .get_agent(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Agent {} not found", id)))?;

    agent.state = AgentState::Terminated;
    state
        .store
        .update_agent(&agent)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "agent",
        id.to_string(),
        "agent.cancelled",
        serde_json::json!({ "agent_id": id.to_string() }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(agent))
}

#[derive(Deserialize)]
pub struct SendAgentMessageRequest {
    pub content: String,
    pub message_type: Option<String>,
    pub workflow_id: Option<String>,
    pub task_id: Option<String>,
}

async fn send_agent_message(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(req): Json<SendAgentMessageRequest>,
) -> Result<Json<AgentMessage>, (StatusCode, Json<ApiError>)> {
    let id: AgentId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid agent id: {}", id_str),
        )
    })?;

    let wf_id: WorkflowId = match req.workflow_id {
        Some(ref s) if !s.trim().is_empty() => s.parse().map_err(|_| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                format!("Invalid workflow id: {}", s),
            )
        })?,
        _ => {
            if let Ok(wfs) = state.store.list_workflows().await {
                if let Some(w) = wfs.first() {
                    w.id
                } else {
                    let default_wf =
                        Workflow::new("System Workflow", "Default operator messaging workflow");
                    let _ = state.store.create_workflow(&default_wf).await;
                    default_wf.id
                }
            } else {
                let default_wf =
                    Workflow::new("System Workflow", "Default operator messaging workflow");
                let _ = state.store.create_workflow(&default_wf).await;
                default_wf.id
            }
        }
    };

    let tid: Option<TaskId> = req
        .task_id
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| s.parse().ok());
    let msg_type = match req.message_type.as_deref() {
        Some("request") => MessageType::Request,
        Some("question") => MessageType::Question,
        Some("warning") => MessageType::Warning,
        Some("review") => MessageType::Review,
        Some("proposal") => MessageType::Proposal,
        _ => MessageType::Result,
    };

    let operator_agent_id = AgentId::new();
    let mut msg = AgentMessage::new(operator_agent_id, id, wf_id, msg_type, req.content);
    if let Some(t) = tid {
        msg.task_id = Some(t);
    }

    state
        .store
        .send_message(&msg)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "message",
        msg.id.to_string(),
        "message.sent",
        serde_json::json!({
            "message_id": msg.id.to_string(),
            "to_agent": id.to_string(),
            "content": msg.content,
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(msg))
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async fn enqueue_command(
    State(state): State<AppState>,
    Json(cmd): Json<Command>,
) -> Result<(StatusCode, Json<Command>), (StatusCode, Json<ApiError>)> {
    if cmd.idempotency_key.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Command idempotency_key cannot be empty",
        ));
    }

    match state.store.enqueue_command(&cmd).await {
        Ok(_) => Ok((StatusCode::ACCEPTED, Json(cmd))),
        Err(plexis_storage::StorageError::IdempotencyConflict(_)) => Err(ApiError::new(
            StatusCode::CONFLICT,
            "Command with this idempotency key already exists",
        )),
        Err(e) => Err(ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            e.to_string(),
        )),
    }
}

// ---------------------------------------------------------------------------
// Events & SSE Live Stream
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListEventsQuery {
    pub limit: Option<usize>,
    pub aggregate_type: Option<String>,
    pub aggregate_id: Option<String>,
}

async fn list_recent_events(
    State(state): State<AppState>,
    Query(params): Query<ListEventsQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    let limit = params.limit.unwrap_or(50);
    let events = if let (Some(at), Some(aid)) = (params.aggregate_type, params.aggregate_id) {
        state
            .store
            .list_events_by_aggregate(&at, &aid)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
        state
            .store
            .list_recent_events(limit)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };
    Ok(Json(events))
}

#[derive(Deserialize)]
pub struct CursorEventsQuery {
    pub after: Option<u64>,
    pub limit: Option<usize>,
}

async fn list_events_cursor(
    State(state): State<AppState>,
    Query(params): Query<CursorEventsQuery>,
) -> Result<Json<Vec<Event>>, (StatusCode, Json<ApiError>)> {
    let after_seq = params.after.unwrap_or(0);
    let limit = params.limit.unwrap_or(500);
    let events = state
        .store
        .list_events_after(after_seq, limit)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(events))
}

#[derive(Debug, Deserialize)]
pub struct SseParams {
    pub after: Option<u64>,
}

async fn stream_events(
    State(state): State<AppState>,
    Query(params): Query<SseParams>,
    headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<AxumSseEvent, Infallible>>> {
    let mut after_seq = params.after;
    if after_seq.is_none() {
        if let Some(val) = headers.get("last-event-id") {
            if let Ok(s) = val.to_str() {
                after_seq = s.parse().ok();
            }
        }
    }

    let stream = async_stream::stream! {
        let mut last_seen = after_seq.unwrap_or(0);
        let mut rx = state.store.subscribe_events();

        // 1. Replay missed durable events
        if last_seen > 0 {
            if let Ok(missed) = state.store.list_events_after(last_seen, 1000).await {
                for evt in missed {
                    let seq = evt.sequence.unwrap_or(0);
                    if seq > last_seen {
                        last_seen = seq;
                    }
                    if let Ok(data) = serde_json::to_string(&evt) {
                        yield Ok(AxumSseEvent::default()
                            .id(seq.to_string())
                            .event("message")
                            .data(data));
                    }
                }
            }
        }

        // 2. Stream live broadcast events
        while let Ok(evt) = rx.recv().await {
            let seq = evt.sequence.unwrap_or(0);
            if seq > last_seen {
                last_seen = seq;
                if let Ok(data) = serde_json::to_string(&evt) {
                    yield Ok(AxumSseEvent::default()
                        .id(seq.to_string())
                        .event("message")
                        .data(data));
                }
            }
        }
    };

    Sse::new(stream).keep_alive(KeepAlive::default())
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListApprovalsQuery {
    pub status: Option<String>,
}

async fn list_approvals(
    State(state): State<AppState>,
    Query(query): Query<ListApprovalsQuery>,
) -> Result<Json<Vec<ApprovalRecord>>, (StatusCode, Json<ApiError>)> {
    let approvals = if let Some(ref st) = query.status {
        if st.eq_ignore_ascii_case("all") {
            state
                .store
                .list_all_approvals()
                .await
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        } else if st.eq_ignore_ascii_case("pending") {
            state
                .store
                .list_pending_approvals()
                .await
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        } else {
            let all = state
                .store
                .list_all_approvals()
                .await
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
            all.into_iter()
                .filter(|a| a.state.as_str().eq_ignore_ascii_case(st))
                .collect()
        }
    } else {
        state
            .store
            .list_pending_approvals()
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };

    Ok(Json(approvals))
}

#[derive(Debug, Deserialize)]
pub struct CreateApprovalPayload {
    pub workflow_id: WorkflowId,
    pub task_id: TaskId,
    pub action_description: String,
    pub reason: Option<String>,
}

async fn create_approval_gate(
    State(state): State<AppState>,
    Json(payload): Json<CreateApprovalPayload>,
) -> Result<(StatusCode, Json<ApprovalRecord>), (StatusCode, Json<ApiError>)> {
    let mut approval = ApprovalRecord::new(
        payload.task_id,
        payload.workflow_id,
        payload.action_description,
    );
    if let Some(r) = payload.reason {
        approval = approval.with_reason(r);
    }
    state
        .store
        .create_approval(&approval)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "approval",
        approval.id.to_string(),
        "approval.gate_requested",
        serde_json::json!({
            "approval_id": approval.id.to_string(),
            "workflow_id": approval.workflow_id.to_string(),
            "task_id": approval.task_id.to_string(),
            "action_description": approval.action_description,
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok((StatusCode::CREATED, Json(approval)))
}

async fn get_approval(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<ApprovalRecord>, (StatusCode, Json<ApiError>)> {
    let id: ApprovalId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid approval id: {}", id_str),
        )
    })?;
    let approval = state
        .store
        .get_approval(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Approval {} not found", id))
        })?;
    Ok(Json(approval))
}

#[derive(Debug, Deserialize, Default)]
pub struct DecisionPayload {
    pub decider: Option<String>,
    #[serde(alias = "notes", alias = "reason")]
    pub note: Option<String>,
}

async fn approve_gate(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(payload): Json<DecisionPayload>,
) -> Result<Json<ApprovalRecord>, (StatusCode, Json<ApiError>)> {
    let id: ApprovalId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid approval id: {}", id_str),
        )
    })?;
    let mut approval = state
        .store
        .get_approval(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Approval {} not found", id))
        })?;

    let decider = payload.decider.as_deref().unwrap_or("operator");
    approval
        .approve(payload.note)
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;

    state
        .store
        .update_approval(&approval)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // If there is an associated task waiting in NeedsHuman, unblock it to Ready
    if let Ok(Some(mut task)) = state.store.get_task(&approval.task_id).await {
        if task.state == TaskState::NeedsHuman {
            task.assigned_agent_id = None;
            let _ = task.transition_to(TaskState::Ready);
            let _ = state.store.update_task(&task).await;
        }
    }

    let evt = Event::new(
        "approval",
        approval.id.to_string(),
        "approval.gate_decided",
        serde_json::json!({
            "decision": "approved",
            "decider": decider,
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(approval))
}

async fn reject_gate(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(payload): Json<DecisionPayload>,
) -> Result<Json<ApprovalRecord>, (StatusCode, Json<ApiError>)> {
    let id: ApprovalId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid approval id: {}", id_str),
        )
    })?;
    let mut approval = state
        .store
        .get_approval(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Approval {} not found", id))
        })?;

    let decider = payload.decider.as_deref().unwrap_or("operator");
    let reason = payload
        .note
        .unwrap_or_else(|| "Rejected by operator".to_string());
    approval
        .reject(Some(reason))
        .map_err(|e| ApiError::new(StatusCode::CONFLICT, e.to_string()))?;

    state
        .store
        .update_approval(&approval)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    // If there is an associated task waiting in NeedsHuman, move to Failed
    if let Ok(Some(mut task)) = state.store.get_task(&approval.task_id).await {
        if task.state == TaskState::NeedsHuman {
            let _ = task.transition_to(TaskState::Failed);
            let _ = state.store.update_task(&task).await;
        }
    }

    let evt = Event::new(
        "approval",
        approval.id.to_string(),
        "approval.gate_decided",
        serde_json::json!({
            "decision": "rejected",
            "decider": decider,
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(approval))
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListMemoriesQuery {
    pub scope: Option<String>,
    pub limit: Option<usize>,
}

async fn list_memories(
    State(state): State<AppState>,
    Query(params): Query<ListMemoriesQuery>,
) -> Result<Json<Vec<MemoryRecord>>, (StatusCode, Json<ApiError>)> {
    let limit = params.limit.unwrap_or(100);
    let scope_opt = params.scope.and_then(|s| match s.to_lowercase().as_str() {
        "user" => Some(MemoryScope::User),
        "project" => Some(MemoryScope::Project),
        "workflow" => Some(MemoryScope::Workflow),
        "task" => Some(MemoryScope::Task),
        "agent" => Some(MemoryScope::Agent),
        "session" => Some(MemoryScope::Session),
        "artifact" => Some(MemoryScope::Artifact),
        "system" => Some(MemoryScope::System),
        _ => None,
    });

    let memories = if let Some(scope) = scope_opt {
        state
            .store
            .list_memories_by_scope(scope, None)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    } else {
        state
            .store
            .list_active_memories(None, None, limit)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
    };

    Ok(Json(memories))
}

async fn get_memory(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<MemoryRecord>, (StatusCode, Json<ApiError>)> {
    let id: MemoryId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid memory id: {}", id_str),
        )
    })?;
    let mem = state
        .store
        .get_memory(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Memory {} not found", id)))?;
    Ok(Json(mem))
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ProviderStatusItem {
    pub id: &'static str,
    pub name: &'static str,
    pub status: &'static str,
    pub models: Vec<&'static str>,
    pub is_available: bool,
}

async fn list_providers() -> impl IntoResponse {
    let providers = vec![
        ProviderStatusItem {
            id: "openai",
            name: "OpenAI Provider",
            status: "configured",
            models: vec!["gpt-4o", "gpt-4o-mini", "o3-mini"],
            is_available: true,
        },
        ProviderStatusItem {
            id: "anthropic",
            name: "Anthropic Provider",
            status: "configured",
            models: vec!["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
            is_available: true,
        },
        ProviderStatusItem {
            id: "gemini",
            name: "Google Gemini Provider",
            status: "configured",
            models: vec!["gemini-1.5-pro", "gemini-1.5-flash", "gemini-2.0-flash"],
            is_available: true,
        },
        ProviderStatusItem {
            id: "ollama",
            name: "Ollama Local Provider",
            status: "local",
            models: vec!["llama3.1", "qwen2.5-coder", "deepseek-r1"],
            is_available: true,
        },
        ProviderStatusItem {
            id: "scripted",
            name: "Plexis Deterministic / Test Provider",
            status: "ready",
            models: vec!["scripted-v1"],
            is_available: true,
        },
    ];
    Json(providers)
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct ToolCatalogItem {
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub parameters_schema: serde_json::Value,
    pub backend_isolation: &'static str,
}

async fn list_tools(State(state): State<AppState>) -> impl IntoResponse {
    let tools = state.tool_registry.list_tools();
    let backend_isolation = if std::path::Path::new("/usr/bin/bwrap").exists() {
        "Bubblewrap (Linux namespaces)"
    } else {
        "HostProcess (kill_on_drop)"
    };

    let catalog: Vec<_> = tools
        .into_iter()
        .map(|t| ToolCatalogItem {
            name: t.name().to_string(),
            description: t.description().to_string(),
            capabilities: vec![t.name().to_string()],
            parameters_schema: t.schema(),
            backend_isolation,
        })
        .collect();

    Json(catalog)
}

// ---------------------------------------------------------------------------
// Auth & Provider Capabilities
// ---------------------------------------------------------------------------

pub async fn auth_middleware(
    State(state): State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path();
    if path == "/health"
        || path == "/api/v1/health"
        || path == "/api/v1/system/status"
        || path == "/api/v1/auth/status"
        || !path.starts_with("/api/")
    {
        return next.run(req).await;
    }

    if state.auth_token.is_some() {
        if let Some(auth_header) = req
            .headers()
            .get("authorization")
            .and_then(|h| h.to_str().ok())
        {
            if let Some(token) = auth_header.strip_prefix("Bearer ") {
                if state.is_authorized_token(token.trim()) {
                    return next.run(req).await;
                }
            }
        }

        if let Some(query) = req.uri().query() {
            for param in query.split('&') {
                if let Some((k, v)) = param.split_once('=') {
                    if k == "token" && state.is_authorized_token(v) {
                        return next.run(req).await;
                    }
                }
            }
        }

        return ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Unauthorized: invalid or missing authentication token",
        )
        .into_response();
    }

    next.run(req).await
}

async fn get_provider_capabilities(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.capability_matrix.clone())
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateWorkspacePayload {
    pub name: String,
    pub canonical_path: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub is_default: Option<bool>,
    #[serde(default)]
    pub security_policy: Option<WorkspaceSecurityPolicy>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateWorkspacePayload {
    pub name: Option<String>,
    pub description: Option<String>,
    pub security_policy: Option<WorkspaceSecurityPolicy>,
}

async fn list_workspaces(
    State(state): State<AppState>,
) -> Result<Json<Vec<Workspace>>, (StatusCode, Json<ApiError>)> {
    let workspaces = state
        .store
        .list_workspaces()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(workspaces))
}

async fn create_workspace(
    State(state): State<AppState>,
    Json(payload): Json<CreateWorkspacePayload>,
) -> Result<(StatusCode, Json<Workspace>), (StatusCode, Json<ApiError>)> {
    if payload.name.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Workspace name cannot be empty",
        ));
    }
    if payload.canonical_path.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Workspace canonical_path cannot be empty",
        ));
    }

    let mut ws = Workspace::new(&payload.name, &payload.canonical_path);
    let mut meta_map = serde_json::Map::new();
    if let Some(desc) = payload.description {
        meta_map.insert("description".into(), serde_json::Value::String(desc));
    }
    if let Some(is_def) = payload.is_default {
        meta_map.insert("is_default".into(), serde_json::Value::Bool(is_def));
    }
    ws.metadata = serde_json::Value::Object(meta_map);

    if let Some(sec) = payload.security_policy {
        ws.policy = sec;
    }

    if let Ok(meta) = git::discover_git_metadata(&ws.canonical_path) {
        ws.vcs = meta;
    }

    state
        .store
        .create_workspace(&ws)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "workspace",
        ws.id.to_string(),
        "workspace.created",
        serde_json::json!({
            "workspace_id": ws.id.to_string(),
            "name": ws.name,
            "canonical_path": ws.canonical_path.display().to_string(),
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok((StatusCode::CREATED, Json(ws)))
}

async fn get_workspace(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<Workspace>, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    let mut ws = state
        .store
        .get_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workspace {} not found", id))
        })?;

    if let Ok(meta) = git::discover_git_metadata(&ws.canonical_path) {
        ws.vcs = meta;
    }

    Ok(Json(ws))
}

async fn update_workspace(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(payload): Json<UpdateWorkspacePayload>,
) -> Result<Json<Workspace>, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    let mut ws = state
        .store
        .get_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workspace {} not found", id))
        })?;

    if let Some(name) = payload.name {
        if !name.trim().is_empty() {
            ws.name = name;
        }
    }
    if let Some(desc) = payload.description {
        if let Some(obj) = ws.metadata.as_object_mut() {
            obj.insert("description".into(), serde_json::Value::String(desc));
        }
    }
    if let Some(sec) = payload.security_policy {
        ws.policy = sec;
    }
    ws.updated_at = chrono::Utc::now();

    state
        .store
        .update_workspace(&ws)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ws))
}

async fn delete_workspace(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    state
        .store
        .delete_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Workspace Git Operations
// ---------------------------------------------------------------------------

async fn workspace_git_status(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<git::GitStatusResponse>, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    let ws = state
        .store
        .get_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workspace {} not found", id))
        })?;

    let status = git::get_git_status(&ws.canonical_path)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(status))
}

#[derive(Deserialize)]
pub struct GitDiffQuery {
    pub staged: Option<bool>,
}

async fn workspace_git_diff(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<git::GitDiffResponse>, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    let ws = state
        .store
        .get_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workspace {} not found", id))
        })?;

    let diff = git::get_git_diff(&ws.canonical_path, query.staged.unwrap_or(false))
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(diff))
}

#[derive(Deserialize)]
pub struct GitLogQuery {
    pub limit: Option<usize>,
}

async fn workspace_git_log(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Query(query): Query<GitLogQuery>,
) -> Result<Json<Vec<git::GitCommitInfo>>, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    let ws = state
        .store
        .get_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workspace {} not found", id))
        })?;

    let commits = git::get_git_log(&ws.canonical_path, query.limit.unwrap_or(20))
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    Ok(Json(commits))
}

#[derive(Deserialize)]
pub struct GitCommitPayload {
    pub message: String,
    #[serde(default)]
    pub stage_all: Option<bool>,
}

async fn workspace_git_commit(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(payload): Json<GitCommitPayload>,
) -> Result<Json<git::GitCommitResult>, (StatusCode, Json<ApiError>)> {
    let id: WorkspaceId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid workspace id: {}", id_str),
        )
    })?;

    let ws = state
        .store
        .get_workspace(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| {
            ApiError::new(StatusCode::NOT_FOUND, format!("Workspace {} not found", id))
        })?;

    let res = git::commit_git_changes(&ws.canonical_path, &payload.message)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let evt = Event::new(
        "workspace",
        ws.id.to_string(),
        "git.committed",
        serde_json::json!({
            "workspace_id": ws.id.to_string(),
            "commit_hash": res.sha,
            "message": payload.message,
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(res))
}

// ---------------------------------------------------------------------------
// Task Terminal Streaming
// ---------------------------------------------------------------------------

async fn get_task_terminal(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
) -> Result<Json<crate::terminal::TaskTerminal>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;

    let task = state
        .store
        .get_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Task {} not found", id)))?;

    let term = state.terminal_buffer.get(&id).unwrap_or_else(|| {
        let mut t = crate::terminal::TaskTerminal {
            task_id: id.to_string(),
            lines: Vec::new(),
            exit_code: if task.state.is_terminal() {
                Some(if task.state == TaskState::Verified {
                    0
                } else {
                    1
                })
            } else {
                None
            },
            is_completed: task.state.is_terminal(),
        };
        t.lines.push(crate::terminal::TerminalLine {
            timestamp: task.updated_at,
            stream: "system".into(),
            line: format!("Task [{}] status: {}", task.objective, task.state.as_str()),
        });
        t
    });

    Ok(Json(term))
}

// ---------------------------------------------------------------------------
// POST Task Terminal (inject lines for runtime/testing)
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
struct PostTerminalLine {
    line: String,
    #[serde(default)]
    is_stderr: bool,
}

#[derive(Deserialize)]
struct PostTerminalPayload {
    lines: Vec<PostTerminalLine>,
    exit_code: Option<i32>,
}

async fn post_task_terminal(
    State(state): State<AppState>,
    Path(id_str): Path<String>,
    Json(payload): Json<PostTerminalPayload>,
) -> Result<Json<serde_json::Value>, (StatusCode, Json<ApiError>)> {
    let id: TaskId = id_str.parse().map_err(|_| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            format!("Invalid task id: {}", id_str),
        )
    })?;

    // Verify task exists
    state
        .store
        .get_task(&id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, format!("Task {} not found", id)))?;

    for line_entry in &payload.lines {
        let stream = if line_entry.is_stderr {
            "stderr"
        } else {
            "stdout"
        };
        state.terminal_buffer.append(&id, stream, &line_entry.line);
    }

    if let Some(code) = payload.exit_code {
        state.terminal_buffer.complete(&id, code);
    }

    Ok(Json(
        serde_json::json!({ "ok": true, "lines_appended": payload.lines.len() }),
    ))
}

// ---------------------------------------------------------------------------
// Retention Records Pruning
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PruneRetentionPayload {
    pub max_age_days: Option<i64>,
}

#[derive(Serialize)]
pub struct PruneRetentionResponse {
    pub report: plexis_storage::RetentionPruneReport,
    pub records_pruned: u64,
    pub cutoff_date: String,
}

async fn prune_retention_records(
    State(state): State<AppState>,
    Json(payload): Json<PruneRetentionPayload>,
) -> Result<Json<PruneRetentionResponse>, (StatusCode, Json<ApiError>)> {
    let days = payload.max_age_days.unwrap_or(30);
    let cutoff = chrono::Utc::now() - chrono::Duration::days(days);

    let report = state
        .store
        .prune_historical_records(cutoff)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let total = report.pruned_events + report.pruned_messages + report.pruned_commands;
    let evt = Event::new(
        "retention",
        "system".to_string(),
        "retention.pruned",
        serde_json::json!({
            "records_pruned": total,
            "cutoff": cutoff.to_rfc3339(),
        }),
    );
    let _ = state.store.append_event(&evt).await;

    Ok(Json(PruneRetentionResponse {
        report,
        records_pruned: total,
        cutoff_date: cutoff.to_rfc3339(),
    }))
}

// ---------------------------------------------------------------------------
// GitHub Integration Boundary
// ---------------------------------------------------------------------------

async fn list_github_repos(
    State(state): State<AppState>,
) -> Result<Json<Vec<crate::github::GitHubRepoInfo>>, (StatusCode, Json<ApiError>)> {
    let repos = state
        .github
        .list_repositories()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(repos))
}

#[derive(Deserialize)]
pub struct GitHubRepoQuery {
    pub repo: String,
}

async fn list_github_pulls(
    State(state): State<AppState>,
    Query(query): Query<GitHubRepoQuery>,
) -> Result<Json<Vec<crate::github::GitHubPullRequest>>, (StatusCode, Json<ApiError>)> {
    let pulls = state
        .github
        .list_pull_requests(&query.repo)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(pulls))
}

async fn create_github_pull(
    State(state): State<AppState>,
    Json(payload): Json<CreatePullRequestPayload>,
) -> Result<Json<crate::github::GitHubPullRequest>, (StatusCode, Json<ApiError>)> {
    let repo = payload
        .repo
        .clone()
        .unwrap_or_else(|| "axonel/axonel".to_string());
    let pr = state
        .github
        .create_pull_request(&repo, payload)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(pr))
}

async fn list_github_issues(
    State(state): State<AppState>,
    Query(query): Query<GitHubRepoQuery>,
) -> Result<Json<Vec<crate::github::GitHubIssue>>, (StatusCode, Json<ApiError>)> {
    let issues = state
        .github
        .list_issues(&query.repo)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;
    Ok(Json(issues))
}

// ---------------------------------------------------------------------------
// SPA Fallback Page
// ---------------------------------------------------------------------------

async fn spa_fallback_page() -> impl IntoResponse {
    Html(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Axonel Operational Control Plane</title>
  <style>
    body { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; background: #0b0f19; color: #e2e8f0; padding: 2rem; margin: 0; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 2rem; max-width: 680px; margin: 4rem auto; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); }
    h1 { color: #38bdf8; margin-top: 0; font-size: 1.5rem; }
    p { line-height: 1.6; color: #94a3b8; }
    code { background: #0f172a; padding: 0.2rem 0.4rem; border-radius: 4px; color: #a5f3fc; }
    .status-badge { display: inline-block; background: #064e3b; color: #34d399; padding: 0.25rem 0.75rem; border-radius: 9999px; font-size: 0.875rem; font-weight: bold; margin-bottom: 1rem; }
    a { color: #38bdf8; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge">API ONLINE</div>
    <h1>Axonel Operational Control Plane</h1>
    <p>The Axonel server is actively listening. All control plane API endpoints and event streaming channels are operational.</p>
    <p><strong>Available Endpoints:</strong></p>
    <ul>
      <li><a href="/health"><code>GET /health</code></a> &mdash; Health probe</li>
      <li><a href="/api/v1/system/status"><code>GET /api/v1/system/status</code></a> &mdash; System info</li>
      <li><a href="/api/v1/dashboard/summary"><code>GET /api/v1/dashboard/summary</code></a> &mdash; Aggregated metrics</li>
      <li><a href="/api/v1/workflows"><code>GET /api/v1/workflows</code></a> &mdash; Workflows catalog</li>
      <li><a href="/api/v1/events/stream"><code>GET /api/v1/events/stream</code></a> &mdash; SSE live stream</li>
      <li><a href="/api/v1/approvals"><code>GET /api/v1/approvals</code></a> &mdash; Approval center</li>
    </ul>
    <p>To run the developer web dashboard in development mode:<br /><code>cd web && npm run dev</code></p>
    <p>To build static web assets for direct serving by Axonel Server:<br /><code>cd web && npm run build</code></p>
  </div>
</body>
</html>"#,
    )
}

// ---------------------------------------------------------------------------
// Helpers: Workflow Planning and Execution
// ---------------------------------------------------------------------------

use crate::workflow_executor::{ensure_default_agents, plan_workflow_objective};

async fn populate_autonomous_scripted_responses(
    provider: &Arc<plexis_providers::ScriptedProvider>,
) {
    use plexis_providers::{ChatMessage, CompletionResponse, FinishReason, TokenUsage, ToolCall};
    use serde_json::json;

    // Task 1 (Investigation): Planner inspects src/lib.rs
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant_with_tools(vec![ToolCall {
            id: "call_inspect".into(),
            name: "filesystem".into(),
            arguments: json!({
                "action": "read_file",
                "path": "src/lib.rs"
            })
            .to_string(),
        }]),
        finish_reason: FinishReason::ToolCalls,
        usage: TokenUsage {
            prompt_tokens: 150,
            completion_tokens: 45,
            total_tokens: 195,
        },
    });
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant(
            "Investigation complete: inspected src/lib.rs, preparing implementation changes.",
        ),
        finish_reason: FinishReason::Stop,
        usage: TokenUsage {
            prompt_tokens: 200,
            completion_tokens: 25,
            total_tokens: 225,
        },
    });

    // Task 2 (Implementation): Developer implements changes in src/lib.rs
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant_with_tools(vec![ToolCall {
            id: "call_impl".into(),
            name: "filesystem".into(),
            arguments: json!({
                "action": "write_file",
                "path": "src/lib.rs",
                "content": "pub fn compute(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn modulo(a: i32, b: i32) -> i32 {\n    ((a % b) + b) % b\n}\n",
                "overwrite": true
            })
            .to_string(),
        }]),
        finish_reason: FinishReason::ToolCalls,
        usage: TokenUsage {
            prompt_tokens: 250,
            completion_tokens: 60,
            total_tokens: 310,
        },
    });
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant(
            "Implementation complete: added modulo function to src/lib.rs.",
        ),
        finish_reason: FinishReason::Stop,
        usage: TokenUsage {
            prompt_tokens: 220,
            completion_tokens: 20,
            total_tokens: 240,
        },
    });

    // Task 3 (Test Suite): Tester runs cargo test via ShellTool
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant_with_tools(vec![ToolCall {
            id: "call_test".into(),
            name: "shell".into(),
            arguments: json!({
                "command": "cargo test --lib"
            })
            .to_string(),
        }]),
        finish_reason: FinishReason::ToolCalls,
        usage: TokenUsage {
            prompt_tokens: 280,
            completion_tokens: 35,
            total_tokens: 315,
        },
    });
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant(
            "Automated test suite completed successfully: cargo test passed.",
        ),
        finish_reason: FinishReason::Stop,
        usage: TokenUsage {
            prompt_tokens: 260,
            completion_tokens: 20,
            total_tokens: 280,
        },
    });

    // Task 4 (Governance / Review): Verifier requests human approval
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant_with_tools(vec![ToolCall {
            id: "call_approval".into(),
            name: "request_human_approval".into(),
            arguments: json!({
                "description": "Commit and push verified negative modulo feature",
                "reason": "Independent regression test suite verified"
            })
            .to_string(),
        }]),
        finish_reason: FinishReason::ToolCalls,
        usage: TokenUsage {
            prompt_tokens: 300,
            completion_tokens: 40,
            total_tokens: 340,
        },
    });
    // Task 4 continuation once approved:
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant(
            "Human approval granted. Signoff confirmed, ready to commit.",
        ),
        finish_reason: FinishReason::Stop,
        usage: TokenUsage {
            prompt_tokens: 150,
            completion_tokens: 20,
            total_tokens: 170,
        },
    });

    // Task 5 (Commit & Integration): Integrator executes Git commit
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant_with_tools(vec![ToolCall {
            id: "call_git_commit".into(),
            name: "git".into(),
            arguments: json!({
                "action": "commit",
                "message": "feat: add negative modulo support"
            })
            .to_string(),
        }]),
        finish_reason: FinishReason::ToolCalls,
        usage: TokenUsage {
            prompt_tokens: 220,
            completion_tokens: 30,
            total_tokens: 250,
        },
    });
    provider.queue_response(CompletionResponse {
        message: ChatMessage::assistant("Verified artifact committed to Git repository."),
        finish_reason: FinishReason::Stop,
        usage: TokenUsage {
            prompt_tokens: 180,
            completion_tokens: 20,
            total_tokens: 200,
        },
    });
}

fn spawn_workflow_execution(state: AppState, workflow_id: WorkflowId) {
    tokio::spawn(async move {
        let mut workspace_path: Option<String> = None;
        if let Ok(Some(wf)) = state.store.get_workflow(&workflow_id).await {
            if let Some(ws_id) = wf.workspace_id {
                if let Ok(Some(ws)) = state.store.get_workspace(&ws_id).await {
                    workspace_path = Some(ws.canonical_path.to_string_lossy().to_string());
                }
            }
        }

        let _ = ensure_default_agents(&state.store, workspace_path.as_deref()).await;

        if let Ok(Some(mut wf)) = state.store.get_workflow(&workflow_id).await {
            if wf.state == WorkflowState::Draft || wf.state == WorkflowState::Paused {
                let _ = wf.state.transition_to(WorkflowState::Active);
                let _ = state.store.update_workflow(&wf).await;
                let evt = Event::new(
                    "workflow",
                    workflow_id.to_string(),
                    "workflow.started",
                    serde_json::json!({ "workflow_id": workflow_id.to_string() }),
                );
                let _ = state.store.append_event(&evt).await;
            }
        }

        let lease_mgr = Arc::new(LeaseManager::new(state.store.clone()));
        let dispatcher = Arc::new(BroadcastCommandDispatcher::new(100));
        let verifier = Arc::new(WorkspaceVerifier::new(state.store.clone()));
        let tb = state.terminal_buffer.clone();
        let terminal_cb: plexis_runtime::runner::TerminalCallback =
            Arc::new(move |task_id, stream, line| {
                tb.append(task_id, stream, line);
            });
        let mut runner = AgentRunner::new(
            state.store.clone(),
            state.tool_registry.as_ref().clone(),
            verifier,
        )
        .with_terminal_callback(terminal_cb);
        let mock_provider = Arc::new(plexis_providers::ScriptedProvider::new("scripted"));
        populate_autonomous_scripted_responses(&mock_provider).await;
        runner.register_provider(mock_provider);
        let fake_backend = Arc::new(plexis_runtime::backend::FakeAgentBackend::new(
            state.agent_host.clone(),
        ));
        runner.register_backend(fake_backend);
        let runner_arc = Arc::new(runner);

        let scheduler =
            DeterministicScheduler::new(state.store.clone(), lease_mgr, dispatcher, runner_arc);

        let mut consecutive_empty_ticks = 0;
        loop {
            // Check workflow state
            match state.store.get_workflow(&workflow_id).await {
                Ok(Some(wf)) => {
                    if wf.state != WorkflowState::Active {
                        break;
                    }
                }
                _ => break,
            }

            // Check if any task is in NeedsHuman
            if let Ok(tasks) = state.store.list_tasks_by_workflow(&workflow_id).await {
                if tasks.iter().any(|t| t.state == TaskState::NeedsHuman) {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }

                let all_terminal = !tasks.is_empty() && tasks.iter().all(|t| t.state.is_terminal());
                if all_terminal {
                    let has_failed = tasks.iter().any(|t| t.state == TaskState::Failed);
                    if let Ok(Some(mut wf)) = state.store.get_workflow(&workflow_id).await {
                        let target_state = if has_failed {
                            WorkflowState::Failed
                        } else {
                            WorkflowState::Completed
                        };
                        let _ = wf.state.transition_to(target_state);
                        let _ = state.store.update_workflow(&wf).await;
                        let evt = Event::new(
                            "workflow",
                            workflow_id.to_string(),
                            if has_failed {
                                "workflow.failed"
                            } else {
                                "workflow.completed"
                            },
                            serde_json::json!({
                                "workflow_id": workflow_id.to_string(),
                                "total_tasks": tasks.len(),
                            }),
                        );
                        let _ = state.store.append_event(&evt).await;
                    }
                    break;
                }
            }

            match scheduler.tick().await {
                Ok(count) if count > 0 => {
                    consecutive_empty_ticks = 0;
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                _ => {
                    consecutive_empty_ticks += 1;
                    if consecutive_empty_ticks > 15 {
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    } else {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    if consecutive_empty_ticks > 40 {
                        break;
                    }
                }
            }
        }
    });
}

// ---------------------------------------------------------------------------
// Agent Host & External Process Supervision Handlers
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct BackendInfo {
    pub id: String,
    pub name: String,
    pub display_name: String,
    pub available: bool,
    pub is_available: bool,
    pub description: String,
    pub version: String,
    pub capabilities: Vec<String>,
    pub executable_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auth_status: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub probe: Option<serde_json::Value>,
    pub support_tier: String,
    pub probe_status: String,
    pub notes: String,
}

async fn list_agent_backends(State(state): State<AppState>) -> impl IntoResponse {
    let backends: Vec<BackendInfo> = state
        .backend_registry
        .list_backends()
        .into_iter()
        .map(|b| {
            let id = b.id().to_string();
            let mut auth_val = None;
            let mut probe_val = None;
            let (desc, caps, exe_path, ver, is_avail, support_tier, probe_status, notes) = match id.as_str() {
                "fake_agent" => (
                    "Deterministic external coding agent executable running in isolated process group"
                        .to_string(),
                    vec![
                        "filesystem_write".into(),
                        "shell".into(),
                        "git_commit".into(),
                        "process_group_isolation".into(),
                    ],
                    Some("target/debug/plexis-fake-agent".to_string()),
                    "1.0".to_string(),
                    b.is_available(),
                    "test_only".to_string(),
                    if b.is_available() { "configured".to_string() } else { "unavailable".to_string() },
                    "Deterministic local agent used for integration verification and testing.".to_string(),
                ),
                "gemini_cli" => {
                    let probe = plexis_runtime::backend::GeminiCapabilityProbe::new();
                    let probed_caps = probe.probe();
                    let is_authed = matches!(
                        probed_caps.auth_status,
                        plexis_runtime::backend::GeminiAuthStatus::Authenticated { .. }
                    );
                    auth_val = serde_json::to_value(&probed_caps.auth_status).ok();
                    let p_val = serde_json::to_value(&probed_caps).ok();
                    probe_val = p_val;
                    let tier = if is_authed {
                        "implemented".to_string()
                    } else {
                        "requires_credentials".to_string()
                    };
                    let p_status = if probed_caps.available && is_authed {
                        "configured".to_string()
                    } else if probed_caps.available {
                        "unconfigured".to_string()
                    } else {
                        "unavailable".to_string()
                    };
                    let n = if probed_caps.available && is_authed {
                        "Primary external coding agent backend. Fully proven end-to-end.".to_string()
                    } else if probed_caps.available {
                        "Gemini CLI binary found, but authentication credentials are required (run 'gemini auth login' or set GEMINI_API_KEY).".to_string()
                    } else {
                        "Gemini CLI binary not found in system PATH.".to_string()
                    };
                    (
                        probed_caps.diagnostics,
                        vec![
                            "autonomous_coding".into(),
                            "workspace_inspection".into(),
                            "tool_execution".into(),
                            "headless_stream_json".into(),
                            "git_provenance".into(),
                        ],
                        probed_caps.executable_path.map(|p| p.display().to_string()),
                        probed_caps.version.unwrap_or_else(|| "0.60.0".to_string()),
                        probed_caps.available,
                        tier,
                        p_status,
                        n,
                    )
                }
                "claude_code" => (
                    "Claude Code CLI adapter (future integration stub)".to_string(),
                    vec!["external_process".into()],
                    None,
                    "1.0".to_string(),
                    b.is_available(),
                    "stub".to_string(),
                    "unavailable".to_string(),
                    "Scaffold adapter stub for future Claude Code integration. Not yet supported for autonomous execution.".to_string(),
                ),
                "codex" => (
                    "Codex CLI adapter (future integration stub)".to_string(),
                    vec!["external_process".into()],
                    None,
                    "1.0".to_string(),
                    b.is_available(),
                    "stub".to_string(),
                    "unavailable".to_string(),
                    "Scaffold adapter stub for future Codex integration. Not yet supported for autonomous execution.".to_string(),
                ),
                _ => (
                    "External coding agent backend".to_string(),
                    vec!["external_process".into()],
                    None,
                    "1.0".to_string(),
                    b.is_available(),
                    "stub".to_string(),
                    "unavailable".to_string(),
                    "Scaffold adapter stub. Not yet supported for autonomous execution.".to_string(),
                ),
            };
            BackendInfo {
                name: b.display_name().to_string(),
                display_name: b.display_name().to_string(),
                available: is_avail,
                is_available: is_avail,
                description: desc,
                version: ver,
                capabilities: caps,
                executable_path: exe_path,
                auth_status: auth_val,
                probe: probe_val,
                support_tier,
                probe_status,
                notes,
                id,
            }
        })
        .collect();
    Json(serde_json::json!({ "backends": backends }))
}

#[derive(Serialize)]
pub struct ActiveProcessInfo {
    pub execution_id: String,
    pub pid: u32,
    pub pgid: u32,
    pub state: serde_json::Value,
    pub started_at: String,
}

async fn list_agent_host_executions(State(state): State<AppState>) -> impl IntoResponse {
    let procs = state.agent_host.list_active_processes().await;
    let list: Vec<ActiveProcessInfo> = procs
        .into_iter()
        .map(|p| ActiveProcessInfo {
            execution_id: p.execution_id.to_string(),
            pid: p.pid,
            pgid: p.pgid,
            state: serde_json::to_value(&p.state).unwrap_or_default(),
            started_at: p.started_at.to_rfc3339(),
        })
        .collect();

    let mut worktrees = Vec::new();
    if let Ok(workspaces) = state.store.list_workspaces().await {
        for ws in workspaces {
            let mgr = plexis_runtime::worktree::WorktreeManager::new(&ws.canonical_path);
            if let Ok(wt_list) = mgr.list_worktrees() {
                for wt in wt_list {
                    worktrees.push(serde_json::json!({
                        "path": wt.path.display().to_string(),
                        "branch": wt.branch,
                        "head_commit": wt.head_commit,
                        "is_locked": wt.is_locked,
                        "workspace_id": ws.id.to_string(),
                    }));
                }
            }
        }
    }

    Json(serde_json::json!({
        "active_executions": list,
        "worktrees": worktrees,
    }))
}

#[derive(Deserialize)]
pub struct ExecuteAgentHostRequest {
    pub workspace_id: Option<WorkspaceId>,
    pub workspace_path: Option<String>,
    pub objective: String,
    pub role: Option<String>,
    pub backend: Option<String>,
    pub timeout_secs: Option<u64>,
    pub failure_mode: Option<String>,
    pub delay_ms: Option<u64>,
}

async fn execute_agent_host(
    State(state): State<AppState>,
    Json(req): Json<ExecuteAgentHostRequest>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let workspace_path = if let Some(ws_id) = req.workspace_id {
        let ws = state
            .store
            .get_workspace(&ws_id)
            .await
            .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
            .ok_or_else(|| (StatusCode::NOT_FOUND, "Workspace not found".to_string()))?;
        ws.canonical_path
    } else if let Some(path_str) = req.workspace_path {
        std::path::PathBuf::from(path_str)
    } else {
        return Err((
            StatusCode::BAD_REQUEST,
            "Either workspace_id or workspace_path must be provided".to_string(),
        ));
    };

    let exec_id = ExecutionId::new();
    let agent_id = AgentId::new();
    let role = req.role.unwrap_or_else(|| "Developer".to_string());
    let timeout_secs = req.timeout_secs.unwrap_or(300);

    let mut exec_req = plexis_core::protocol::ExecutionRequest::new(
        exec_id,
        agent_id,
        role,
        req.objective,
        workspace_path,
    )
    .with_timeout_secs(timeout_secs);

    if let Some(fm) = req.failure_mode {
        exec_req = exec_req.with_failure_mode(fm);
    }
    if let Some(d) = req.delay_ms {
        exec_req = exec_req.with_delay_ms(d);
    }

    let backend_id = req.backend.unwrap_or_else(|| "fake_agent".to_string());
    let backend = state.backend_registry.get(&backend_id).ok_or_else(|| {
        (
            StatusCode::BAD_REQUEST,
            format!("Backend '{}' not found", backend_id),
        )
    })?;

    let result = backend
        .execute(&exec_req, None)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::to_value(result).unwrap_or_default()))
}

async fn get_agent_host_execution(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let exec_id: ExecutionId = id
        .parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid execution ID".to_string()))?;

    let proc_state = state.agent_host.get_process_state(&exec_id).await;
    match proc_state {
        Some(s) => Ok(Json(serde_json::json!({
            "execution_id": id,
            "state": serde_json::to_value(s).unwrap_or_default(),
        }))),
        None => Err((
            StatusCode::NOT_FOUND,
            format!("No process found for execution {}", id),
        )),
    }
}

async fn cancel_agent_host_execution(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    let exec_id: ExecutionId = id
        .parse()
        .map_err(|_| (StatusCode::BAD_REQUEST, "Invalid execution ID".to_string()))?;

    state
        .agent_host
        .cancel_execution(&exec_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "status": "cancelled",
        "execution_id": id,
    })))
}

async fn get_gemini_backend_probe() -> impl IntoResponse {
    let probe = plexis_runtime::backend::GeminiCapabilityProbe::new();
    let caps = probe.probe();
    Json(serde_json::to_value(caps).unwrap_or_default())
}

async fn get_agent_host_execution_events(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<impl IntoResponse, (StatusCode, String)> {
    use plexis_storage::EventStore;

    let events = state
        .store
        .list_events_by_aggregate("execution", &id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(serde_json::json!({
        "execution_id": id,
        "events": events,
    })))
}

// ---------------------------------------------------------------------------
// Missions Handlers (Milestone 15)
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
pub struct CreateMissionRequest {
    pub title: String,
    pub objective: String,
    pub workspace_id: Option<WorkspaceId>,
    pub budget: Option<MissionBudget>,
    pub stopping_condition: Option<StoppingCondition>,
    pub auto_start: Option<bool>,
    pub backend: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct EscalateMissionRequest {
    pub reason: String,
}

#[derive(Debug, Deserialize)]
pub struct ResolveMissionRequest {
    pub decision: String,
}

#[derive(Debug, Serialize)]
pub struct MissionStatusResponse {
    pub mission: Mission,
    pub latest_checkpoint: Option<MissionCheckpoint>,
    pub is_running: bool,
    pub cycles_count: usize,
}

async fn create_mission(
    State(state): State<AppState>,
    Json(req): Json<CreateMissionRequest>,
) -> Result<(StatusCode, Json<Mission>), (StatusCode, Json<ApiError>)> {
    if req.title.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Mission title cannot be empty",
        ));
    }
    if req.objective.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Mission objective cannot be empty",
        ));
    }

    let mut mission = state
        .mission_engine
        .create_mission(
            req.title,
            req.objective,
            req.workspace_id,
            req.budget,
            req.stopping_condition,
        )
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if let Some(meta) = req.metadata {
        mission.metadata = meta;
    }
    if let Some(ref b) = req.backend {
        mission.metadata["backend"] = serde_json::json!(b);
    } else if mission.metadata.get("backend").is_none() {
        mission.metadata["backend"] = serde_json::json!("gemini_cli");
    }

    // Capture initial git commit for diff inspection
    if let Some(ws_id) = mission.workspace_id {
        if let Ok(Some(ws)) = state.store.get_workspace(&ws_id).await {
            if let Ok(status) = git::get_git_status(&ws.canonical_path) {
                if let Some(sha) = status.head_commit {
                    mission.metadata["initial_commit"] = serde_json::json!(sha);
                }
            }
        }
    }

    state
        .store
        .update_mission(&mission)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    if req.auto_start == Some(true) {
        mission = state
            .mission_engine
            .start_mission(mission.id)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let engine = state.mission_engine.clone();
        let m_id = mission.id;
        tokio::spawn(async move {
            tracing::info!("[BackgroundMission] Auto-stepping mission {}", m_id);
            loop {
                if !engine.is_running(&m_id).await {
                    break;
                }
                match engine.step_mission(m_id).await {
                    Ok(m) => {
                        if m.state.is_terminal()
                            || m.state == MissionState::AwaitingAcceptance
                            || m.state == MissionState::Accepted
                            || m.state == MissionState::NeedsHuman
                            || m.state == MissionState::Waiting
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[BackgroundMission] Step error for {}: {}", m_id, e);
                        break;
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            }
        });
    }

    Ok((StatusCode::CREATED, Json(mission)))
}

async fn list_missions(
    State(state): State<AppState>,
) -> Result<Json<Vec<Mission>>, (StatusCode, Json<ApiError>)> {
    let missions = state
        .store
        .list_missions()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(missions))
}

async fn get_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .store
        .get_mission(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Mission not found"))?;

    Ok(Json(mission))
}

async fn start_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .start_mission(mission_id)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    let engine = state.mission_engine.clone();
    let m_id = mission.id;
    tokio::spawn(async move {
        tracing::info!("[BackgroundMission] Auto-stepping mission {}", m_id);
        loop {
            if !engine.is_running(&m_id).await {
                break;
            }
            match engine.step_mission(m_id).await {
                Ok(m) => {
                    if m.state.is_terminal()
                        || m.state == MissionState::AwaitingAcceptance
                        || m.state == MissionState::Accepted
                        || m.state == MissionState::NeedsHuman
                        || m.state == MissionState::Waiting
                    {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!("[BackgroundMission] Step error for {}: {}", m_id, e);
                    break;
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }
    });

    Ok(Json(mission))
}

async fn pause_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .pause_mission(&mission_id)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    Ok(Json(mission))
}

async fn resume_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .resume_mission(&mission_id)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    let engine = state.mission_engine.clone();
    let m_id = mission.id;
    tokio::spawn(async move {
        tracing::info!("[BackgroundMission] Auto-stepping resumed mission {}", m_id);
        loop {
            if !engine.is_running(&m_id).await {
                break;
            }
            match engine.step_mission(m_id).await {
                Ok(m) => {
                    if m.state.is_terminal()
                        || m.state == MissionState::AwaitingAcceptance
                        || m.state == MissionState::Accepted
                        || m.state == MissionState::NeedsHuman
                        || m.state == MissionState::Waiting
                    {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!("[BackgroundMission] Step error for {}: {}", m_id, e);
                    break;
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }
    });

    Ok(Json(mission))
}

async fn cancel_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .cancel_mission(&mission_id)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    Ok(Json(mission))
}

async fn step_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    if let Ok(Some(m)) = state.store.get_mission(&mission_id).await {
        if m.state == MissionState::Created {
            let _ = state.mission_engine.start_mission(mission_id).await;
        }
    }

    let mission = state
        .mission_engine
        .step_mission(mission_id)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    Ok(Json(mission))
}

async fn list_mission_events(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<Event>>, (StatusCode, Json<ApiError>)> {
    let events = state
        .store
        .list_events_by_aggregate("mission", &id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(events))
}

async fn list_mission_checkpoints(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MissionCheckpoint>>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let ckpts = state
        .store
        .list_checkpoints(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(ckpts))
}

async fn list_mission_cycles(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Vec<MissionCycle>>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let cycles = state
        .store
        .list_cycles(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(cycles))
}

async fn get_mission_status(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MissionStatusResponse>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .store
        .get_mission(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Mission not found"))?;

    let latest_checkpoint = state
        .mission_engine
        .checkpoint_manager()
        .get_latest_checkpoint(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let cycles = state
        .store
        .list_cycles(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let is_running = state.mission_engine.is_running(&mission_id).await;

    Ok(Json(MissionStatusResponse {
        mission,
        latest_checkpoint,
        is_running,
        cycles_count: cycles.len(),
    }))
}

async fn escalate_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(req): Json<EscalateMissionRequest>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .escalate_human(&mission_id, req.reason)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    Ok(Json(mission))
}

async fn resolve_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(req): Json<ResolveMissionRequest>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .resolve_escalation(&mission_id, &req.decision)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    // Spawn background loop for continuing decisions (resume/replan)
    // Only spawn if the mission is now running to avoid duplicate loops on repeated resolution
    if req.decision.to_lowercase() != "cancel" && state.mission_engine.is_running(&mission.id).await {
        let engine = state.mission_engine.clone();
        let m_id = mission.id;
        tokio::spawn(async move {
            tracing::info!(
                "[BackgroundMission] Auto-stepping resolved mission {}",
                m_id
            );
            loop {
                if !engine.is_running(&m_id).await {
                    break;
                }
                match engine.step_mission(m_id).await {
                    Ok(m) => {
                        if m.state.is_terminal()
                            || m.state == MissionState::AwaitingAcceptance
                            || m.state == MissionState::Accepted
                            || m.state == MissionState::NeedsHuman
                            || m.state == MissionState::Waiting
                        {
                            break;
                        }
                    }
                    Err(e) => {
                        tracing::warn!("[BackgroundMission] Step error for {}: {}", m_id, e);
                        break;
                    }
                }
                tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
            }
        });
    }

    Ok(Json(mission))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissionDiffResponse {
    pub mission_id: MissionId,
    pub base_commit: Option<String>,
    pub current_commit: Option<String>,
    pub is_clean: bool,
    pub diff: String,
    pub files_changed: Vec<String>,
    pub insertions: usize,
    pub deletions: usize,
}

async fn get_mission_diff(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MissionDiffResponse>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .store
        .get_mission(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Mission not found"))?;

    let ws_id = mission.workspace_id.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "Mission is not bound to a workspace",
        )
    })?;

    let ws = state
        .store
        .get_workspace(&ws_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Workspace not found"))?;

    let repo_path = &ws.canonical_path;
    let base_commit = mission
        .metadata
        .get("initial_commit")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    let status = git::get_git_status(repo_path)
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?;

    let diff_res = if let (Some(ref base), Some(ref verified)) =
        (&base_commit, &mission.latest_verified_commit)
    {
        if base != verified {
            git::get_git_diff_range(repo_path, base, verified)
                .or_else(|_| git::get_git_diff_against(repo_path, base))
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?
        } else {
            git::get_git_diff_against(repo_path, base)
                .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?
        }
    } else if let Some(ref verified) = mission.latest_verified_commit {
        git::get_git_diff_range(repo_path, &format!("{}^", verified), verified)
            .or_else(|_| git::get_git_diff(repo_path, false))
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?
    } else if let Some(ref base) = base_commit {
        git::get_git_diff_against(repo_path, base)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?
    } else {
        git::get_git_diff(repo_path, false)
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e))?
    };

    Ok(Json(MissionDiffResponse {
        mission_id,
        base_commit,
        current_commit: status.head_commit,
        is_clean: status.is_clean,
        diff: diff_res.diff,
        files_changed: diff_res.files_changed,
        insertions: diff_res.insertions,
        deletions: diff_res.deletions,
    }))
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct IntegrateMissionRequest {
    pub target_branch: Option<String>,
    pub commit_message: Option<String>,
    pub expected_target_head: Option<String>,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrateMissionResponse {
    pub mission_id: MissionId,
    pub integrated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub already_integrated: Option<bool>,
    pub verified_commit: String,
    pub integration_summary: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AcceptMissionRequest {
    pub feedback: Option<String>,
    pub integrate: Option<bool>,
    pub target_branch: Option<String>,
    pub commit_message: Option<String>,
    pub expected_target_head: Option<String>,
    pub force: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcceptMissionResponse {
    pub mission_id: MissionId,
    pub state: MissionState,
    pub accepted_at: String,
    pub integrated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub integration_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub verified_commit: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct RejectMissionRequest {
    pub reason: String,
    pub continue_mission: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RejectMissionResponse {
    pub mission_id: MissionId,
    pub state: MissionState,
    pub rejected_at: String,
    pub reason: String,
    pub will_replan: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewDiffSummary {
    pub insertions: usize,
    pub deletions: usize,
    pub files_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewVerificationSummary {
    pub stopping_condition: plexis_core::mission::StoppingCondition,
    pub verified_commit: Option<String>,
    pub outcome: Option<plexis_core::mission::MissionOutcome>,
    pub tests_passed: bool,
    pub tree_clean: bool,
    pub commit_exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReviewTimelineItem {
    pub timestamp: String,
    pub event_type: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissionReviewPackage {
    pub mission_id: MissionId,
    pub title: String,
    pub objective: String,
    pub status: MissionState,
    pub health: String,
    pub repository: Option<String>,
    pub target_branch: Option<String>,
    pub agent_used: Option<String>,
    pub duration_secs: u64,
    pub cycles_count: u32,
    pub total_executions: u32,
    pub recovery_attempts: u32,
    pub verification: ReviewVerificationSummary,
    pub final_commit: Option<String>,
    pub files_changed: Vec<String>,
    pub diff_summary: ReviewDiffSummary,
    pub full_diff: Option<String>,
    pub warnings: Vec<String>,
    pub audit_timeline: Vec<ReviewTimelineItem>,
    pub can_accept: bool,
    pub can_integrate: bool,
    pub can_reject: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verified_target_head: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_target_head: Option<String>,
    #[serde(default)]
    pub reverification_required: bool,
}

async fn get_mission_review(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<MissionReviewPackage>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .store
        .get_mission(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Mission not found"))?;

    let mut repo_display = None;
    let mut target_branch = None;
    let mut files_changed = Vec::new();
    let mut insertions = 0;
    let mut deletions = 0;
    let mut full_diff = None;
    let mut warnings = Vec::new();
    let verified_target_head = mission
        .metadata
        .get("verified_target_head")
        .or_else(|| mission.metadata.get("initial_commit"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut current_target_head = None;

    if let Some(ws_id) = mission.workspace_id {
        if let Ok(Some(ws)) = state.store.get_workspace(&ws_id).await {
            repo_display = Some(ws.canonical_path.to_string_lossy().to_string());
            if let Ok(status) = git::get_git_status(&ws.canonical_path) {
                target_branch = Some(status.branch.clone());
                current_target_head = status.head_commit.clone();
                if !status.is_clean {
                    warnings.push(format!(
                        "Target working tree currently has {} uncommitted/dirty files",
                        status.files.len()
                    ));
                }

                let base_sha = mission
                    .metadata
                    .get("initial_commit")
                    .and_then(|v| v.as_str());
                if let Some(base) = base_sha {
                    if let Some(ref cur_head) = status.head_commit {
                        if cur_head != base && mission.state == MissionState::AwaitingAcceptance {
                            warnings.push(format!(
                                "Target branch HEAD ({}) differs from initial base ({})",
                                cur_head, base
                            ));
                        }
                    }
                }
            }

            let base_commit = mission
                .metadata
                .get("initial_commit")
                .and_then(|v| v.as_str());

            let diff_res = if let (Some(base), Some(ref verified)) =
                (base_commit, &mission.latest_verified_commit)
            {
                if base != verified.as_str() {
                    git::get_git_diff_range(&ws.canonical_path, base, verified)
                        .or_else(|_| git::get_git_diff_against(&ws.canonical_path, base))
                        .ok()
                } else {
                    git::get_git_diff_against(&ws.canonical_path, base).ok()
                }
            } else if let Some(ref verified) = mission.latest_verified_commit {
                git::get_git_diff_range(&ws.canonical_path, &format!("{}^", verified), verified)
                    .or_else(|_| git::get_git_diff(&ws.canonical_path, false))
                    .ok()
            } else if let Some(base) = base_commit {
                git::get_git_diff_against(&ws.canonical_path, base).ok()
            } else {
                git::get_git_diff(&ws.canonical_path, false).ok()
            };

            if let Some(d) = diff_res {
                files_changed = d.files_changed;
                insertions = d.insertions;
                deletions = d.deletions;
                full_diff = Some(d.diff);
            }
        }
    }

    if mission.budget_consumed.recovery_attempts > 0 {
        warnings.push(format!(
            "Mission required {} recovery attempt(s) during execution",
            mission.budget_consumed.recovery_attempts
        ));
    }

    let events = state
        .store
        .list_events_by_aggregate("mission", &mission_id.to_string())
        .await
        .unwrap_or_default();

    let mut audit_timeline = Vec::new();
    for ev in events {
        let summary = match ev.event_type.as_str() {
            "mission_started" => "Mission autonomous execution started".to_string(),
            "verification_passed" => "Independent out-of-band physical verifier passed".to_string(),
            "mission_awaiting_acceptance" => {
                "Mission halted at review boundary; awaiting human acceptance".to_string()
            }
            "mission_acceptance_recorded" | "mission_accepted" => {
                "Mission deliverable explicitly accepted by human operator".to_string()
            }
            "mission_integration_started" => {
                "Mission integration into target repository branch started".to_string()
            }
            "mission_integration_succeeded" | "mission_integrated" => {
                "Mission changes integrated into target repository branch".to_string()
            }
            "mission_integration_failed" => {
                "Mission integration failed and rolled back".to_string()
            }
            "mission_integration_reconciled" => {
                "Mission intermediate integration state reconciled on recovery".to_string()
            }
            "mission_rejected" => "Mission deliverable rejected".to_string(),
            "mission_rejected_for_replan" => "Mission rejected with request to replan".to_string(),
            other => other.replace('_', " "),
        };
        audit_timeline.push(ReviewTimelineItem {
            timestamp: ev.timestamp.to_rfc3339(),
            event_type: ev.event_type,
            summary,
        });
    }

    let cycles = state
        .store
        .list_cycles(&mission_id)
        .await
        .unwrap_or_default();

    let agent_used = cycles
        .first()
        .map(|c| c.phase.clone())
        .or_else(|| Some("gemini-3.1-flash-lite".to_string()));

    let tests_passed = mission
        .final_outcome
        .as_ref()
        .map(|o| o.success)
        .unwrap_or(false);
    let commit_exists = mission.latest_verified_commit.is_some();
    let tree_clean = warnings.iter().all(|w| !w.contains("uncommitted/dirty"));

    let can_accept = mission.state == MissionState::AwaitingAcceptance;
    let can_integrate = mission.state == MissionState::Accepted;
    let can_reject = mission.state == MissionState::AwaitingAcceptance
        || mission.state == MissionState::Accepted;

    let reverification_required = match (&verified_target_head, &current_target_head) {
        (Some(v), Some(c)) => v != c && mission.state == MissionState::AwaitingAcceptance,
        _ => false,
    };

    Ok(Json(MissionReviewPackage {
        mission_id,
        title: mission.title,
        objective: mission.objective,
        status: mission.state,
        health: format!("{:?}", mission.health_status).to_lowercase(),
        repository: repo_display,
        target_branch,
        agent_used,
        duration_secs: mission.budget_consumed.duration_secs,
        cycles_count: mission.cycle_index + 1,
        total_executions: mission.budget_consumed.total_executions,
        recovery_attempts: mission.budget_consumed.recovery_attempts,
        verification: ReviewVerificationSummary {
            stopping_condition: mission.stopping_condition,
            verified_commit: mission.latest_verified_commit.clone(),
            outcome: mission.final_outcome.clone(),
            tests_passed,
            tree_clean,
            commit_exists,
        },
        final_commit: mission.latest_verified_commit,
        files_changed: files_changed.clone(),
        diff_summary: ReviewDiffSummary {
            insertions,
            deletions,
            files_count: files_changed.len(),
        },
        full_diff,
        warnings,
        audit_timeline,
        can_accept,
        can_integrate,
        can_reject,
        verified_target_head,
        current_target_head,
        reverification_required,
    }))
}

async fn accept_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(req): Json<AcceptMissionRequest>,
) -> Result<Json<AcceptMissionResponse>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mut mission = state
        .store
        .get_mission(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Mission not found"))?;

    // Idempotency: if already integrated
    if mission.state == MissionState::Integrated {
        let now = mission
            .metadata
            .get("accepted_at")
            .or_else(|| mission.metadata.get("integrated_at"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(Json(AcceptMissionResponse {
            mission_id,
            state: mission.state,
            accepted_at: now,
            integrated: true,
            integration_summary: Some("Mission was already accepted and integrated.".to_string()),
            verified_commit: mission.latest_verified_commit.clone(),
        }));
    }

    // Idempotency: if already accepted and integrate was not requested
    if mission.state == MissionState::Accepted && req.integrate != Some(true) {
        let now = mission
            .metadata
            .get("accepted_at")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return Ok(Json(AcceptMissionResponse {
            mission_id,
            state: mission.state,
            accepted_at: now,
            integrated: false,
            integration_summary: None,
            verified_commit: mission.latest_verified_commit.clone(),
        }));
    }

    if mission.state != MissionState::AwaitingAcceptance && mission.state != MissionState::Accepted
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "Cannot accept mission: mission is in state '{}', must be 'awaiting_acceptance'",
                mission.state
            ),
        ));
    }

    let verified_commit = mission.latest_verified_commit.clone().ok_or_else(|| {
        ApiError::new(
            StatusCode::CONFLICT,
            "Cannot accept mission: no verified commit recorded on disk",
        )
    })?;

    if let Some(ref outcome) = mission.final_outcome {
        if !outcome.success {
            return Err(ApiError::new(
                StatusCode::CONFLICT,
                "Cannot accept mission: physical stopping condition verification failed",
            ));
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    let _ = mission.state.transition_to(MissionState::Accepted);
    mission.metadata["accepted"] = serde_json::json!(true);
    mission.metadata["accepted_at"] = serde_json::json!(now);
    if let Some(ref fb) = req.feedback {
        mission.metadata["acceptance_feedback"] = serde_json::json!(fb);
    }

    state
        .store
        .update_mission(&mission)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let evt = Event::new(
        "mission",
        mission_id.to_string(),
        "mission_acceptance_recorded",
        serde_json::json!({
            "mission_id": mission_id.to_string(),
            "verified_commit": verified_commit,
            "accepted_at": now,
            "feedback": req.feedback,
            "integrate_requested": req.integrate == Some(true),
        }),
    );
    let _ = state.store.append_event(&evt).await;

    // Legacy alias event
    let legacy_evt = Event::new(
        "mission",
        mission_id.to_string(),
        "mission_accepted",
        serde_json::json!({
            "mission_id": mission_id.to_string(),
            "verified_commit": verified_commit,
            "accepted_at": now,
            "feedback": req.feedback,
            "integrate_requested": req.integrate == Some(true),
        }),
    );
    let _ = state.store.append_event(&legacy_evt).await;

    // If immediate integration is requested:
    if req.integrate == Some(true) {
        let int_res = integrate_mission(
            Path(id),
            State(state.clone()),
            Json(IntegrateMissionRequest {
                target_branch: req.target_branch,
                commit_message: req.commit_message,
                expected_target_head: req.expected_target_head,
                force: req.force,
            }),
        )
        .await?;

        return Ok(Json(AcceptMissionResponse {
            mission_id,
            state: MissionState::Integrated,
            accepted_at: now,
            integrated: true,
            integration_summary: Some(int_res.integration_summary.clone()),
            verified_commit: Some(verified_commit),
        }));
    }

    Ok(Json(AcceptMissionResponse {
        mission_id,
        state: MissionState::Accepted,
        accepted_at: now,
        integrated: false,
        integration_summary: None,
        verified_commit: Some(verified_commit),
    }))
}

async fn reject_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(req): Json<RejectMissionRequest>,
) -> Result<Json<RejectMissionResponse>, (StatusCode, Json<ApiError>)> {
    if req.reason.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "Rejection reason cannot be empty",
        ));
    }

    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mut mission = state
        .store
        .get_mission(&mission_id)
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| ApiError::new(StatusCode::NOT_FOUND, "Mission not found"))?;

    if mission.state == MissionState::Integrated {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "Cannot reject an already-integrated mission",
        ));
    }

    if mission.state != MissionState::AwaitingAcceptance && mission.state != MissionState::Accepted
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            format!(
                "Cannot reject mission: mission is in state '{}', must be 'awaiting_acceptance' or 'accepted'",
                mission.state
            ),
        ));
    }

    let now = chrono::Utc::now().to_rfc3339();
    let will_replan = req.continue_mission == Some(true);

    if will_replan {
        let _ = mission.state.transition_to(MissionState::Replanning);
        mission.metadata["rejection_reason"] = serde_json::json!(req.reason);
        mission.metadata["rejected_for_replan_at"] = serde_json::json!(now);
        mission.budget_consumed.planner_iterations += 1;
        state
            .store
            .update_mission(&mission)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let evt = Event::new(
            "mission",
            mission_id.to_string(),
            "mission_rejected_for_replan",
            serde_json::json!({
                "mission_id": mission_id.to_string(),
                "reason": req.reason,
                "timestamp": now,
            }),
        );
        let _ = state.store.append_event(&evt).await;

        Ok(Json(RejectMissionResponse {
            mission_id,
            state: MissionState::Replanning,
            rejected_at: now,
            reason: req.reason,
            will_replan: true,
        }))
    } else {
        let _ = mission.state.transition_to(MissionState::Rejected);
        mission.metadata["rejected"] = serde_json::json!(true);
        mission.metadata["rejected_at"] = serde_json::json!(now);
        mission.metadata["rejection_reason"] = serde_json::json!(req.reason);

        state
            .store
            .update_mission(&mission)
            .await
            .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

        let evt = Event::new(
            "mission",
            mission_id.to_string(),
            "mission_rejected",
            serde_json::json!({
                "mission_id": mission_id.to_string(),
                "reason": req.reason,
                "timestamp": now,
            }),
        );
        let _ = state.store.append_event(&evt).await;

        Ok(Json(RejectMissionResponse {
            mission_id,
            state: MissionState::Rejected,
            rejected_at: now,
            reason: req.reason,
            will_replan: false,
        }))
    }
}

pub async fn execute_canonical_integration(
    store: &Arc<SqliteStore>,
    workspace_locks: &Arc<crate::workspace_lock::WorkspaceLockManager>,
    mission_id: &MissionId,
    target_branch: Option<&str>,
    commit_message: Option<&str>,
    expected_target_head: Option<String>,
    force: Option<bool>,
) -> Result<IntegrateMissionResponse, (StatusCode, String)> {
    let mission = store
        .get_mission(mission_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Mission not found".to_string()))?;

    // Idempotency: If already integrated, return success immediately
    if mission.state == MissionState::Integrated {
        let verified = mission.latest_verified_commit.clone().unwrap_or_default();
        let target = mission
            .metadata
            .get("integration_target_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main");
        return Ok(IntegrateMissionResponse {
            mission_id: *mission_id,
            integrated: true,
            already_integrated: Some(true),
            verified_commit: verified.clone(),
            integration_summary: format!(
                "Mission '{}' commit {} was already integrated into branch '{}'.",
                mission.title, verified, target
            ),
            timestamp: mission
                .metadata
                .get("integrated_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }

    // Canonical release semantic invariant:
    // Human acceptance is strictly required before integration!
    if mission.state == MissionState::AwaitingAcceptance {
        return Err((
            StatusCode::CONFLICT,
            "Cannot integrate mission: mission is in state 'awaiting_acceptance'; human acceptance is required before integration. Call POST /api/v1/missions/{id}/accept or run 'axonel mission accept <id>' first.".to_string(),
        ));
    }

    if mission.state == MissionState::Integrating {
        return Err((
            StatusCode::CONFLICT,
            "Cannot integrate mission: integration is currently in progress for this mission."
                .to_string(),
        ));
    }

    if mission.state != MissionState::Accepted && mission.state != MissionState::Completed {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Cannot integrate mission: mission is in state '{}', must be 'accepted'",
                mission.state
            ),
        ));
    }

    // Acquire workspace lock if workspace is bound to ensure intra-process serialization
    let _guard = if let Some(ws_id) = mission.workspace_id {
        let lock = workspace_locks.get_lock(&ws_id).await;
        Some(lock.lock_owned().await)
    } else {
        None
    };

    // Under lock, re-fetch mission in case a concurrent request already processed it
    let mut mission = store
        .get_mission(mission_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?
        .ok_or_else(|| (StatusCode::NOT_FOUND, "Mission not found".to_string()))?;

    if mission.state == MissionState::Integrated {
        let verified = mission.latest_verified_commit.clone().unwrap_or_default();
        let target = mission
            .metadata
            .get("integration_target_branch")
            .and_then(|v| v.as_str())
            .unwrap_or("main");
        return Ok(IntegrateMissionResponse {
            mission_id: *mission_id,
            integrated: true,
            already_integrated: Some(true),
            verified_commit: verified.clone(),
            integration_summary: format!(
                "Mission '{}' commit {} was already integrated into branch '{}'.",
                mission.title, verified, target
            ),
            timestamp: mission
                .metadata
                .get("integrated_at")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        });
    }

    if mission.state == MissionState::Integrating {
        return Err((
            StatusCode::CONFLICT,
            "Cannot integrate mission: integration is currently in progress for this mission."
                .to_string(),
        ));
    }

    if mission.state != MissionState::Accepted && mission.state != MissionState::Completed {
        return Err((
            StatusCode::CONFLICT,
            format!(
                "Cannot integrate mission: mission is in state '{}', must be 'accepted'",
                mission.state
            ),
        ));
    }

    let verified_commit = mission.latest_verified_commit.clone().ok_or_else(|| {
        (
            StatusCode::CONFLICT,
            "Cannot integrate mission: no verified commit recorded on disk".to_string(),
        )
    })?;

    if let Some(ref outcome) = mission.final_outcome {
        if !outcome.success {
            return Err((
                StatusCode::CONFLICT,
                "Cannot integrate mission: final outcome reports verification failure".to_string(),
            ));
        }
    }

    let target_branch_str = target_branch.unwrap_or("main");
    let now = chrono::Utc::now().to_rfc3339();

    // Check if target branch changed since verification
    let expected_head: Option<String> = if force == Some(true) {
        None
    } else {
        expected_target_head.or_else(|| {
            mission
                .metadata
                .get("verified_target_head")
                .or_else(|| mission.metadata.get("initial_commit"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
    };

    // Transition to MissionState::Integrating with durable intent
    let _ = mission.state.transition_to(MissionState::Integrating);
    mission.metadata["integration_intent"] = serde_json::json!({
        "target_branch": target_branch_str,
        "candidate_commit": verified_commit,
        "expected_target_head": expected_head.as_deref(),
        "started_at": now,
    });
    store
        .update_mission(&mission)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let start_evt = Event::new(
        "mission",
        mission_id.to_string(),
        "mission_integration_started",
        serde_json::json!({
            "mission_id": mission_id.to_string(),
            "target_branch": target_branch_str,
            "candidate_commit": verified_commit,
            "expected_target_head": expected_head,
            "started_at": now,
        }),
    );
    let _ = store.append_event(&start_evt).await;

    let mut summary = format!(
        "Mission '{}' verified commit {} successfully integrated into repository.",
        mission.title, verified_commit
    );

    // Physically integrate commit into repository target branch if workspace is bound
    if let Some(ws_id) = mission.workspace_id {
        if let Ok(Some(ws)) = store.get_workspace(&ws_id).await {
            match crate::git::integrate_git_commit(
                &ws.canonical_path,
                target_branch_str,
                &verified_commit,
                commit_message,
                expected_head.as_deref(),
            ) {
                Ok(res) => {
                    summary = res.summary;
                }
                Err(err) => {
                    // Git integration failed! Roll back state from Integrating to Accepted
                    let _ = mission.state.transition_to(MissionState::Accepted);
                    mission.metadata["integration_error"] = serde_json::json!(err);
                    let _ = store.update_mission(&mission).await;

                    let fail_evt = Event::new(
                        "mission",
                        mission_id.to_string(),
                        "mission_integration_failed",
                        serde_json::json!({
                            "mission_id": mission_id.to_string(),
                            "reason": err,
                            "target_branch": target_branch_str,
                            "failed_at": chrono::Utc::now().to_rfc3339(),
                        }),
                    );
                    let _ = store.append_event(&fail_evt).await;

                    let status = if err.contains("dirty working tree")
                        || err.contains("conflict")
                        || err.contains("Conflict")
                        || err.contains("changed since verification")
                    {
                        StatusCode::CONFLICT
                    } else {
                        StatusCode::BAD_REQUEST
                    };
                    return Err((status, format!("Git integration rejected: {}", err)));
                }
            }
        }
    }

    // Git succeeded! Transition from Integrating to Integrated
    let _ = mission.state.transition_to(MissionState::Integrated);
    mission.metadata["integrated"] = serde_json::json!(true);
    let completed_at = chrono::Utc::now().to_rfc3339();
    mission.metadata["integrated_at"] = serde_json::json!(completed_at);
    mission.metadata["integration_target_branch"] = serde_json::json!(target_branch_str);
    if let Some(obj) = mission.metadata.as_object_mut() {
        obj.remove("integration_error");
    }

    store
        .update_mission(&mission)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    let succ_evt = Event::new(
        "mission",
        mission_id.to_string(),
        "mission_integration_succeeded",
        serde_json::json!({
            "mission_id": mission_id.to_string(),
            "verified_commit": verified_commit,
            "integrated_at": completed_at,
            "target_branch": target_branch_str,
            "commit_message": commit_message,
            "summary": summary,
        }),
    );
    let _ = store.append_event(&succ_evt).await;

    // Legacy alias event
    let evt = Event::new(
        "mission",
        mission_id.to_string(),
        "mission_integrated",
        serde_json::json!({
            "mission_id": mission_id.to_string(),
            "verified_commit": verified_commit,
            "integrated_at": completed_at,
            "target_branch": target_branch_str,
            "commit_message": commit_message,
            "summary": summary,
        }),
    );
    let _ = store.append_event(&evt).await;

    Ok(IntegrateMissionResponse {
        mission_id: *mission_id,
        integrated: true,
        already_integrated: Some(false),
        verified_commit,
        integration_summary: summary,
        timestamp: completed_at,
    })
}

async fn integrate_mission(
    Path(id): Path<String>,
    State(state): State<AppState>,
    Json(req): Json<IntegrateMissionRequest>,
) -> Result<Json<IntegrateMissionResponse>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    execute_canonical_integration(
        &state.store,
        &state.workspace_locks,
        &mission_id,
        req.target_branch.as_deref(),
        req.commit_message.as_deref(),
        req.expected_target_head,
        req.force,
    )
    .await
    .map(Json)
    .map_err(|(status, msg)| ApiError::new(status, msg))
}

async fn run_mission_background(
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Result<Json<Mission>, (StatusCode, Json<ApiError>)> {
    let mission_id: MissionId = id
        .parse()
        .map_err(|_| ApiError::new(StatusCode::BAD_REQUEST, "Invalid mission ID"))?;

    let mission = state
        .mission_engine
        .start_mission(mission_id)
        .await
        .map_err(|e| match e {
            plexis_runtime::RuntimeError::NotFound(msg) => {
                ApiError::new(StatusCode::NOT_FOUND, msg)
            }
            plexis_runtime::RuntimeError::Conflict(msg) => ApiError::new(StatusCode::CONFLICT, msg),
            other => ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, other.to_string()),
        })?;

    let engine = state.mission_engine.clone();
    tokio::spawn(async move {
        tracing::info!(
            "[BackgroundMission] Starting autonomous run for mission {}",
            mission_id
        );
        loop {
            if !engine.is_running(&mission_id).await {
                break;
            }
            match engine.step_mission(mission_id).await {
                Ok(m) => {
                    tracing::info!(
                        "[BackgroundMission] Mission {} reached state {}, cycle {}",
                        mission_id,
                        m.state,
                        m.cycle_index
                    );
                    if m.state.is_terminal()
                        || m.state == MissionState::AwaitingAcceptance
                        || m.state == MissionState::Accepted
                        || m.state == MissionState::NeedsHuman
                        || m.state == MissionState::Waiting
                    {
                        break;
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        "[BackgroundMission] Mission {} stepping error: {}",
                        mission_id,
                        e
                    );
                    break;
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_millis(300)).await;
        }
        tracing::info!(
            "[BackgroundMission] Completed autonomous run for mission {}",
            mission_id
        );
    });

    Ok(Json(mission))
}

async fn system_reconcile(
    State(state): State<AppState>,
) -> Result<Json<plexis_runtime::reconciler::ReconciliationReport>, (StatusCode, Json<ApiError>)> {
    let report = state
        .reconcile_startup()
        .await
        .map_err(|e| ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;
    Ok(Json(report))
}

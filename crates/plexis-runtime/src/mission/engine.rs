//! Core mission engine coordinating long-horizon autonomous engineering cycles.

use std::sync::Arc;
use tokio::sync::Mutex;
use tracing::{info, warn};

use chrono::Utc;
use plexis_core::ids::{MissionId, WorkspaceId};
use plexis_core::mission::{
    Mission, MissionBudget, MissionCycle, MissionHealth, MissionOutcome, StoppingCondition,
};
use plexis_core::state::{MissionState, TaskState};
use plexis_core::{Event, Workflow};
use plexis_storage::traits::{
    EventStore, ExecutionStore, MissionStore, TaskStore, WorkflowStore, WorkspaceStore,
};

use crate::error::RuntimeError;
use crate::mission::budget::BudgetTracker;
use crate::mission::checkpoint::CheckpointManager;
use crate::mission::executor::WorkflowExecutor;
use crate::mission::liveness::{LivenessEvaluator, ProgressSnapshot};

/// Long-horizon autonomous mission engine coordinating multi-cycle workflows,
/// checkpoints, liveness, replanning, and physical stop conditions.
pub struct MissionEngine<S> {
    store: Arc<S>,
    checkpoint_mgr: CheckpointManager<S>,
    running_missions: Arc<Mutex<std::collections::HashSet<MissionId>>>,
    workflow_executor: Option<Arc<dyn WorkflowExecutor>>,
}

impl<S> MissionEngine<S>
where
    S: MissionStore
        + WorkflowStore
        + TaskStore
        + EventStore
        + WorkspaceStore
        + ExecutionStore
        + 'static,
{
    pub fn new(store: Arc<S>) -> Self {
        let checkpoint_mgr = CheckpointManager::new(store.clone());
        Self {
            store,
            checkpoint_mgr,
            running_missions: Arc::new(Mutex::new(std::collections::HashSet::new())),
            workflow_executor: None,
        }
    }

    pub fn with_workflow_executor(mut self, executor: Arc<dyn WorkflowExecutor>) -> Self {
        self.workflow_executor = Some(executor);
        self
    }

    pub fn checkpoint_manager(&self) -> &CheckpointManager<S> {
        &self.checkpoint_mgr
    }

    pub async fn is_running(&self, mission_id: &MissionId) -> bool {
        self.running_missions.lock().await.contains(mission_id)
    }

    /// Emits a structured mission-level event with automated secret redaction.
    async fn emit_mission_event(
        &self,
        mission_id: MissionId,
        event_type: &str,
        mut payload: serde_json::Value,
    ) {
        plexis_tools::redaction::SecretRedactor::redact_value_all(&mut payload, &[]);
        let evt = Event::new("mission", mission_id.to_string(), event_type, payload);
        let _ = self.store.append_event(&evt).await;
    }

    /// Creates and persists a new mission.
    pub async fn create_mission(
        &self,
        title: impl Into<String>,
        objective: impl Into<String>,
        workspace_id: Option<WorkspaceId>,
        budget: Option<MissionBudget>,
        stopping_condition: Option<StoppingCondition>,
    ) -> Result<Mission, RuntimeError> {
        let title_str = title.into();
        let obj_str = objective.into();
        let mut mission = Mission::new(title_str, obj_str);
        if let Some(ws) = workspace_id {
            mission = mission.with_workspace_id(ws);
        }
        if let Some(b) = budget {
            mission = mission.with_budget(b);
        }
        if let Some(sc) = stopping_condition {
            mission = mission.with_stopping_condition(sc);
        }

        self.store.create_mission(&mission).await?;

        self.emit_mission_event(
            mission.id,
            "mission_created",
            serde_json::json!({
                "mission_id": mission.id.to_string(),
                "title": mission.title,
                "objective": mission.objective,
                "budget": mission.budget,
                "stopping_condition": mission.stopping_condition,
            }),
        )
        .await;

        Ok(mission)
    }

    /// Starts or resumes a mission.
    pub async fn start_mission(&self, mission_id: MissionId) -> Result<Mission, RuntimeError> {
        let mut mission =
            self.store.get_mission(&mission_id).await?.ok_or_else(|| {
                RuntimeError::NotFound(format!("Mission '{}' not found", mission_id))
            })?;

        if mission.state.is_terminal() {
            return Err(RuntimeError::Conflict(format!(
                "Cannot start mission in terminal state '{}'",
                mission.state
            )));
        }

        if mission.state == MissionState::Created {
            mission.state.transition_to(MissionState::Planning)?;
        } else if mission.state == MissionState::Waiting
            || mission.state == MissionState::NeedsHuman
        {
            mission.state.transition_to(MissionState::Running)?;
        }

        self.store.update_mission(&mission).await?;
        self.running_missions.lock().await.insert(mission_id);

        self.emit_mission_event(
            mission_id,
            "mission_started",
            serde_json::json!({
                "mission_id": mission_id.to_string(),
                "state": mission.state.as_str(),
            }),
        )
        .await;

        Ok(mission)
    }

    /// Pauses an active mission into `Waiting` state.
    pub async fn pause_mission(&self, mission_id: &MissionId) -> Result<Mission, RuntimeError> {
        let mut mission =
            self.store.get_mission(mission_id).await?.ok_or_else(|| {
                RuntimeError::NotFound(format!("Mission '{}' not found", mission_id))
            })?;

        if mission.state.is_terminal() {
            return Err(RuntimeError::Conflict(format!(
                "Cannot pause mission in terminal state '{}'",
                mission.state
            )));
        }

        mission.state.transition_to(MissionState::Waiting)?;

        self.store.update_mission(&mission).await?;
        self.running_missions.lock().await.remove(mission_id);

        self.emit_mission_event(
            *mission_id,
            "mission_paused",
            serde_json::json!({ "mission_id": mission_id.to_string() }),
        )
        .await;

        Ok(mission)
    }

    /// Resumes a paused or waiting mission back to `Running`.
    pub async fn resume_mission(&self, mission_id: &MissionId) -> Result<Mission, RuntimeError> {
        self.start_mission(*mission_id).await
    }

    /// Cancels a mission administratively.
    pub async fn cancel_mission(&self, mission_id: &MissionId) -> Result<Mission, RuntimeError> {
        let mut mission =
            self.store.get_mission(mission_id).await?.ok_or_else(|| {
                RuntimeError::NotFound(format!("Mission '{}' not found", mission_id))
            })?;

        mission.state.transition_to(MissionState::Cancelled)?;

        self.store.update_mission(&mission).await?;
        self.running_missions.lock().await.remove(mission_id);

        self.emit_mission_event(
            *mission_id,
            "mission_cancelled",
            serde_json::json!({ "mission_id": mission_id.to_string() }),
        )
        .await;

        Ok(mission)
    }

    /// Escalates a mission to human attention (`NeedsHuman`).
    pub async fn escalate_human(
        &self,
        mission_id: &MissionId,
        reason: impl Into<String>,
    ) -> Result<Mission, RuntimeError> {
        let mut mission =
            self.store.get_mission(mission_id).await?.ok_or_else(|| {
                RuntimeError::NotFound(format!("Mission '{}' not found", mission_id))
            })?;

        let reason_str = reason.into();
        mission.escalation_reason = Some(reason_str.clone());
        mission.metadata["escalation_reason"] = serde_json::json!(&reason_str);
        mission.health_status = MissionHealth::Escalated;
        let _ = mission.state.transition_to(MissionState::NeedsHuman);

        self.store.update_mission(&mission).await?;
        self.running_missions.lock().await.remove(mission_id);

        self.emit_mission_event(
            *mission_id,
            "human_escalation",
            serde_json::json!({
                "mission_id": mission_id.to_string(),
                "reason": reason_str,
            }),
        )
        .await;

        Ok(mission)
    }

    /// Resolves human escalation: operator can "resume", "replan", or "cancel".
    pub async fn resolve_escalation(
        &self,
        mission_id: &MissionId,
        decision: &str,
    ) -> Result<Mission, RuntimeError> {
        let mut mission =
            self.store.get_mission(mission_id).await?.ok_or_else(|| {
                RuntimeError::NotFound(format!("Mission '{}' not found", mission_id))
            })?;

        if mission.state != MissionState::NeedsHuman {
            return Err(RuntimeError::Conflict(format!(
                "Mission '{}' is not in NeedsHuman state",
                mission_id
            )));
        }

        mission.escalation_reason = None;
        mission.health_status = MissionHealth::Healthy;

        match decision.to_lowercase().as_str() {
            "cancel" => {
                let _ = mission.state.transition_to(MissionState::Cancelled);
            }
            "replan" => {
                let _ = mission.state.transition_to(MissionState::Replanning);
                self.running_missions.lock().await.insert(*mission_id);
            }
            _ => {
                let _ = mission.state.transition_to(MissionState::Running);
                self.running_missions.lock().await.insert(*mission_id);
            }
        }

        self.store.update_mission(&mission).await?;

        self.emit_mission_event(
            *mission_id,
            "human_resolution",
            serde_json::json!({
                "mission_id": mission_id.to_string(),
                "decision": decision,
                "new_state": mission.state.as_str(),
            }),
        )
        .await;

        Ok(mission)
    }

    /// Executes a single autonomous step/cycle in the mission.
    /// This evaluates progress, checks budget, enforces stopping condition, or replans.
    pub async fn step_mission(&self, mission_id: MissionId) -> Result<Mission, RuntimeError> {
        let mut mission =
            self.store.get_mission(&mission_id).await?.ok_or_else(|| {
                RuntimeError::NotFound(format!("Mission '{}' not found", mission_id))
            })?;

        if mission.state.is_terminal() || mission.state == MissionState::NeedsHuman {
            return Ok(mission);
        }

        // 1. Budget enforcement check
        let mut tracker =
            BudgetTracker::new(mission.budget.clone(), mission.budget_consumed.clone());
        if let Some(exhaustion_reason) = tracker.check_exhaustion() {
            warn!(
                "[MissionEngine] Mission {} budget exhausted: {}",
                mission_id, exhaustion_reason
            );
            let _ = mission.state.transition_to(MissionState::BudgetExhausted);
            mission.final_outcome = Some(MissionOutcome {
                success: false,
                summary: format!(
                    "Mission halted due to budget exhaustion: {}",
                    exhaustion_reason
                ),
                verified_commit_sha: mission.latest_verified_commit.clone(),
                cycles_count: mission.cycle_index,
                completion_reason: exhaustion_reason.clone(),
            });
            self.store.update_mission(&mission).await?;
            self.running_missions.lock().await.remove(&mission_id);

            self.emit_mission_event(
                mission_id,
                "budget_warning",
                serde_json::json!({
                    "mission_id": mission_id.to_string(),
                    "reason": exhaustion_reason,
                    "budget_consumed": mission.budget_consumed,
                }),
            )
            .await;
            return Ok(mission);
        }

        // 2. Transition Planning/Replanning -> Running if starting cycle
        if mission.state == MissionState::Planning || mission.state == MissionState::Replanning {
            let _ = mission.state.transition_to(MissionState::Running);
        }

        // 3. Resolve Workspace Path
        let workspace_path = if let Some(ws_id) = mission.workspace_id {
            if let Ok(Some(ws)) = self.store.get_workspace(&ws_id).await {
                Some(ws.canonical_path)
            } else {
                None
            }
        } else {
            None
        };

        // 4. Ensure active workflow exists for current cycle
        let workflow_id = if let Some(w_id) = mission.active_workflow_id {
            w_id
        } else {
            let mut wf = Workflow::new(
                format!("{} - Cycle {}", mission.title, mission.cycle_index + 1),
                &mission.objective,
            );
            wf.workspace_id = mission.workspace_id;
            wf.metadata["cycle_index"] = serde_json::json!(mission.cycle_index);
            wf.metadata["worktree_isolation"] = serde_json::json!(true);
            if mission.cycle_index > 0 {
                if let Ok(cycles) = self.store.list_cycles(&mission.id).await {
                    let past_outcomes: Vec<String> = cycles
                        .into_iter()
                        .filter_map(|c| {
                            c.outcome
                                .map(|o| format!("Cycle {} [{}]: {}", c.cycle_index, c.phase, o))
                        })
                        .collect();
                    if !past_outcomes.is_empty() {
                        wf.metadata["failure_diagnostics"] =
                            serde_json::json!(past_outcomes.join("\n"));
                    }
                }
            }
            let backend = mission
                .metadata
                .get("backend")
                .cloned()
                .unwrap_or_else(|| serde_json::json!("gemini_cli"));
            wf.metadata["backend"] = backend;
            let wf_id = wf.id;
            self.store.create_workflow(&wf).await?;
            mission.active_workflow_id = Some(wf_id);
            wf_id
        };

        // 4.5. Execute workflow cycle via WorkflowExecutor if registered
        let execution_summary = if let Some(ref executor) = self.workflow_executor {
            let summary = executor
                .execute_workflow_cycle(&workflow_id, &mission_id)
                .await?;
            info!(
                "[MissionEngine] Mission {} executed workflow cycle: {} tasks executed, {} completed, {} failed",
                mission_id,
                summary.executed_tasks_count,
                summary.completed_tasks_count,
                summary.failed_tasks_count
            );
            if summary.executed_tasks_count > 0 {
                for _ in 0..summary.executed_tasks_count {
                    tracker.record_execution();
                }
                mission.budget_consumed.total_executions = tracker.consumed.total_executions;
            }
            Some(summary)
        } else {
            tracker.record_execution();
            mission.budget_consumed.total_executions = tracker.consumed.total_executions;
            None
        };

        // 5. Query task status and candidate deliverable
        let tasks = self.store.list_tasks_by_workflow(&workflow_id).await?;

        // Determine target path for stopping condition evaluation:
        // If an agent produced changes in an isolated worktree, verify that candidate worktree.
        let candidate_worktree = tasks
            .iter()
            .rev()
            .find(|t| {
                (t.state == TaskState::Verified || t.state == TaskState::AwaitingVerification)
                    && t.metadata.get("commit_sha").is_some()
                    && t.metadata.get("worktree_path").is_some()
            })
            .or_else(|| {
                tasks.iter().rev().find(|t| {
                    (t.state == TaskState::Verified || t.state == TaskState::AwaitingVerification)
                        && t.metadata.get("worktree_path").is_some()
                })
            })
            .or_else(|| {
                tasks.iter().rev().find(|t| {
                    t.metadata.get("commit_sha").is_some()
                        && t.metadata.get("worktree_path").is_some()
                })
            });

        let (eval_path, candidate_commit) = if let Some(t) = candidate_worktree {
            let p = t
                .metadata
                .get("worktree_path")
                .and_then(|v| v.as_str())
                .map(std::path::PathBuf::from);
            let sha = t
                .metadata
                .get("commit_sha")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            if let Some(ref path) = p {
                if path.exists() {
                    (Some(path.clone()), sha)
                } else {
                    (workspace_path.clone(), sha)
                }
            } else {
                (workspace_path.clone(), sha)
            }
        } else {
            (workspace_path.clone(), None)
        };

        // 5. Physical Stopping Condition Evaluation
        if let Some(ref path) = eval_path {
            let (stop_satisfied, commit_sha_opt) =
                self.evaluate_stopping_condition(path, &mission.stopping_condition);
            let verified_commit = commit_sha_opt.or(candidate_commit.clone());
            if stop_satisfied {
                info!(
                    "[MissionEngine] Mission {} verified stopping condition satisfied at commit {}",
                    mission_id,
                    verified_commit.as_deref().unwrap_or("none")
                );
                let _ = mission.state.transition_to(MissionState::Verifying);
                self.emit_mission_event(
                    mission_id,
                    "verification_passed",
                    serde_json::json!({
                        "mission_id": mission_id.to_string(),
                        "verified_commit": verified_commit,
                    }),
                )
                .await;

                let _ = mission
                    .state
                    .transition_to(MissionState::AwaitingAcceptance);
                mission.latest_verified_commit = verified_commit.clone();
                mission.final_outcome = Some(MissionOutcome {
                    success: true,
                    summary: format!(
                        "Mission stopping conditions physically verified after {} cycles. Review package ready; awaiting human acceptance.",
                        mission.cycle_index + 1
                    ),
                    verified_commit_sha: verified_commit.clone(),
                    cycles_count: mission.cycle_index + 1,
                    completion_reason: "All verified stopping conditions satisfied on disk; awaiting human acceptance".to_string(),
                });

                // Record cycle completion journal
                let mut cycle =
                    MissionCycle::new(mission_id, mission.cycle_index, workflow_id, "verification");
                cycle.completed_at = Some(Utc::now());
                cycle.outcome = Some(
                    "All physical stopping conditions verified on disk. Awaiting human acceptance."
                        .to_string(),
                );
                if let Some(ref s) = execution_summary {
                    cycle.discovered_tasks_count = s.discovered_tasks_count as u32;
                }
                let _ = self.store.create_cycle(&cycle).await;

                // Persist final checkpoint
                let active_execs = execution_summary
                    .as_ref()
                    .map(|s| s.active_executions.clone())
                    .unwrap_or_default();
                let _ = self
                    .checkpoint_mgr
                    .create_checkpoint(
                        mission_id,
                        mission.cycle_index,
                        workflow_id,
                        mission.budget_consumed.clone(),
                        mission.latest_verified_commit.clone(),
                        active_execs,
                        serde_json::json!({ "completion": "stopping_condition_satisfied", "awaiting_acceptance": true }),
                    )
                    .await;

                self.store.update_mission(&mission).await?;
                self.running_missions.lock().await.remove(&mission_id);

                self.emit_mission_event(
                    mission_id,
                    "mission_awaiting_acceptance",
                    serde_json::json!({
                        "mission_id": mission_id.to_string(),
                        "verified_commit": verified_commit,
                        "cycle_index": mission.cycle_index,
                        "outcome": mission.final_outcome,
                    }),
                )
                .await;

                return Ok(mission);
            }
        }

        // Check if any task escalated to NeedsHuman directly
        if let Some(needs_human_task) = tasks.iter().find(|t| t.state == TaskState::NeedsHuman) {
            let reason = needs_human_task
                .metadata
                .get("fatal_reason")
                .or_else(|| needs_human_task.metadata.get("escalation_reason"))
                .and_then(|v| v.as_str())
                .unwrap_or("Task requires human intervention");
            self.escalate_human(
                &mission_id,
                format!("Task '{}' escalated: {}", needs_human_task.id, reason),
            )
            .await?;
            return self
                .store
                .get_mission(&mission_id)
                .await?
                .ok_or_else(|| RuntimeError::NotFound("Mission not found".into()));
        }

        // Check if any task failed with an unrecoverable provider requirement error
        for t in &tasks {
            if t.state == TaskState::Failed {
                if let Ok(execs) = self.store.list_executions_by_task(&t.id).await {
                    for exec in execs {
                        if let Some(ref fail_msg) = exec.error_message {
                            let fail_lower = fail_msg.to_lowercase();
                            if fail_lower.contains("not installed")
                                || fail_lower.contains("not found on path")
                                || fail_lower.contains("authentication_required")
                                || fail_lower.contains("executable not found")
                            {
                                warn!("[MissionEngine] Unrecoverable provider error detected in task {}: {}", t.id, fail_msg);
                                self.escalate_human(
                                    &mission_id,
                                    format!("Provider unavailable: {}", fail_msg),
                                )
                                .await?;
                                return self.store.get_mission(&mission_id).await?.ok_or_else(
                                    || RuntimeError::NotFound("Mission not found".into()),
                                );
                            }
                        }
                    }
                }
            }
        }

        let completed_count = tasks
            .iter()
            .filter(|t| t.state == TaskState::Verified)
            .count();
        let failed_or_blocked = tasks
            .iter()
            .any(|t| t.state == TaskState::Failed || t.state == TaskState::Blocked)
            || execution_summary
                .as_ref()
                .map(|s| s.failed_tasks_count > 0)
                .unwrap_or(false);

        // 7. Liveness and Stagnation Check
        let current_commit = candidate_commit
            .or_else(|| workspace_path.as_ref().and_then(|p| get_git_commit_sha(p)));
        let snapshot = ProgressSnapshot::new(completed_count, tasks.len(), current_commit.clone());

        let mut liveness =
            LivenessEvaluator::new(mission.budget.max_stagnant_cycles, snapshot.clone());
        liveness.consecutive_stagnant_cycles = mission.budget_consumed.stagnant_cycles;
        let (health, progressed) = liveness.evaluate(snapshot);
        mission.health_status = health;

        if progressed {
            tracker.reset_stagnant_cycles();
            mission.budget_consumed.stagnant_cycles = 0;
        } else {
            tracker.record_stagnant_cycle();
            mission.budget_consumed.stagnant_cycles = tracker.consumed.stagnant_cycles;
            if mission.budget_consumed.stagnant_cycles >= mission.budget.max_stagnant_cycles {
                warn!(
                    "[MissionEngine] Stagnation detected in mission {}: {} cycles without progress",
                    mission_id, mission.budget_consumed.stagnant_cycles
                );
                self.emit_mission_event(
                    mission_id,
                    "stagnation_detected",
                    serde_json::json!({
                        "mission_id": mission_id.to_string(),
                        "stagnant_cycles": mission.budget_consumed.stagnant_cycles,
                    }),
                )
                .await;

                let mut last_error_context = String::new();
                for t in &tasks {
                    if let Ok(execs) = self.store.list_executions_by_task(&t.id).await {
                        for ex in execs {
                            if let Some(ref r) = ex.error_message {
                                last_error_context = format!(": {}", r);
                                break;
                            }
                        }
                    }
                    if !last_error_context.is_empty() {
                        break;
                    }
                }

                // Escalate to human operator when stagnation threshold is reached
                let _ = self
                    .escalate_human(
                        &mission_id,
                        format!(
                            "Stagnation detected: {} consecutive cycles with no observable code or task progress{}",
                            mission.budget_consumed.stagnant_cycles,
                            last_error_context
                        ),
                    )
                    .await;
                return self
                    .store
                    .get_mission(&mission_id)
                    .await?
                    .ok_or_else(|| RuntimeError::NotFound("Mission not found".into()));
            }
        }

        // 8. Check if cycle requires replanning / continuation
        if failed_or_blocked || (completed_count == tasks.len() && !tasks.is_empty()) {
            // Cycle ended without meeting physical stop condition -> Trigger Replanning
            info!(
                "[MissionEngine] Cycle {} ended for mission {}. Initiating adaptive replanning.",
                mission.cycle_index, mission_id
            );
            let _ = mission.state.transition_to(MissionState::Replanning);

            // Record cycle journal
            let mut cycle = MissionCycle::new(
                mission_id,
                mission.cycle_index,
                workflow_id,
                if failed_or_blocked {
                    "recovery"
                } else {
                    "continuation"
                },
            );
            cycle.completed_at = Some(Utc::now());
            cycle.outcome = Some(if failed_or_blocked {
                "Cycle failed verification or encountered task error; replanning required"
                    .to_string()
            } else {
                "Cycle tasks completed without satisfying stopping condition; replanning required"
                    .to_string()
            });
            if let Some(ref s) = execution_summary {
                cycle.discovered_tasks_count = s.discovered_tasks_count as u32;
            }
            let _ = self.store.create_cycle(&cycle).await;

            mission.cycle_index += 1;
            tracker.record_planner_iteration();
            mission.budget_consumed = tracker.consumed.clone();
            mission.active_workflow_id = None; // Reset active workflow so next cycle creates revised work

            self.emit_mission_event(
                mission_id,
                "replan_started",
                serde_json::json!({
                    "mission_id": mission_id.to_string(),
                    "new_cycle_index": mission.cycle_index,
                    "failed_or_blocked": failed_or_blocked,
                }),
            )
            .await;
        }

        // 9. Create Progress Checkpoint
        let active_execs = execution_summary
            .as_ref()
            .map(|s| s.active_executions.clone())
            .unwrap_or_default();
        let _ = self
            .checkpoint_mgr
            .create_checkpoint(
                mission_id,
                mission.cycle_index,
                workflow_id,
                mission.budget_consumed.clone(),
                current_commit,
                active_execs,
                serde_json::json!({
                    "cycle_index": mission.cycle_index,
                    "completed_tasks": completed_count,
                    "total_tasks": tasks.len(),
                    "failed_or_blocked": failed_or_blocked,
                }),
            )
            .await;
        self.store.update_mission(&mission).await?;

        self.emit_mission_event(
            mission_id,
            "progress_checkpoint",
            serde_json::json!({
                "mission_id": mission_id.to_string(),
                "cycle_index": mission.cycle_index,
                "completed_tasks": completed_count,
                "total_tasks": tasks.len(),
            }),
        )
        .await;

        Ok(mission)
    }

    /// Evaluates if the physical stopping condition is satisfied on disk.
    fn evaluate_stopping_condition(
        &self,
        workspace_path: &std::path::Path,
        cond: &StoppingCondition,
    ) -> (bool, Option<String>) {
        let commit_sha = get_git_commit_sha(workspace_path);

        // 1. Required Commit check
        if cond.required_commit_exists && commit_sha.is_none() {
            return (false, None);
        }

        // 2. Working tree clean check
        if cond.working_tree_clean {
            let output = std::process::Command::new("git")
                .args(["status", "--porcelain"])
                .current_dir(workspace_path)
                .output();
            if let Ok(out) = output {
                let status_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
                if !status_str.is_empty() {
                    return (false, commit_sha);
                }
            } else {
                return (false, commit_sha);
            }
        }

        // 3. Automated cargo test verification
        if cond.required_tests_pass {
            let output = std::process::Command::new("cargo")
                .args(["test"])
                .current_dir(workspace_path)
                .output();
            match output {
                Ok(out) => {
                    if !out.status.success() {
                        return (false, commit_sha);
                    }
                }
                Err(_) => return (false, commit_sha),
            }
        }

        // 4. Custom verifier command if specified
        if let Some(ref cmd) = cond.custom_verifier {
            let parts: Vec<&str> = cmd.split_whitespace().collect();
            if !parts.is_empty() {
                let output = std::process::Command::new(parts[0])
                    .args(&parts[1..])
                    .current_dir(workspace_path)
                    .output();
                if let Ok(out) = output {
                    if !out.status.success() {
                        return (false, commit_sha);
                    }
                } else {
                    return (false, commit_sha);
                }
            }
        }

        (true, commit_sha)
    }
}

/// Helper extracting HEAD commit SHA from a git repository directory.
fn get_git_commit_sha(dir: &std::path::Path) -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-parse", "HEAD"])
        .current_dir(dir)
        .output()
        .ok()?;
    if output.status.success() {
        let sha = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if !sha.is_empty() {
            return Some(sha);
        }
    }
    None
}

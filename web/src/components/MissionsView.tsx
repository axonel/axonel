import React, { useState, useEffect } from 'react';
import {
  Target,
  Plus,
  Play,
  Pause,
  RotateCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  GitCommit,
  ShieldAlert,
  RefreshCw,
  GitPullRequest,
  Eye,
  Check,
  X,
  FileText,
  Clock,
  Cpu,
} from 'lucide-react';
import { api } from '../services/api';
import {
  Mission,
  MissionCheckpoint,
  MissionCycle,
  EventRecord,
  MissionState,
  MissionReviewPackage,
  Workspace,
} from '../types';
import { Button, Badge, BadgeVariant, Panel, Modal, Input, Textarea, Select } from './ui';

interface MissionsViewProps {
  onSelectWorkflow?: (id: string) => void;
  activeWorkspace?: Workspace | null;
}

export const MissionsView: React.FC<MissionsViewProps> = ({
  onSelectWorkflow,
  activeWorkspace,
}) => {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selectedMission, setSelectedMission] = useState<Mission | null>(null);
  const [checkpoints, setCheckpoints] = useState<MissionCheckpoint[]>([]);
  const [cycles, setCycles] = useState<MissionCycle[]>([]);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);

  // New Mission Modal State
  const [showNewModal, setShowNewModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newObjective, setNewObjective] = useState('');
  const [newMaxDuration, setNewMaxDuration] = useState(7200);
  const [newMaxExecutions, setNewMaxExecutions] = useState(25);
  const [newMaxStagnant, setNewMaxStagnant] = useState(3);
  const [newRequireTests, setNewRequireTests] = useState(true);
  const [newRequireCleanTree, setNewRequireCleanTree] = useState(true);
  const [newRequireCommit, setNewRequireCommit] = useState(true);
  const [newAutoStart, setNewAutoStart] = useState(true);
  const [newBackend, setNewBackend] = useState('gemini_cli');

  // Human Escalation Modal / Prompt State
  const [escalateReason, setEscalateReason] = useState('');
  const [showEscalatePrompt, setShowEscalatePrompt] = useState(false);

  // Review Package & Human Acceptance Modal State
  const [reviewPackage, setReviewPackage] = useState<MissionReviewPackage | null>(null);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectModal, setShowRejectModal] = useState(false);
  const [replanOnReject, setReplanOnReject] = useState(false);

  const fetchMissions = async () => {
    setLoading(true);
    try {
      const list = await api.listMissions();
      setMissions(list);
      if (selectedMission) {
        const updated = list.find((m) => m.id === selectedMission.id);
        if (updated) setSelectedMission(updated);
      } else if (list.length > 0) {
        setSelectedMission(list[0]);
      }
    } catch (err) {
      console.error('Failed to load missions:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMissions();
    const interval = setInterval(fetchMissions, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadMissionDetails = async (m: Mission) => {
    setSelectedMission(m);
    try {
      const [ckpts, cycs, evts] = await Promise.all([
        api.listMissionCheckpoints(m.id).catch(() => []),
        api.listMissionCycles(m.id).catch(() => []),
        api.listMissionEvents(m.id).catch(() => []),
      ]);
      setCheckpoints(ckpts);
      setCycles(cycs);
      setEvents(evts);
    } catch (err) {
      console.error('Failed to load mission details:', err);
    }
  };

  useEffect(() => {
    if (selectedMission) {
      loadMissionDetails(selectedMission);
    }
  }, [selectedMission?.id]);

  const handleCreateMission = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newObjective.trim()) return;

    setActionLoading(true);
    try {
      const created = await api.createMission({
        title: newTitle,
        objective: newObjective,
        workspace_id: activeWorkspace?.id || null,
        budget: {
          max_duration_secs: newMaxDuration,
          max_concurrent_agents: 4,
          max_executions: newMaxExecutions,
          max_recovery_attempts: 5,
          max_planner_iterations: 10,
          max_stagnant_cycles: newMaxStagnant,
        },
        stopping_condition: {
          required_tests_pass: newRequireTests,
          working_tree_clean: newRequireCleanTree,
          required_commit_exists: newRequireCommit,
        },
        auto_start: newAutoStart,
        metadata: {
          backend: newBackend,
        },
      });
      setShowNewModal(false);
      setNewTitle('');
      setNewObjective('');
      await fetchMissions();
      setSelectedMission(created);
    } catch (err) {
      alert(`Failed to create mission: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = async (id: string) => {
    setActionLoading(true);
    try {
      const updated = await api.startMission(id);
      setSelectedMission(updated);
      await fetchMissions();
    } catch (err) {
      alert(`Start failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handlePause = async (id: string) => {
    setActionLoading(true);
    try {
      const updated = await api.pauseMission(id);
      setSelectedMission(updated);
      await fetchMissions();
    } catch (err) {
      alert(`Pause failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async (id: string) => {
    setActionLoading(true);
    try {
      const updated = await api.resumeMission(id);
      setSelectedMission(updated);
      await fetchMissions();
    } catch (err) {
      alert(`Resume failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStep = async (id: string) => {
    setActionLoading(true);
    try {
      const updated = await api.stepMission(id);
      setSelectedMission(updated);
      await loadMissionDetails(updated);
      await fetchMissions();
    } catch (err) {
      alert(`Step failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async (id: string) => {
    if (!confirm('Are you sure you want to cancel this mission?')) return;
    setActionLoading(true);
    try {
      const updated = await api.cancelMission(id);
      setSelectedMission(updated);
      await fetchMissions();
    } catch (err) {
      alert(`Cancel failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleEscalate = async (id: string) => {
    if (!escalateReason.trim()) return;
    setActionLoading(true);
    try {
      const updated = await api.escalateMission(id, escalateReason);
      setSelectedMission(updated);
      setShowEscalatePrompt(false);
      setEscalateReason('');
      await fetchMissions();
    } catch (err) {
      alert(`Escalation failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleResolve = async (id: string, decision: 'resume' | 'replan' | 'cancel') => {
    setActionLoading(true);
    try {
      const updated = await api.resolveMission(id, decision);
      setSelectedMission(updated);
      await fetchMissions();
    } catch (err) {
      alert(`Resolution failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleOpenReview = async (id: string) => {
    setActionLoading(true);
    try {
      const pkg = await api.getMissionReview(id);
      setReviewPackage(pkg);
      setShowReviewModal(true);
    } catch (err) {
      alert(`Failed to load review package: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleAccept = async (id: string, integrate: boolean) => {
    setActionLoading(true);
    try {
      await api.acceptMission(id, { integrate });
      if (integrate) {
        alert(`Mission deliverable accepted and successfully integrated!`);
      } else {
        alert(`Mission deliverable accepted. Ready for integration.`);
      }
      await fetchMissions();
      if (showReviewModal) setShowReviewModal(false);
    } catch (err) {
      alert(`Acceptance failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleRejectConfirm = async (id: string) => {
    if (!rejectReason.trim()) return;
    setActionLoading(true);
    try {
      await api.rejectMission(id, { reason: rejectReason, continue_mission: replanOnReject });
      setShowRejectModal(false);
      setRejectReason('');
      await fetchMissions();
      if (showReviewModal) setShowReviewModal(false);
    } catch (err) {
      alert(`Rejection failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleIntegrate = async (id: string) => {
    setActionLoading(true);
    try {
      const res = await api.integrateMission(id);
      alert(`Integrated: ${res.integration_summary}`);
      await fetchMissions();
      if (showReviewModal) setShowReviewModal(false);
    } catch (err) {
      alert(`Integration failed: ${err}`);
    } finally {
      setActionLoading(false);
    }
  };

  const getStateBadgeVariant = (state: MissionState): BadgeVariant => {
    switch (state) {
      case 'running':
      case 'planning':
      case 'verifying':
        return 'running';
      case 'replanning':
      case 'awaiting_acceptance':
        return 'awaiting';
      case 'accepted':
        return 'accepted';
      case 'integrating':
        return 'integrating';
      case 'integrated':
      case 'completed':
        return 'verified';
      case 'needs_human':
        return 'needshuman';
      case 'rejected':
        return 'rejected';
      case 'budget_exhausted':
      case 'failed':
        return 'failed';
      case 'waiting':
      case 'cancelled':
      default:
        return 'neutral';
    }
  };

  const getStateLabel = (state: MissionState, reverificationRequired?: boolean) => {
    if (reverificationRequired) return 'BLOCKED (STALE TARGET)';
    switch (state) {
      case 'awaiting_acceptance':
        return 'READY FOR REVIEW';
      case 'accepted':
        return 'ACCEPTED';
      case 'integrating':
        return 'INTEGRATING';
      case 'integrated':
        return 'INTEGRATED';
      case 'needs_human':
        return 'BLOCKED (OPERATOR)';
      case 'rejected':
        return 'REJECTED';
      case 'running':
        return 'RUNNING';
      case 'planning':
        return 'PLANNING';
      case 'replanning':
        return 'REPLANNING';
      case 'verifying':
        return 'VERIFYING';
      case 'budget_exhausted':
        return 'BUDGET EXHAUSTED';
      case 'failed':
        return 'FAILED';
      case 'completed':
        return 'COMPLETED';
      case 'cancelled':
        return 'CANCELLED';
      default:
        return (state as string).toUpperCase();
    }
  };

  const getNarrativeStory = (m: Mission) => {
    let currentState = '';
    let whatHappened = '';
    let nextAction = '';

    switch (m.state) {
      case 'awaiting_acceptance':
        currentState = 'Halted at human acceptance gate';
        whatHappened = `Cycle ${m.cycle_index + 1} completed all tasks. Independent verifier validated stopping conditions passed at commit ${
          m.latest_verified_commit ? m.latest_verified_commit.slice(0, 7) : 'HEAD'
        }. Working tree is clean.`;
        nextAction = 'Operator review required: inspect diff and accept or reject.';
        break;
      case 'replanning':
        currentState = `Cycle ${m.cycle_index + 1} replanning active`;
        whatHappened = `Cycle ${m.cycle_index} failed verification or encountered a task error. Candidate changes were safely isolated, and Sentinel initiated autonomous replanning.`;
        nextAction = 'No human action required. Agent is formulating new strategy.';
        break;
      case 'running':
      case 'planning':
        currentState = `Cycle ${m.cycle_index + 1} execution in progress`;
        whatHappened = `Autonomous agent loop is executing tasks in isolated Git worktree (${
          m.active_workflow_id ? 'Workflow ' + m.active_workflow_id : 'active'
        }).`;
        nextAction = 'No human action required. Execution progressing autonomously.';
        break;
      case 'needs_human':
        currentState = 'Blocked: operator guidance needed';
        whatHappened =
          m.escalation_reason ||
          'Mission halted pending operator guidance or policy resolution.';
        nextAction = 'Operator must resolve escalation: Resume, Replan, or Cancel.';
        break;
      case 'accepted':
        currentState = 'Deliverable accepted by operator';
        whatHappened = `Verified commit ${
          m.latest_verified_commit ? m.latest_verified_commit.slice(0, 7) : 'HEAD'
        } approved. Ready for integration into target repository.`;
        nextAction = 'Click "Integrate" to merge deliverable into target branch.';
        break;
      case 'integrated':
        currentState = 'Deliverable successfully integrated';
        whatHappened = `Verified commit ${
          m.latest_verified_commit ? m.latest_verified_commit.slice(0, 7) : 'HEAD'
        } merged into target branch. Working tree clean.`;
        nextAction = 'Mission completed successfully. No further action needed.';
        break;
      case 'rejected':
        currentState = 'Deliverable rejected by operator';
        whatHappened = (m as any).metadata?.rejection_reason
          ? `Rejected: ${(m as any).metadata.rejection_reason}`
          : 'Operator rejected deliverable. Candidate branch preserved for audit.';
        nextAction = 'No further action. Mission is closed.';
        break;
      case 'failed':
      case 'budget_exhausted':
        currentState = 'Mission halted (exhausted or failed)';
        whatHappened =
          'Execution budget reached limits or unrecoverable error occurred.';
        nextAction = 'Review execution cycles history and adjust budget parameters.';
        break;
      default:
        currentState = `State: ${m.state}`;
        whatHappened = `Mission initialized with ${m.budget.max_executions} max executions.`;
        nextAction = 'Click Start to launch autonomous execution.';
    }

    return { currentState, whatHappened, nextAction };
  };

  const narrative = selectedMission ? getNarrativeStory(selectedMission) : null;

  return (
    <div className="space-y-6 pb-12">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2.5">
            <Target className="w-5 h-5 text-sentinel-lime" />
            <h1 className="text-lg sm:text-xl font-bold text-gray-100 font-sans tracking-tight">
              Mission Control
            </h1>
            {selectedMission && (
              <span className="text-[11px] font-mono text-gray-400 px-2 py-0.5 rounded bg-surface-card border border-surface-border">
                Cycle {selectedMission.cycle_index + 1}
              </span>
            )}
          </div>
          <p className="text-xs text-gray-400 mt-1 font-sans">
            Durable long-horizon execution engine with physical stop conditions, verifiable git artifacts, and human acceptance gates
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={fetchMissions}
            title="Refresh missions"
            aria-label="Refresh missions"
            loading={loading}
            icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => setShowNewModal(true)}
            icon={<Plus className="w-3.5 h-3.5" />}
          >
            Launch Mission
          </Button>
        </div>
      </div>

      {/* Main operational grid: Missions List & Detail */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Mission Directory */}
        <div className="space-y-3">
          <div className="flex items-center justify-between text-xs font-sans text-gray-400 px-1">
            <span className="uppercase tracking-wider font-semibold text-gray-500">
              Missions ({missions.length})
            </span>
            {activeWorkspace && (
              <span className="text-[11px] text-gray-400 truncate max-w-[140px] font-mono">
                {activeWorkspace.name}
              </span>
            )}
          </div>

          {missions.length === 0 && (
            <div className="p-8 border border-dashed border-surface-border rounded text-center bg-surface-card/40">
              <Target className="w-7 h-7 text-gray-600 mx-auto mb-2" />
              <p className="text-xs text-gray-300 font-medium font-sans">No missions initialized</p>
              <p className="text-[11px] text-gray-500 mt-0.5 font-sans">
                Launch a durable mission to run across multiple cycles.
              </p>
              <Button
                variant="lime-outline"
                size="xs"
                onClick={() => setShowNewModal(true)}
                className="mt-3"
              >
                + Launch first mission
              </Button>
            </div>
          )}

          <div className="space-y-2">
            {missions.map((m) => {
              const isSelected = selectedMission?.id === m.id;
              const isAwaiting = m.state === 'awaiting_acceptance';
              const isNeedsHuman = m.state === 'needs_human';

              return (
                <div
                  key={m.id}
                  onClick={() => loadMissionDetails(m)}
                  className={`p-3.5 rounded border cursor-pointer transition-all ${
                    isSelected
                      ? 'bg-surface-card border-sentinel-lime/60 shadow-xs ring-1 ring-sentinel-lime/20'
                      : 'bg-surface-card/70 border-surface-border hover:border-surface-border-bold hover:bg-surface-hover/40'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <h3 className="text-xs sm:text-sm font-semibold text-gray-200 line-clamp-1 font-sans">
                      {m.title}
                    </h3>
                    <Badge
                      variant={getStateBadgeVariant(m.state)}
                      size="xs"
                      pulse={isAwaiting || isNeedsHuman || m.state === 'running'}
                      statusDot
                    >
                      {getStateLabel(m.state)}
                    </Badge>
                  </div>

                  <p className="text-[11px] text-gray-400 line-clamp-2 mb-2.5 font-sans leading-relaxed">
                    {m.objective}
                  </p>

                  <div className="flex items-center justify-between text-[10px] font-mono text-gray-400 pt-2 border-t border-surface-border/60">
                    <span className="flex items-center gap-1">
                      <RotateCw className="w-3 h-3 text-gray-400" />
                      <span>Cycle {m.cycle_index + 1}</span>
                    </span>

                    {m.budget_consumed.stagnant_cycles > 0 && (
                      <span className="text-amber-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />
                        <span>Stag: {m.budget_consumed.stagnant_cycles}</span>
                      </span>
                    )}

                    {m.latest_verified_commit ? (
                      <span className="text-emerald-400 flex items-center gap-1 font-mono">
                        <GitCommit className="w-3 h-3" />
                        <span>{m.latest_verified_commit.slice(0, 7)}</span>
                      </span>
                    ) : (
                      <span className="text-gray-500">no commit</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Right Column: Mission Telemetry & Operations Console */}
        <div className="lg:col-span-2 space-y-5">
          {selectedMission ? (
            <div className="space-y-5">
              {/* Mission Header & Operational Actions */}
              <div className="p-4 sm:p-5 rounded border border-surface-border bg-surface-card/60 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2.5 mb-1 flex-wrap">
                    <h2 className="text-base sm:text-lg font-bold text-gray-100 font-sans tracking-tight">
                      {selectedMission.title}
                    </h2>
                    <Badge
                      variant={getStateBadgeVariant(selectedMission.state)}
                      size="xs"
                      pulse={
                        selectedMission.state === 'awaiting_acceptance' ||
                        selectedMission.state === 'needs_human' ||
                        selectedMission.state === 'running'
                      }
                      statusDot
                    >
                      {getStateLabel(selectedMission.state)}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2 text-[11px] text-gray-400 font-mono">
                    <span>ID: {selectedMission.id}</span>
                    {selectedMission.active_workflow_id && onSelectWorkflow && (
                      <>
                        <span className="text-surface-border-bold">•</span>
                        <button
                          onClick={() => onSelectWorkflow(selectedMission.active_workflow_id!)}
                          className="text-sentinel-lime hover:underline flex items-center gap-1 font-sans"
                        >
                          <span>Workflow {selectedMission.active_workflow_id}</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>

                {/* Operational Controls */}
                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  {selectedMission.state === 'created' && (
                    <Button
                      variant="primary"
                      size="xs"
                      disabled={actionLoading}
                      onClick={() => handleStart(selectedMission.id)}
                      icon={<Play className="w-3.5 h-3.5" />}
                    >
                      Start
                    </Button>
                  )}

                  {(selectedMission.state === 'running' || selectedMission.state === 'planning') && (
                    <>
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => handleStep(selectedMission.id)}
                        icon={<RotateCw className={`w-3.5 h-3.5 ${actionLoading ? 'animate-spin' : ''}`} />}
                        title="Execute next autonomous cycle step"
                      >
                        Step Cycle
                      </Button>

                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => handlePause(selectedMission.id)}
                        icon={<Pause className="w-3.5 h-3.5 text-amber-400" />}
                      >
                        Pause
                      </Button>
                    </>
                  )}

                  {selectedMission.state === 'waiting' && (
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={actionLoading}
                      onClick={() => handleResume(selectedMission.id)}
                      icon={<Play className="w-3.5 h-3.5 text-emerald-400" />}
                    >
                      Resume
                    </Button>
                  )}

                  {selectedMission.state === 'awaiting_acceptance' && (
                    <>
                      <Button
                        variant="secondary"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => handleOpenReview(selectedMission.id)}
                        icon={<Eye className="w-3.5 h-3.5" />}
                      >
                        Review
                      </Button>
                      <Button
                        variant="primary"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => handleAccept(selectedMission.id, true)}
                        icon={<Check className="w-3.5 h-3.5" />}
                      >
                        Accept & Integrate
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => {
                          setRejectReason('');
                          setReplanOnReject(false);
                          setShowRejectModal(true);
                        }}
                        icon={<X className="w-3.5 h-3.5" />}
                      >
                        Reject
                      </Button>
                    </>
                  )}

                  {selectedMission.state === 'accepted' && (
                    <>
                      <Button
                        variant="primary"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => handleIntegrate(selectedMission.id)}
                        icon={<GitPullRequest className="w-3.5 h-3.5" />}
                      >
                        Integrate
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => {
                          setRejectReason('');
                          setReplanOnReject(false);
                          setShowRejectModal(true);
                        }}
                        icon={<X className="w-3.5 h-3.5" />}
                      >
                        Reject
                      </Button>
                    </>
                  )}

                  {!['completed', 'integrated', 'rejected', 'failed', 'cancelled', 'budget_exhausted'].includes(
                    selectedMission.state
                  ) && (
                    <>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => setShowEscalatePrompt(true)}
                        icon={<ShieldAlert className="w-3.5 h-3.5 text-amber-400" />}
                      >
                        Escalate
                      </Button>

                      <Button
                        variant="danger-ghost"
                        size="xs"
                        disabled={actionLoading}
                        onClick={() => handleCancel(selectedMission.id)}
                        icon={<XCircle className="w-3.5 h-3.5" />}
                      >
                        Cancel
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {/* EXECUTIVE SUMMARY / MISSION STORY CARD */}
              {narrative && (
                <div className="p-4 sm:p-5 rounded border border-surface-border bg-surface-card/40 space-y-3">
                  <div className="flex items-center justify-between pb-2 border-b border-surface-border/60">
                    <span className="text-xs font-semibold text-gray-300 uppercase tracking-wider font-sans">
                      Executive Summary
                    </span>
                    <span className="text-xs text-gray-400 font-sans">
                      Cycle {selectedMission.cycle_index + 1}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                    <div>
                      <span className="text-[10px] uppercase font-semibold tracking-wider text-gray-500 font-sans block mb-1">
                        Current Status
                      </span>
                      <p className="text-xs font-semibold text-gray-100 font-sans">
                        {getStateLabel(selectedMission.state)}
                      </p>
                      <p className="text-[11px] text-gray-400 mt-1 font-sans leading-relaxed">
                        {narrative.currentState}
                      </p>
                    </div>

                    <div>
                      <span className="text-[10px] uppercase font-semibold tracking-wider text-gray-500 font-sans block mb-1">
                        What Happened
                      </span>
                      <p className="text-xs text-gray-300 font-sans leading-relaxed">
                        {narrative.whatHappened}
                      </p>
                    </div>

                    <div>
                      <span className="text-[10px] uppercase font-semibold tracking-wider text-gray-500 font-sans block mb-1">
                        Next Action
                      </span>
                      <p className="text-xs font-medium text-sentinel-lime font-sans leading-relaxed">
                        {narrative.nextAction}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* HIGH-CONTRAST ATTENTION BANNERS */}

              {/* Acceptance Gate Banner: Awaiting Acceptance */}
              {selectedMission.state === 'awaiting_acceptance' && (
                <div className="p-4 sm:p-5 bg-amber-950/25 border border-amber-500/40 rounded space-y-3 shadow-md">
                  <div className="flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-sentinel-lime shrink-0 mt-0.5" />
                    <div className="space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-bold text-amber-200 font-sans">
                          Physical Verification Passed — Human Acceptance Required
                        </span>
                        <Badge variant="lime" size="xs">
                          ACTION REQUIRED
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-200 font-sans leading-relaxed">
                        Independent verifier confirmed stopping conditions passed at commit{' '}
                        <code className="px-1.5 py-0.5 bg-surface-base border border-surface-border rounded font-mono text-amber-300 text-xs">
                          {selectedMission.latest_verified_commit ? selectedMission.latest_verified_commit.slice(0, 7) : 'HEAD'}
                        </code>
                        . Execution has halted safely. Target branch will not be modified without your explicit approval.
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 pt-3 border-t border-amber-800/40 flex-wrap">
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={actionLoading}
                      onClick={() => handleAccept(selectedMission.id, true)}
                      icon={<Check className="w-4 h-4" />}
                    >
                      Accept & Integrate
                    </Button>
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={actionLoading}
                      onClick={() => handleOpenReview(selectedMission.id)}
                      icon={<Eye className="w-3.5 h-3.5" />}
                    >
                      Inspect Review Package
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={actionLoading}
                      onClick={() => handleAccept(selectedMission.id, false)}
                    >
                      Accept Only
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={actionLoading}
                      onClick={() => {
                        setRejectReason('');
                        setReplanOnReject(false);
                        setShowRejectModal(true);
                      }}
                      icon={<X className="w-3.5 h-3.5" />}
                    >
                      Reject
                    </Button>
                  </div>
                </div>
              )}

              {/* Replanning Attention Banner */}
              {selectedMission.state === 'replanning' && (
                <div className="p-4 bg-amber-950/20 border border-amber-500/30 rounded flex items-start gap-3">
                  <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <h4 className="text-xs font-semibold text-amber-300 font-sans">
                      Autonomous Replanning in Progress (Cycle {selectedMission.cycle_index + 1})
                    </h4>
                    <p className="text-xs text-gray-300 font-sans leading-relaxed">
                      Previous execution cycle did not satisfy all stopping conditions or encountered an execution fault. Candidate changes were safely rolled back, and Sentinel is autonomously formulating an updated task plan with adjusted parameters.
                    </p>
                  </div>
                </div>
              )}

              {/* Accepted Banner */}
              {selectedMission.state === 'accepted' && (
                <div className="p-4 bg-blue-950/20 border border-blue-800/40 rounded flex items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <Check className="w-4 h-4 text-status-accepted shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-xs font-semibold text-blue-300 font-sans">
                        Deliverable Accepted — Ready for Safe Integration
                      </h4>
                      <p className="text-xs text-gray-300 mt-0.5 font-sans">
                        Human acceptance recorded. Commit{' '}
                        <code className="font-mono text-blue-300">
                          {selectedMission.latest_verified_commit ? selectedMission.latest_verified_commit.slice(0, 7) : 'HEAD'}
                        </code>{' '}
                        is eligible for target branch integration.
                      </p>
                    </div>
                  </div>
                  <Button
                    variant="primary"
                    size="xs"
                    disabled={actionLoading}
                    onClick={() => handleIntegrate(selectedMission.id)}
                    icon={<GitPullRequest className="w-3.5 h-3.5" />}
                  >
                    Integrate Branch
                  </Button>
                </div>
              )}

              {/* Integrated Banner */}
              {selectedMission.state === 'integrated' && (
                <div className="p-4 bg-emerald-950/20 border border-emerald-800/40 rounded flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <CheckCircle2 className="w-4 h-4 text-status-integrated shrink-0" />
                    <div>
                      <h4 className="text-xs font-semibold text-emerald-300 font-sans">
                        Deliverable Integrated Successfully
                      </h4>
                      <p className="text-xs text-gray-300 font-sans">
                        Verified commit {selectedMission.latest_verified_commit ? selectedMission.latest_verified_commit.slice(0, 7) : 'HEAD'} has been integrated into target branch.
                      </p>
                    </div>
                  </div>
                  <Badge variant="integrated" size="xs">
                    MERGED & ARCHIVED
                  </Badge>
                </div>
              )}

              {/* Rejected Banner */}
              {selectedMission.state === 'rejected' && (
                <div className="p-4 bg-rose-950/20 border border-rose-800/40 rounded flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <XCircle className="w-4 h-4 text-status-rejected shrink-0" />
                    <div>
                      <h4 className="text-xs font-semibold text-rose-300 font-sans">
                        Deliverable Rejected (Non-destructive Audit)
                      </h4>
                      <p className="text-xs text-gray-400 font-sans">
                        Reason: {String((selectedMission as any).metadata?.rejection_reason || 'Rejected by operator')}
                      </p>
                    </div>
                  </div>
                  <Badge variant="rejected" size="xs">
                    REJECTED
                  </Badge>
                </div>
              )}

              {/* Operator Escalation Banner */}
              {selectedMission.state === 'needs_human' && (
                <div className="p-4 bg-amber-950/30 border border-amber-800/50 rounded space-y-2.5">
                  <div className="flex items-start gap-3">
                    <ShieldAlert className="w-4 h-4 text-status-needshuman shrink-0 mt-0.5" />
                    <div>
                      <h4 className="text-xs font-semibold text-amber-300 font-sans">
                        Operator Escalation Triggered
                      </h4>
                      <p className="text-xs text-gray-300 mt-0.5 font-sans">
                        {selectedMission.escalation_reason ||
                          'Mission halted pending operator review or guidance.'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-2 border-t border-amber-900/40">
                    <span className="text-xs font-sans text-gray-400">Operator Decision:</span>
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={actionLoading}
                      onClick={() => handleResolve(selectedMission.id, 'resume')}
                    >
                      Resume
                    </Button>
                    <Button
                      variant="secondary"
                      size="xs"
                      disabled={actionLoading}
                      onClick={() => handleResolve(selectedMission.id, 'replan')}
                    >
                      Replan
                    </Button>
                    <Button
                      variant="danger"
                      size="xs"
                      disabled={actionLoading}
                      onClick={() => handleResolve(selectedMission.id, 'cancel')}
                    >
                      Cancel Mission
                    </Button>
                  </div>
                </div>
              )}

              {/* Manual Escalate Input Bar */}
              {showEscalatePrompt && (
                <div className="p-3.5 bg-surface-base border border-surface-border rounded space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-gray-200 font-sans">
                      Escalate Mission to Operator
                    </span>
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => setShowEscalatePrompt(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      placeholder="Reason for escalation (e.g. clarify specification, API key missing)..."
                      value={escalateReason}
                      onChange={(e) => setEscalateReason(e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={actionLoading || !escalateReason.trim()}
                      onClick={() => handleEscalate(selectedMission.id)}
                    >
                      Confirm
                    </Button>
                  </div>
                </div>
              )}

              {/* Objective & Scope */}
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider font-sans block">
                  Mission Objective & Scope
                </span>
                <p className="text-xs sm:text-sm text-gray-200 bg-surface-card/60 p-3.5 rounded border border-surface-border leading-relaxed font-sans">
                  {selectedMission.objective}
                </p>
              </div>

              {/* Technical Verification & Provenance Cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Stopping Conditions */}
                <Panel
                  title="Stopping Conditions"
                  dense
                >
                  <div className="space-y-2 text-xs py-1">
                    <div className="flex items-center gap-2">
                      {selectedMission.stopping_condition.required_tests_pass ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-status-verified shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-surface-border-bold shrink-0" />
                      )}
                      <span className="text-gray-300 font-sans text-xs">
                        Automated Tests Pass (<code className="font-mono text-[11px] text-gray-300">cargo test = 0</code>)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {selectedMission.stopping_condition.working_tree_clean ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-status-verified shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-surface-border-bold shrink-0" />
                      )}
                      <span className="text-gray-300 font-sans text-xs">
                        Clean Working Tree (<code className="font-mono text-[11px] text-gray-300">git status --porcelain</code>)
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      {selectedMission.stopping_condition.required_commit_exists ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-status-verified shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border border-surface-border-bold shrink-0" />
                      )}
                      <span className="text-gray-300 font-sans text-xs">
                        Valid Git Commit SHA Exists
                      </span>
                    </div>
                  </div>
                </Panel>

                {/* Verified Git Provenance */}
                <Panel
                  title="Verified Git Provenance"
                  dense
                >
                  {selectedMission.latest_verified_commit ? (
                    <div className="space-y-2 py-1">
                      <div className="flex items-center gap-2 text-emerald-400">
                        <GitCommit className="w-4 h-4 shrink-0" />
                        <span className="font-mono text-xs font-bold">
                          {selectedMission.latest_verified_commit}
                        </span>
                        <Badge variant="verified" size="xs">
                          VALIDATED
                        </Badge>
                      </div>
                      <p className="text-xs text-gray-400 font-sans">
                        Commit verified against repository HEAD via isolated execution gate.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500 font-sans py-2">
                      No verified commit produced yet in current cycle.
                    </p>
                  )}
                </Panel>
              </div>

              {/* Resource Budget Meters */}
              <Panel
                title="Resource Budget Consumption"
                dense
              >
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 py-1">
                  {/* Executions */}
                  <div>
                    <div className="flex justify-between text-xs text-gray-400 mb-1 font-sans">
                      <span className="flex items-center gap-1">
                        <Cpu className="w-3 h-3 text-gray-400" /> Runs
                      </span>
                      <span className="font-mono text-[11px]">
                        {selectedMission.budget_consumed.total_executions} /{' '}
                        {selectedMission.budget.max_executions}
                      </span>
                    </div>
                    <div className="w-full bg-surface-base h-1.5 rounded-xs overflow-hidden border border-surface-border">
                      <div
                        className="bg-sentinel-lime h-full"
                        style={{
                          width: `${Math.min(
                            100,
                            (selectedMission.budget_consumed.total_executions /
                              selectedMission.budget.max_executions) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Planner Iterations */}
                  <div>
                    <div className="flex justify-between text-xs text-gray-400 mb-1 font-sans">
                      <span>Planner</span>
                      <span className="font-mono text-[11px]">
                        {selectedMission.budget_consumed.planner_iterations} /{' '}
                        {selectedMission.budget.max_planner_iterations}
                      </span>
                    </div>
                    <div className="w-full bg-surface-base h-1.5 rounded-xs overflow-hidden border border-surface-border">
                      <div
                        className="bg-gray-300 h-full"
                        style={{
                          width: `${Math.min(
                            100,
                            (selectedMission.budget_consumed.planner_iterations /
                              selectedMission.budget.max_planner_iterations) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Stagnant Cycles */}
                  <div>
                    <div className="flex justify-between text-xs text-gray-400 mb-1 font-sans">
                      <span>Stagnation</span>
                      <span
                        className={
                          selectedMission.budget_consumed.stagnant_cycles > 0
                            ? 'text-amber-400 font-bold font-mono text-[11px]'
                            : 'font-mono text-[11px]'
                        }
                      >
                        {selectedMission.budget_consumed.stagnant_cycles} /{' '}
                        {selectedMission.budget.max_stagnant_cycles}
                      </span>
                    </div>
                    <div className="w-full bg-surface-base h-1.5 rounded-xs overflow-hidden border border-surface-border">
                      <div
                        className="bg-amber-400 h-full"
                        style={{
                          width: `${Math.min(
                            100,
                            (selectedMission.budget_consumed.stagnant_cycles /
                              selectedMission.budget.max_stagnant_cycles) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>

                  {/* Duration */}
                  <div>
                    <div className="flex justify-between text-xs text-gray-400 mb-1 font-sans">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3 text-gray-400" /> Duration
                      </span>
                      <span className="font-mono text-[11px]">
                        {selectedMission.budget_consumed.duration_secs}s /{' '}
                        {selectedMission.budget.max_duration_secs}s
                      </span>
                    </div>
                    <div className="w-full bg-surface-base h-1.5 rounded-xs overflow-hidden border border-surface-border">
                      <div
                        className="bg-sky-400 h-full"
                        style={{
                          width: `${Math.min(
                            100,
                            (selectedMission.budget_consumed.duration_secs /
                              selectedMission.budget.max_duration_secs) *
                              100
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>
              </Panel>

              {/* Durable Checkpoints */}
              <Panel
                title={`Durable Checkpoints (${checkpoints.length})`}
                dense
              >
                {checkpoints.length === 0 ? (
                  <p className="text-xs text-gray-500 font-sans italic py-2">
                    No checkpoints recorded yet for this mission.
                  </p>
                ) : (
                  <div className="space-y-1.5 py-1">
                    {checkpoints.map((ckpt) => (
                      <div
                        key={ckpt.id}
                        className="p-2.5 bg-surface-base border border-surface-border rounded flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <span className="font-mono text-sentinel-lime font-bold text-[11px]">
                            Cycle {ckpt.cycle_index}
                          </span>
                          <span className="text-gray-400 font-mono text-[10px]">
                            {ckpt.id}
                          </span>
                          <span className="text-emerald-400 font-mono text-[10px]">
                            ✓ {ckpt.completed_tasks.length} tasks
                          </span>
                          {ckpt.unresolved_tasks.length > 0 && (
                            <span className="text-gray-500 font-mono text-[10px]">
                              ⏳ {ckpt.unresolved_tasks.length} pending
                            </span>
                          )}
                        </div>

                        {ckpt.latest_verified_commit && (
                          <div className="flex items-center gap-1 text-gray-300 font-mono text-[10px]">
                            <GitCommit className="w-3 h-3 text-emerald-400" />
                            <span>{ckpt.latest_verified_commit.slice(0, 7)}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </Panel>

              {/* Execution Cycles History */}
              {cycles.length > 0 && (
                <Panel
                  title={`Execution Cycles History (${cycles.length})`}
                  dense
                >
                  <div className="space-y-1.5 py-1">
                    {cycles.map((c) => (
                      <div
                        key={c.id}
                        className="p-2.5 bg-surface-base border border-surface-border rounded flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-2.5">
                          <span className="font-mono text-sentinel-lime text-[11px]">
                            Cycle {c.cycle_index}
                          </span>
                          <span className="text-gray-200 text-xs font-sans">{c.summary}</span>
                        </div>
                        <span className="text-[10px] font-mono text-gray-400 uppercase">
                          {c.outcome}
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {/* Recent Events Stream */}
              {events.length > 0 && (
                <Panel
                  title={`Recent Mission Events (${events.length})`}
                  dense
                >
                  <div className="max-h-48 overflow-y-auto space-y-1 bg-surface-base p-2 rounded border border-surface-border font-mono text-[10px]">
                    {events.map((ev) => (
                      <div
                        key={ev.sequence}
                        className="flex items-center justify-between text-gray-400 py-0.5 border-b border-surface-border/40 last:border-0"
                      >
                        <span className="text-gray-200 font-semibold">{ev.event_type}</span>
                        <span className="text-gray-500">
                          {ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          ) : (
            <div className="p-12 border border-surface-border rounded text-center text-gray-500 bg-surface-card/40 font-sans text-xs">
              Select a mission from the directory to inspect telemetry and lifecycle state.
            </div>
          )}
        </div>
      </div>

      {/* Launch Mission Modal */}
      <Modal
        isOpen={showNewModal}
        onClose={() => setShowNewModal(false)}
        title={
          <div className="flex items-center gap-2">
            <Target className="w-4 h-4 text-sentinel-lime" />
            <span>Launch Autonomous Mission</span>
          </div>
        }
        subtitle="Configure autonomous goal, duration, and verification conditions"
        maxWidth="lg"
      >
        <form onSubmit={handleCreateMission} className="space-y-4">
          {/* Target Workspace Info */}
          <div className="bg-surface-base p-2.5 rounded border border-surface-border font-mono text-xs">
            <span className="block text-gray-500 text-[10px] uppercase tracking-wider mb-0.5">
              Target Workspace
            </span>
            <div className="text-gray-200 truncate">
              {activeWorkspace
                ? `${activeWorkspace.name} (${activeWorkspace.canonical_path})`
                : 'No workspace selected (Global context)'}
            </div>
          </div>

          {/* Agent Backend Selector */}
          <Select
            label="Agent Backend"
            value={newBackend}
            onChange={(e) => setNewBackend(e.target.value)}
            mono
          >
            <option value="gemini_cli">Google Gemini CLI (Production)</option>
            <option value="fake_agent">Test Agent (Deterministic Mock)</option>
            <option value="echo">Echo Agent (Diagnostics)</option>
          </Select>

          {/* Mission Title */}
          <Input
            label="Mission Title"
            required
            placeholder="e.g. Long-Horizon Authentication Refactor"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
          />

          {/* Objective */}
          <Textarea
            label="High-Level Objective"
            required
            rows={3}
            placeholder="Describe the software engineering goal to sustain autonomously across multiple cycles until verified..."
            value={newObjective}
            onChange={(e) => setNewObjective(e.target.value)}
          />

          {/* Budgets */}
          <div className="grid grid-cols-3 gap-3">
            <Input
              label="Max Duration (s)"
              type="number"
              value={newMaxDuration}
              onChange={(e) => setNewMaxDuration(Number(e.target.value))}
              mono
            />
            <Input
              label="Max Executions"
              type="number"
              value={newMaxExecutions}
              onChange={(e) => setNewMaxExecutions(Number(e.target.value))}
              mono
            />
            <Input
              label="Stagnation Bound"
              type="number"
              value={newMaxStagnant}
              onChange={(e) => setNewMaxStagnant(Number(e.target.value))}
              mono
            />
          </div>

          {/* Stopping Conditions */}
          <div className="space-y-2 pt-2 border-t border-surface-border">
            <span className="block text-gray-400 font-mono text-[11px] uppercase tracking-wider">
              Physical Stopping Conditions
            </span>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newRequireTests}
                onChange={(e) => setNewRequireTests(e.target.checked)}
                className="rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
              />
              <span>Automated test suite passes (`cargo test = 0`)</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newRequireCleanTree}
                onChange={(e) => setNewRequireCleanTree(e.target.checked)}
                className="rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
              />
              <span>Working tree is completely clean</span>
            </label>
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newRequireCommit}
                onChange={(e) => setNewRequireCommit(e.target.checked)}
                className="rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
              />
              <span>Valid Git commit SHA exists at repository HEAD</span>
            </label>
          </div>

          <div className="pt-2 border-t border-surface-border">
            <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer">
              <input
                type="checkbox"
                checked={newAutoStart}
                onChange={(e) => setNewAutoStart(e.target.checked)}
                className="rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
              />
              <span>Auto-start mission immediately upon creation</span>
            </label>
          </div>

          <div className="flex items-center justify-end gap-2 pt-4 border-t border-surface-border">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowNewModal(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              loading={actionLoading}
            >
              Launch Mission
            </Button>
          </div>
        </form>
      </Modal>

      {/* Review Package & Human Acceptance Modal */}
      {showReviewModal && reviewPackage && (
        <Modal
          isOpen={showReviewModal}
          onClose={() => setShowReviewModal(false)}
          title={
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-sentinel-lime" />
              <span>Mission Deliverable Review</span>
              <Badge
                variant={getStateBadgeVariant(reviewPackage.status)}
                size="xs"
              >
                {getStateLabel(reviewPackage.status, reviewPackage.reverification_required)}
              </Badge>
            </div>
          }
          subtitle={`ID: ${reviewPackage.mission_id} · Target: ${reviewPackage.target_branch || 'main'}`}
          maxWidth="4xl"
          footer={
            <div className="w-full flex items-center justify-between gap-2">
              <div>
                {reviewPackage.can_reject && (
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => {
                      setShowReviewModal(false);
                      setShowRejectModal(true);
                    }}
                    disabled={actionLoading}
                    icon={<X className="w-3.5 h-3.5" />}
                  >
                    Reject Deliverable...
                  </Button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowReviewModal(false)}
                >
                  Close
                </Button>
                {reviewPackage.can_integrate && !reviewPackage.can_accept && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleIntegrate(reviewPackage.mission_id)}
                    disabled={actionLoading}
                    icon={<GitPullRequest className="w-3.5 h-3.5" />}
                  >
                    Integrate to {reviewPackage.target_branch}
                  </Button>
                )}
                {reviewPackage.can_accept && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleAccept(reviewPackage.mission_id, false)}
                      disabled={actionLoading}
                    >
                      Accept Only
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => handleAccept(reviewPackage.mission_id, true)}
                      disabled={actionLoading}
                      icon={<Check className="w-3.5 h-3.5" />}
                    >
                      Accept & Integrate
                    </Button>
                  </>
                )}
              </div>
            </div>
          }
        >
          <div className="space-y-4 text-xs font-sans">
            {/* Warnings */}
            {reviewPackage.warnings && reviewPackage.warnings.length > 0 && (
              <div className="p-3 bg-amber-950/20 border border-amber-800/40 rounded space-y-1">
                <div className="flex items-center gap-2 text-status-awaiting font-medium">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Review Warnings</span>
                </div>
                <ul className="list-disc list-inside text-gray-300 text-[11px] space-y-0.5 pl-1">
                  {reviewPackage.warnings.map((w, idx) => (
                    <li key={idx}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {/* Target Branch Moved Alert */}
            {reviewPackage.reverification_required && (
              <div className="p-3 bg-amber-950/30 border border-amber-800/50 rounded flex items-start gap-2.5 text-gray-200">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400 mt-0.5" />
                <div className="text-[11px] leading-relaxed">
                  <strong className="text-amber-300">Target Branch Moved:</strong> Target HEAD has changed since verification (verified:{' '}
                  <code className="font-mono text-amber-300">
                    {reviewPackage.verified_target_head?.slice(0, 8) || 'unknown'}
                  </code>
                  , current:{' '}
                  <code className="font-mono text-amber-300">
                    {reviewPackage.current_target_head?.slice(0, 8) || 'unknown'}
                  </code>
                  ). Re-verification is recommended before integration.
                </div>
              </div>
            )}

            {/* Objective */}
            <div className="bg-surface-base p-3.5 rounded border border-surface-border">
              <span className="text-[10px] font-mono uppercase tracking-wider text-gray-500 block mb-1">
                Mission Objective
              </span>
              <p className="text-gray-200 text-xs sm:text-sm font-medium leading-relaxed">
                {reviewPackage.objective}
              </p>
            </div>

            {/* Verification & Metrics Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="p-3 bg-surface-base rounded border border-surface-border">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">
                  Verification
                </span>
                <div className="flex items-center gap-1.5 font-medium">
                  {reviewPackage.verification.tests_passed &&
                  reviewPackage.verification.tree_clean &&
                  reviewPackage.verification.commit_exists ? (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-status-verified" />
                      <span className="text-emerald-400 font-mono text-[11px]">PASSED</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="w-3.5 h-3.5 text-status-failed" />
                      <span className="text-red-400 font-mono text-[11px]">FAILED</span>
                    </>
                  )}
                </div>
                <span className="text-[10px] text-gray-500 mt-1 block font-mono">
                  Tests: {reviewPackage.verification.tests_passed ? '0 exit code' : 'Failed'}
                </span>
              </div>

              <div className="p-3 bg-surface-base rounded border border-surface-border">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">
                  Deliverable Commit
                </span>
                <div className="font-mono text-gray-200 text-xs truncate">
                  {reviewPackage.final_commit ? reviewPackage.final_commit.slice(0, 8) : 'None'}
                </div>
                <span className="text-[10px] text-gray-500 mt-1 block truncate font-mono">
                  Tree: {reviewPackage.verification.tree_clean ? 'Clean' : 'Dirty'}
                </span>
              </div>

              <div className="p-3 bg-surface-base rounded border border-surface-border">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">
                  Execution Metrics
                </span>
                <div className="text-gray-200 font-mono text-xs">
                  {reviewPackage.total_executions} runs · {reviewPackage.recovery_attempts} recoveries
                </div>
                <span className="text-[10px] text-gray-500 mt-1 block font-mono">
                  Cycles: {reviewPackage.cycles_count}
                </span>
              </div>

              <div className="p-3 bg-surface-base rounded border border-surface-border">
                <span className="text-[10px] font-mono text-gray-500 uppercase tracking-wider block mb-1">
                  Runtime
                </span>
                <div className="text-gray-200 font-mono text-xs">
                  {reviewPackage.duration_secs}s
                </div>
                <span className="text-[10px] text-gray-500 mt-1 block truncate font-mono">
                  Agent: {reviewPackage.agent_used || 'gemini-cli'}
                </span>
              </div>
            </div>

            {/* Changed Files */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-gray-200">
                  Changed Files ({reviewPackage.diff_summary.files_count})
                </span>
                <div className="flex items-center gap-2 font-mono text-[11px]">
                  <span className="text-emerald-400">+{reviewPackage.diff_summary.insertions}</span>
                  <span className="text-red-400">-{reviewPackage.diff_summary.deletions}</span>
                </div>
              </div>
              {reviewPackage.files_changed && reviewPackage.files_changed.length > 0 ? (
                <div className="p-2.5 bg-surface-base rounded border border-surface-border flex flex-wrap gap-1.5">
                  {reviewPackage.files_changed.map((file: string, idx: number) => (
                    <span
                      key={idx}
                      className="px-2 py-0.5 bg-surface-card border border-surface-border rounded text-gray-300 font-mono text-[11px]"
                    >
                      {file}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-xs italic">No changed files detected.</p>
              )}
            </div>

            {/* Unified Git Diff */}
            <div className="space-y-1.5">
              <span className="text-xs font-semibold text-gray-200">Unified Deliverable Diff</span>
              <div className="bg-surface-base p-3 rounded border border-surface-border font-mono text-[11px] text-gray-300 overflow-x-auto max-h-72 whitespace-pre leading-snug">
                {reviewPackage.full_diff || 'No diff output available.'}
              </div>
            </div>

            {/* Audit Trail */}
            {reviewPackage.audit_timeline && reviewPackage.audit_timeline.length > 0 && (
              <div className="space-y-1.5">
                <span className="text-xs font-semibold text-gray-200">Audit Trail (Recent)</span>
                <div className="bg-surface-base p-2 rounded border border-surface-border space-y-1 font-mono text-[10px]">
                  {reviewPackage.audit_timeline.slice(-5).map((evt, idx: number) => (
                    <div key={idx} className="flex items-center justify-between text-gray-400 py-0.5">
                      <div className="flex items-center gap-2 truncate">
                        <span className="text-gray-200 font-semibold">{evt.event_type}</span>
                        <span className="truncate">{evt.summary}</span>
                      </div>
                      <span className="shrink-0 ml-2 text-gray-500">
                        {new Date(evt.timestamp).toLocaleTimeString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </Modal>
      )}

      {/* Reject Modal */}
      {showRejectModal && selectedMission && (
        <Modal
          isOpen={showRejectModal}
          onClose={() => {
            setShowRejectModal(false);
            setRejectReason('');
          }}
          title={
            <div className="flex items-center gap-2 text-rose-400">
              <AlertTriangle className="w-4 h-4" />
              <span>Reject Mission Deliverable</span>
            </div>
          }
          subtitle="Rejecting is non-destructive. Artifacts and logs remain in audit trail."
          maxWidth="md"
          footer={
            <div className="w-full flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setShowRejectModal(false);
                  setRejectReason('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                size="sm"
                disabled={actionLoading || !rejectReason.trim()}
                onClick={() => handleRejectConfirm(selectedMission.id)}
                loading={actionLoading}
              >
                Confirm Rejection
              </Button>
            </div>
          }
        >
          <div className="space-y-4 text-xs font-sans">
            <Textarea
              label="Rejection Reason (required)"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              placeholder="e.g. Solution did not meet architectural invariants..."
              rows={3}
              required
            />
            <label className="flex items-center gap-2 text-gray-300 cursor-pointer pt-1">
              <input
                type="checkbox"
                checked={replanOnReject}
                onChange={(e) => setReplanOnReject(e.target.checked)}
                className="rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
              />
              <span>Continue mission via Replanning with feedback</span>
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
};

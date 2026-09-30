import React, { useEffect, useState } from 'react';
import {
  X,
  CheckCircle2,
  AlertTriangle,
  Clock,
  MessageSquare,
  Shield,
  Bot,
  Terminal,
  RefreshCw,
  UserCheck,
  Cpu,
  GitCommit,
} from 'lucide-react';
import {
  Task,
  ExecutionRecord,
  Verification,
  AgentMessage,
  RecoveryRecord,
  Agent,
} from '../types';
import { api } from '../services/api';
import { TerminalView } from './TerminalView';
import { TaskReviewModal } from './TaskReviewModal';
import { Button, Badge, BadgeVariant, Select } from './ui';

interface TaskDetailDrawerProps {
  taskId: string | null;
  onClose: () => void;
  onSelectTask: (id: string) => void;
  availableAgents: Agent[];
  workspaceId?: string | null;
  onTaskUpdated?: () => void;
}

export const TaskDetailDrawer: React.FC<TaskDetailDrawerProps> = ({
  taskId,
  onClose,
  onSelectTask,
  availableAgents,
  workspaceId,
  onTaskUpdated,
}) => {
  const [dependencies, setDependencies] = useState<{
    task_id: string;
    prerequisites: Task[];
    dependents: Task[];
  } | null>(null);
  const [taskData, setTaskData] = useState<Task | null>(null);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [recoveries, setRecoveries] = useState<RecoveryRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedAgentId, setSelectedAgentId] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'terminal' | 'diagnostics'>('overview');
  const [isReviewModalOpen, setIsReviewModalOpen] = useState(false);

  useEffect(() => {
    if (!taskId) return;
    setLoading(true);

    Promise.all([
      api.getTask(taskId).catch(() => null),
      api.getTaskDependencies(taskId).catch(() => null),
      api.getTaskExecutions(taskId).catch(() => []),
      api.getTaskVerifications(taskId).catch(() => []),
      api.getTaskMessages(taskId).catch(() => []),
      api.getTaskRecoveries(taskId).catch(() => []),
    ]).then(([task, deps, execs, verifs, msgs, recovs]) => {
      setTaskData(task);
      setDependencies(deps);
      setExecutions(execs);
      setVerifications(verifs);
      setMessages(msgs);
      setRecoveries(recovs);
      setLoading(false);
    });
  }, [taskId]);

  if (!taskId) return null;

  const handleReassign = async () => {
    if (!selectedAgentId || !taskId) return;
    setReassigning(true);
    try {
      await api.reassignTask(taskId, selectedAgentId);
      if (onTaskUpdated) onTaskUpdated();
    } catch (e) {
      alert(`Reassign failed: ${e}`);
    } finally {
      setReassigning(false);
    }
  };

  const prereqs = dependencies?.prerequisites || [];
  const dependents = dependencies?.dependents || [];

  const currentTask =
    taskData ||
    prereqs.find((p) => p.id === taskId) ||
    dependents.find((d) => d.id === taskId);

  const latestExecution = executions.length > 0 ? executions[executions.length - 1] : null;
  const taskMetadata = (currentTask?.metadata || {}) as Record<string, any>;
  const execMetadata = (latestExecution?.metadata || {}) as Record<string, any>;

  const currentBackend =
    (taskMetadata.backend as string) ||
    (execMetadata.backend as string) ||
    (execMetadata.backend_id as string) ||
    (currentTask?.assigned_agent_id ? 'Internal Agent' : null);

  const isExternalBackend = Boolean(
    currentBackend &&
      currentBackend !== 'internal' &&
      currentBackend !== 'Internal Agent'
  );

  const currentCommitSha =
    (taskMetadata.commit_sha as string) ||
    (execMetadata.commit_sha as string) ||
    null;

  const currentChangedFiles =
    ((taskMetadata.changed_files as string[]) ||
      (execMetadata.changed_files as string[]) ||
      (execMetadata.modified_files as string[]) ||
      []) as string[];

  // Compute "Why is this task in this state?"
  const computeStateExplanation = () => {
    if (!dependencies && !taskData) return 'Evaluating system state...';
    const unfulfilledPrereqs = prereqs.filter((p) => p.state !== 'Verified');

    if (unfulfilledPrereqs.length > 0) {
      return `Waiting on ${unfulfilledPrereqs.length} prerequisite task(s) to complete verification (${unfulfilledPrereqs
        .map((p) => p.objective)
        .join(', ')}).`;
    }

    if (recoveries.length > 0 && recoveries.some((r) => r.status === 'Active')) {
      return `Under active failure recovery strategy: ${
        recoveries[recoveries.length - 1].strategy
      }.`;
    }

    if (verifications.length > 0) {
      const lastVerif = verifications[verifications.length - 1];
      if (lastVerif.passed) {
        return `Independently verified: "${lastVerif.verdict}". Requirements satisfied.`;
      } else {
        return `Verification failed: "${lastVerif.verdict}". Recovery intervention required.`;
      }
    }

    if (executions.length > 0 && executions.some((e) => !e.finished_at && !e.completed_at)) {
      return `Executing in isolated ${isExternalBackend ? `external process [${currentBackend}]` : 'sandbox'} under active agent lease.`;
    }

    return 'Ready for scheduler dispatch. Prerequisites satisfied.';
  };

  const getStatusVariant = (state: string): BadgeVariant => {
    switch (state?.toLowerCase()) {
      case 'verified':
        return 'verified';
      case 'running':
        return 'running';
      case 'blocked':
        return 'failed';
      default:
        return 'neutral';
    }
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full max-w-xl bg-surface-card border-l border-surface-border shadow-2xl z-50 flex flex-col font-sans">
      {/* Drawer Header */}
      <div className="p-4 border-b border-surface-border flex items-center justify-between bg-surface-header/70">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-sentinel-lime" />
          <h2 className="text-xs sm:text-sm font-semibold text-gray-100 font-mono uppercase tracking-tight">
            Task Inspection & Governance
          </h2>
        </div>
        <div className="flex items-center gap-2">
          {currentTask && (
            <Button
              onClick={() => setIsReviewModalOpen(true)}
              variant="lime-outline"
              size="xs"
            >
              Review Surface
            </Button>
          )}
          <Button
            onClick={onClose}
            variant="ghost"
            size="xs"
            className="p-1 text-gray-400 hover:text-white"
            aria-label="Close task drawer"
          >
            <X className="w-4 h-4" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 px-4 border-b border-surface-border bg-surface-base text-xs font-mono">
        <button
          onClick={() => setActiveTab('overview')}
          className={`px-3 py-2 font-medium border-b-2 transition-colors select-none ${
            activeTab === 'overview'
              ? 'border-sentinel-lime text-gray-100'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          Overview
        </button>
        <button
          onClick={() => setActiveTab('terminal')}
          className={`px-3 py-2 font-medium border-b-2 transition-colors select-none ${
            activeTab === 'terminal'
              ? 'border-sentinel-lime text-gray-100'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          Live Terminal
        </button>
        <button
          onClick={() => setActiveTab('diagnostics')}
          className={`px-3 py-2 font-medium border-b-2 transition-colors select-none ${
            activeTab === 'diagnostics'
              ? 'border-sentinel-lime text-gray-100'
              : 'border-transparent text-gray-400 hover:text-gray-200'
          }`}
        >
          8 Diagnostics
        </button>
      </div>

      {/* Drawer Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <RefreshCw className="w-5 h-5 animate-spin text-sentinel-lime" />
          </div>
        ) : activeTab === 'terminal' ? (
          <div className="h-[520px]">
            <TerminalView taskId={taskId} isTaskActive={currentTask?.state === 'Running'} />
          </div>
        ) : activeTab === 'diagnostics' ? (
          <div className="space-y-3 text-xs font-sans">
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                1. What is this task trying to do?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                {currentTask?.description || currentTask?.objective || taskId}
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                2. Which files will change?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                {currentChangedFiles.length > 0
                  ? `Modified files (${currentChangedFiles.length}): ${currentChangedFiles.join(', ')}`
                  : 'Workspace directory scoped modifications.'}
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                3. What tools or agent backends ran?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                {isExternalBackend
                  ? `Executed via external agent process [${currentBackend}] with sandboxed process-group supervision.`
                  : executions.length > 0
                  ? `${executions.length} internal agent execution attempt(s) recorded with tool invocations.`
                  : 'No tool execution records yet.'}
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                4. Did tests pass, fail, or not run?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                {verifications.length > 0
                  ? `Verifications recorded: ${verifications[0].verdict} (${verifications[0].passed ? 'PASSED' : 'FAILED'})`
                  : 'Awaiting verification pass.'}
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                5. Why is human approval needed?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                {currentTask?.state === 'Blocked'
                  ? 'Task is gated on operator sign-off before proceeding.'
                  : 'Governed by autonomous execution policy.'}
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                6. What command will run if approved?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                Task assignment execution under runtime scheduler lease.
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                7. What changed since the previous attempt?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                {recoveries.length > 0
                  ? `${recoveries.length} recovery attempt(s) performed. Latest strategy: ${recoveries[0].strategy}`
                  : 'Initial execution attempt; no failure mutation applied.'}
              </p>
            </div>
            <div className="p-3 bg-surface-base border border-surface-border rounded">
              <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                8. How does this task fit into the overall plan?
              </span>
              <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                DAG task with priority {currentTask?.priority ?? 1}. Prerequisites: {prereqs.length}, Dependents: {dependents.length}.
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Task Info & Objective */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-mono text-gray-500">ID: {taskId}</div>
                {isExternalBackend ? (
                  <Badge variant="running" size="xs" mono>
                    <Cpu className="w-3 h-3 mr-1" />
                    External [{currentBackend}]
                  </Badge>
                ) : (
                  <Badge variant="neutral" size="xs" mono>
                    <Bot className="w-3 h-3 mr-1" />
                    Internal Agent
                  </Badge>
                )}
              </div>
              <h3 className="text-sm sm:text-base font-semibold text-gray-100 tracking-tight">
                {currentTask?.objective || taskId}
              </h3>
              {currentTask?.description && (
                <p className="text-xs text-gray-400">{currentTask.description}</p>
              )}

              {/* Commit provenance */}
              {currentCommitSha && (
                <div className="flex items-center gap-2 pt-1 flex-wrap">
                  <Badge variant="lime" size="xs" mono>
                    <GitCommit className="w-3 h-3 mr-1" />
                    commit: {currentCommitSha.slice(0, 8)}
                  </Badge>
                  {currentChangedFiles.length > 0 && (
                    <span className="text-[10px] text-gray-400 font-mono">
                      ({currentChangedFiles.length} file{currentChangedFiles.length === 1 ? '' : 's'} modified)
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* State Diagnostic Banner */}
            <div className="p-3 bg-surface-base border border-surface-border rounded space-y-1">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-sentinel-lime" />
                <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wider font-mono">
                  State Diagnostic
                </span>
              </div>
              <p className="text-xs text-gray-300 font-mono leading-relaxed">
                {computeStateExplanation()}
              </p>
            </div>

            {/* Prerequisites & Dependents */}
            <div className="space-y-3">
              <h4 className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 font-mono">
                DAG Dependencies
              </h4>
              <div className="space-y-1.5">
                <div className="text-xs text-gray-400 font-mono text-[11px]">
                  Prerequisites ({prereqs.length}):
                </div>
                {prereqs.length === 0 ? (
                  <div className="text-[11px] font-mono text-gray-500 pl-2">None (Root Task)</div>
                ) : (
                  prereqs.map((p) => (
                    <div
                      key={p.id}
                      onClick={() => onSelectTask(p.id)}
                      className="p-2 bg-surface-base hover:bg-surface-hover border border-surface-border rounded cursor-pointer flex items-center justify-between transition-colors"
                    >
                      <span className="text-xs text-gray-200 truncate max-w-[280px]">
                        {p.objective}
                      </span>
                      <Badge
                        variant={getStatusVariant(p.state)}
                        size="xs"
                        statusDot
                      >
                        {p.state}
                      </Badge>
                    </div>
                  ))
                )}
              </div>

              <div className="space-y-1.5 mt-2">
                <div className="text-xs text-gray-400 font-mono text-[11px]">
                  Dependents ({dependents.length}):
                </div>
                {dependents.length === 0 ? (
                  <div className="text-[11px] font-mono text-gray-500 pl-2">None (Terminal Task)</div>
                ) : (
                  dependents.map((d) => (
                    <div
                      key={d.id}
                      onClick={() => onSelectTask(d.id)}
                      className="p-2 bg-surface-base hover:bg-surface-hover border border-surface-border rounded cursor-pointer flex items-center justify-between transition-colors"
                    >
                      <span className="text-xs text-gray-200 truncate max-w-[280px]">
                        {d.objective}
                      </span>
                      <Badge
                        variant={getStatusVariant(d.state)}
                        size="xs"
                      >
                        {d.state}
                      </Badge>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Agent Allocation */}
            <div className="p-3 bg-surface-base border border-surface-border rounded space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Bot className="w-3.5 h-3.5 text-sentinel-lime" />
                <span className="text-[10px] font-semibold text-gray-300 uppercase tracking-wider font-mono">
                  Agent Allocation
                </span>
              </div>
              <div className="text-xs text-gray-300 font-mono">
                Current Agent:{' '}
                <span className="text-sentinel-lime">
                  {currentTask?.assigned_agent_id || 'Unassigned'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <Select
                  value={selectedAgentId}
                  onChange={(e) => setSelectedAgentId(e.target.value)}
                  className="flex-1"
                  mono
                >
                  <option value="">Select an agent to reassign...</option>
                  {availableAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name} ({a.role} - {a.state})
                    </option>
                  ))}
                </Select>
                <Button
                  disabled={!selectedAgentId || reassigning}
                  onClick={handleReassign}
                  variant="primary"
                  size="sm"
                  loading={reassigning}
                  icon={<UserCheck className="w-3 h-3" />}
                >
                  Reassign
                </Button>
              </div>
            </div>

            {/* Independent Verification Results */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-status-verified" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 font-mono">
                  Independent Verifications ({verifications.length})
                </span>
              </div>
              {verifications.length === 0 ? (
                <div className="p-3 bg-surface-base border border-surface-border rounded text-xs text-gray-500 font-mono">
                  No verifications recorded yet.
                </div>
              ) : (
                verifications.map((v) => (
                  <div
                    key={v.id}
                    className={`p-3 rounded border ${
                      v.passed
                        ? 'bg-emerald-950/20 border-emerald-800/40'
                        : 'bg-rose-950/20 border-rose-800/40'
                    } space-y-2`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        {v.passed ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-status-verified" />
                        ) : (
                          <AlertTriangle className="w-3.5 h-3.5 text-status-failed" />
                        )}
                        <span className="text-xs font-semibold text-gray-200">{v.verdict}</span>
                      </div>
                      <span className="text-[10px] font-mono text-gray-500">
                        {new Date(v.verified_at).toLocaleTimeString()}
                      </span>
                    </div>
                    {v.evidence && (
                      <div className="text-[11px] font-mono bg-surface-base p-2 rounded text-gray-300 overflow-x-auto max-h-36">
                        <pre>{JSON.stringify(v.evidence, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>

            {/* Executions */}
            <div className="space-y-2">
              <div className="flex items-center gap-1.5">
                <Terminal className="w-3.5 h-3.5 text-status-running" />
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 font-mono">
                  Executions & Process Supervision ({executions.length})
                </span>
              </div>
              {executions.length === 0 ? (
                <div className="p-3 bg-surface-base border border-surface-border rounded text-xs text-gray-500 font-mono">
                  No execution records for this task.
                </div>
              ) : (
                executions.map((e) => {
                  const m = (e.metadata || {}) as Record<string, any>;
                  const execBackend = m.backend || m.backend_id;
                  const pid = m.pid;
                  const exitCode = m.exit_code;
                  const duration = m.execution_time_ms;
                  const sha = m.commit_sha;
                  const files = (m.changed_files || m.modified_files || []) as string[];
                  const statusStr = e.state || e.status || 'Unknown';

                  return (
                    <div
                      key={e.id}
                      className="p-3 bg-surface-base border border-surface-border rounded space-y-2"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-gray-300">
                            Attempt #{e.attempt}
                          </span>
                          {execBackend ? (
                            <Badge variant="running" size="xs" mono>
                              External: {execBackend}
                            </Badge>
                          ) : (
                            <Badge variant="neutral" size="xs" mono>
                              Internal Agent
                            </Badge>
                          )}
                        </div>
                        <Badge
                          variant={
                            statusStr.toLowerCase().includes('completed') ||
                            statusStr.toLowerCase().includes('verified')
                              ? 'verified'
                              : statusStr.toLowerCase().includes('failed')
                              ? 'failed'
                              : 'awaiting'
                          }
                          size="xs"
                        >
                          {statusStr}
                        </Badge>
                      </div>

                      {/* Process Diagnostics Metadata */}
                      {(pid !== undefined || exitCode !== undefined || duration !== undefined || e.id) && (
                        <div className="flex flex-wrap items-center gap-3 text-[10px] font-mono text-gray-400 bg-surface-card px-2.5 py-1 rounded border border-surface-border">
                          {e.id && (
                            <span>
                              Exec ID: <strong className="text-gray-200">{e.id.slice(0, 8)}</strong>
                            </span>
                          )}
                          {pid !== undefined && (
                            <span>
                              PID: <strong className="text-gray-200">{pid}</strong>
                            </span>
                          )}
                          {exitCode !== undefined && (
                            <span>
                              Exit Code:{' '}
                              <strong
                                className={exitCode === 0 ? 'text-emerald-400' : 'text-red-400'}
                              >
                                {exitCode}
                              </strong>
                            </span>
                          )}
                          {duration !== undefined && (
                            <span>
                              Duration: <strong className="text-gray-200">{duration}ms</strong>
                            </span>
                          )}
                        </div>
                      )}

                      {/* Commit SHA */}
                      {sha && (
                        <div className="p-2 bg-surface-card border border-surface-border rounded text-xs space-y-1">
                          <div className="flex items-center gap-1.5 text-sentinel-lime font-mono text-[11px]">
                            <GitCommit className="w-3.5 h-3.5" />
                            <span>Git Commit:</span>
                            <span className="font-semibold select-all text-gray-100">{sha}</span>
                          </div>
                          {files.length > 0 && (
                            <div className="text-[10px] font-mono text-gray-400 pt-1">
                              <span className="text-gray-500 block mb-0.5">Modified Files:</span>
                              {files.map((f: string) => (
                                <div key={f} className="text-emerald-400 pl-2">
                                  ✓ {f}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {/* Error banner */}
                      {(e.error || e.error_message) && (
                        <div className="p-2 bg-rose-950/30 border border-rose-800/40 rounded text-xs font-mono text-red-300">
                          {e.error || e.error_message}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Recoveries */}
            {recoveries.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5 text-status-awaiting" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 font-mono">
                    Recovery Diagnostics ({recoveries.length})
                  </span>
                </div>
                {recoveries.map((r) => (
                  <div
                    key={r.id}
                    className="p-3 bg-amber-950/20 border border-amber-800/40 rounded text-xs font-mono space-y-1"
                  >
                    <div className="flex items-center justify-between text-amber-300 font-semibold">
                      <span>Strategy: {r.strategy}</span>
                      <span className="text-[10px] uppercase text-status-awaiting">{r.status}</span>
                    </div>
                    <div className="text-gray-300">{r.diagnostics}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Messages */}
            {messages.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-1.5">
                  <MessageSquare className="w-3.5 h-3.5 text-sentinel-lime" />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-400 font-mono">
                    Task Messages ({messages.length})
                  </span>
                </div>
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className="p-2.5 bg-surface-base rounded border border-surface-border font-mono text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-gray-400 text-[10px]">
                      <span>
                        {m.from_agent} → {m.to_agent}
                      </span>
                      <span>{new Date(m.created_at).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-gray-300">{m.content}</div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {currentTask && (
        <TaskReviewModal
          isOpen={isReviewModalOpen}
          onClose={() => setIsReviewModalOpen(false)}
          task={currentTask}
          workspaceId={workspaceId}
          onTaskUpdated={onTaskUpdated}
        />
      )}
    </div>
  );
};

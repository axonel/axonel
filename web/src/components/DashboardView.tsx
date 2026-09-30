import React from 'react';
import {
  Layers,
  CheckCircle2,
  AlertTriangle,
  Play,
  Clock,
  ShieldAlert,
  ArrowRight,
  RefreshCw,
  Cpu,
  CheckCircle,
} from 'lucide-react';
import { DashboardSummary, Workflow } from '../types';
import { Button, Badge, BadgeVariant, Panel } from './ui';

interface DashboardViewProps {
  summary: DashboardSummary | null;
  loading: boolean;
  onSelectWorkflow: (id: string) => void;
  onOpenApprovals: () => void;
  onOpenNewWorkflow: () => void;
  onRefresh: () => void;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  summary,
  loading,
  onSelectWorkflow,
  onOpenApprovals,
  onOpenNewWorkflow,
  onRefresh,
}) => {
  if (loading && !summary) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-5 h-5 animate-spin text-sentinel-lime" />
          <span className="text-xs font-mono text-gray-400">Loading system state...</span>
        </div>
      </div>
    );
  }

  const s = summary || {
    total_workflows: 0,
    active_workflows: 0,
    running_tasks: 0,
    busy_agents: 0,
    pending_approvals: 0,
    failed_recoveries: 0,
    latest_event_sequence: 0,
    workflows: [],
    active_tasks: [],
    busy_agents_list: [],
    pending_approvals_list: [],
    provider_health: {},
  };

  const getStatusVariant = (state: string): BadgeVariant => {
    switch (state.toLowerCase()) {
      case 'executing':
      case 'running':
        return 'running';
      case 'completed':
      case 'verified':
        return 'verified';
      case 'planned':
        return 'lime';
      case 'failed':
        return 'failed';
      case 'recovering':
      case 'paused':
        return 'awaiting';
      default:
        return 'neutral';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Operational Posture Banner */}
      {s.pending_approvals > 0 ? (
        <div className="bg-amber-950/30 border border-amber-800/50 rounded p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-1.5 bg-amber-950/60 rounded text-amber-400 shrink-0 mt-0.5 border border-amber-700/50">
              <ShieldAlert className="w-4 h-4 animate-pulse" />
            </div>
            <div>
              <h3 className="text-xs sm:text-sm font-semibold text-amber-300 font-sans">
                {s.pending_approvals} Action{s.pending_approvals > 1 ? 's' : ''} Require Operator Approval
              </h3>
              <p className="text-xs text-gray-300 mt-0.5 font-sans">
                Execution is suspended at safety gates until an operator validates parameter boundaries.
              </p>
            </div>
          </div>
          <Button
            onClick={onOpenApprovals}
            variant="primary"
            size="xs"
            icon={<ArrowRight className="w-3.5 h-3.5" />}
          >
            Review Approvals
          </Button>
        </div>
      ) : s.failed_recoveries > 0 ? (
        <div className="bg-red-950/30 border border-red-800/50 rounded p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="p-1.5 bg-red-950/60 rounded text-red-400 shrink-0 mt-0.5 border border-red-700/50">
              <AlertTriangle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs sm:text-sm font-semibold text-red-300 font-sans">
                {s.failed_recoveries} Autonomous Recovery Escalation{s.failed_recoveries > 1 ? 's' : ''}
              </h3>
              <p className="text-xs text-gray-300 mt-0.5 font-sans">
                Autonomous replanning exceeded retry budget. Operator intervention recommended.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-surface-card border border-surface-border rounded px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <CheckCircle className="w-4 h-4 text-status-verified shrink-0" />
            <span className="text-xs font-medium text-gray-200 font-sans">
              System Nominal — All autonomous engines and agents operating within safety bounds.
            </span>
          </div>
          <Badge variant="verified" size="xs">
            Healthy
          </Badge>
        </div>
      )}

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <Panel dense className="bg-surface-card">
          <div className="flex items-center justify-between text-gray-400 mb-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider">Workflows</span>
            <Layers className="w-3.5 h-3.5 text-gray-400" />
          </div>
          <div className="text-xl sm:text-2xl font-bold font-mono text-gray-100">{s.total_workflows}</div>
          <div className="text-[10px] text-gray-500 mt-0.5 font-sans">
            <span className="text-status-running font-semibold font-mono">{s.active_workflows}</span> active
          </div>
        </Panel>

        <Panel dense className={`bg-surface-card ${s.running_tasks > 0 ? 'border-sky-900/60' : ''}`}>
          <div className="flex items-center justify-between text-gray-400 mb-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider">Running Tasks</span>
            <Play className="w-3.5 h-3.5 text-sky-400" />
          </div>
          <div className={`text-xl sm:text-2xl font-bold font-mono ${s.running_tasks > 0 ? 'text-sky-400' : 'text-gray-100'}`}>
            {s.running_tasks}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5 font-sans">parallel leases</div>
        </Panel>

        <Panel dense className={`bg-surface-card ${s.busy_agents > 0 ? 'border-sentinel-lime/40' : ''}`}>
          <div className="flex items-center justify-between text-gray-400 mb-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider">Busy Agents</span>
            <Cpu className="w-3.5 h-3.5 text-sentinel-lime" />
          </div>
          <div className={`text-xl sm:text-2xl font-bold font-mono ${s.busy_agents > 0 ? 'text-sentinel-lime' : 'text-gray-100'}`}>
            {s.busy_agents}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5 font-sans">
            {s.busy_agents_list ? s.busy_agents_list.length : 0} registered
          </div>
        </Panel>

        <Panel dense className={`bg-surface-card ${s.pending_approvals > 0 ? 'border-amber-700/60 bg-amber-950/10' : ''}`}>
          <div className="flex items-center justify-between text-gray-400 mb-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider">Approvals</span>
            <ShieldAlert className={`w-3.5 h-3.5 ${s.pending_approvals > 0 ? 'text-amber-400' : 'text-gray-400'}`} />
          </div>
          <div
            className={`text-xl sm:text-2xl font-bold font-mono ${
              s.pending_approvals > 0 ? 'text-amber-400' : 'text-gray-100'
            }`}
          >
            {s.pending_approvals}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5 font-sans">governance gates</div>
        </Panel>

        <Panel dense className={`bg-surface-card ${s.failed_recoveries > 0 ? 'border-red-800/60 bg-red-950/10' : ''}`}>
          <div className="flex items-center justify-between text-gray-400 mb-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider">Recoveries</span>
            <AlertTriangle className={`w-3.5 h-3.5 ${s.failed_recoveries > 0 ? 'text-red-400' : 'text-gray-400'}`} />
          </div>
          <div
            className={`text-xl sm:text-2xl font-bold font-mono ${
              s.failed_recoveries > 0 ? 'text-red-400' : 'text-gray-100'
            }`}
          >
            {s.failed_recoveries}
          </div>
          <div className="text-[10px] text-gray-500 mt-0.5 font-sans">escalations</div>
        </Panel>

        <Panel dense className="bg-surface-card">
          <div className="flex items-center justify-between text-gray-400 mb-1.5">
            <span className="text-[10px] font-sans font-semibold uppercase tracking-wider">Audit Log</span>
            <Clock className="w-3.5 h-3.5 text-status-verified" />
          </div>
          <div className="text-xl sm:text-2xl font-bold font-mono text-gray-100">{s.latest_event_sequence}</div>
          <div className="text-[10px] text-gray-500 mt-0.5 font-sans">immutable events</div>
        </Panel>
      </div>

      {/* Main Section: Recent Workflows & Active Tasks */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left 2 Cols: Workflows */}
        <div className="lg:col-span-2 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-sentinel-lime" />
              <h2 className="text-xs font-sans uppercase tracking-wider text-gray-300 font-semibold">
                Recent Workflows
              </h2>
            </div>
            <div className="flex items-center gap-2">
              <Button
                onClick={onRefresh}
                variant="outline"
                size="xs"
                title="Refresh dashboard state"
                aria-label="Refresh dashboard state"
                icon={<RefreshCw className="w-3 h-3 text-gray-400" />}
              />
              <Button
                onClick={onOpenNewWorkflow}
                variant="lime-outline"
                size="xs"
              >
                + Plan New
              </Button>
            </div>
          </div>

          <div className="bg-surface-card border border-surface-border rounded overflow-hidden divide-y divide-surface-border">
            {(s.workflows || []).length === 0 ? (
              <div className="p-8 text-center text-gray-500 text-xs font-sans">
                No workflows registered yet.
              </div>
            ) : (
              (s.workflows || []).slice(0, 5).map((w: Workflow) => (
                <div
                  key={w.id}
                  onClick={() => onSelectWorkflow(w.id)}
                  className="p-3.5 hover:bg-surface-hover/50 cursor-pointer transition-colors flex items-center justify-between group"
                >
                  <div className="space-y-1 min-w-0 pr-3">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className="font-semibold text-gray-200 text-xs sm:text-sm truncate font-sans">
                        {w.name}
                      </span>
                      <Badge
                        variant={getStatusVariant(w.state)}
                        size="xs"
                        statusDot
                      >
                        {w.state}
                      </Badge>
                    </div>
                    <p className="text-xs text-gray-400 line-clamp-1 font-sans">{w.description}</p>
                    <div className="text-[10px] font-mono text-gray-500">
                      ID: {w.id.slice(0, 8)}...
                    </div>
                  </div>
                  <div className="flex items-center gap-2 text-gray-500 group-hover:text-sentinel-lime transition-colors shrink-0">
                    <span className="text-[11px] font-mono">
                      {new Date(w.created_at).toLocaleTimeString()}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5" />
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Right 1 Col: Provider Health Matrix & Active Tasks */}
        <div className="space-y-4">
          {/* Provider Health */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-status-verified" />
              <h2 className="text-xs font-sans uppercase tracking-wider text-gray-300 font-semibold">
                Provider Health Matrix
              </h2>
            </div>
            <Panel dense noPadding className="bg-surface-card">
              {Object.keys(s.provider_health || {}).length === 0 ? (
                <div className="p-4 text-xs text-gray-500 font-sans">No providers registered yet</div>
              ) : (
                <div className="divide-y divide-surface-border">
                  {Object.entries(s.provider_health).map(([name, info]) => (
                    <div
                      key={name}
                      className="p-2.5 flex items-center justify-between text-xs"
                    >
                      <div>
                        <div className="font-semibold text-gray-200 text-xs font-sans">{name}</div>
                        <div className="text-[10px] font-mono text-gray-400">{info.provider_type}</div>
                      </div>
                      <div className="text-right">
                        <Badge
                          variant={info.status === 'healthy' ? 'verified' : 'failed'}
                          size="xs"
                        >
                          {info.status}
                        </Badge>
                        {info.latency_ms !== undefined && (
                          <div className="text-[10px] font-mono text-gray-500 mt-0.5">
                            {info.latency_ms}ms
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>

          {/* Active Tasks & Parallel Leases */}
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Play className="w-4 h-4 text-status-running" />
              <h2 className="text-xs font-sans uppercase tracking-wider text-gray-300 font-semibold">
                Active Tasks ({(s.active_tasks || []).length})
              </h2>
            </div>
            <Panel dense noPadding className="bg-surface-card max-h-60 overflow-y-auto">
              {(s.active_tasks || []).length === 0 ? (
                <div className="p-4 text-xs text-gray-500 font-sans text-center">
                  No active tasks executing
                </div>
              ) : (
                <div className="divide-y divide-surface-border">
                  {(s.active_tasks || []).map((task) => (
                    <div
                      key={task.id}
                      onClick={() => onSelectWorkflow(task.workflow_id)}
                      className="p-2.5 hover:bg-surface-hover/50 cursor-pointer transition-colors"
                    >
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="text-xs font-medium text-gray-200 truncate max-w-[180px] font-sans">
                          {task.objective}
                        </span>
                        <Badge
                          variant={getStatusVariant(task.state)}
                          size="xs"
                          statusDot
                        >
                          {task.state}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between text-[10px] font-mono text-gray-400">
                        <span>
                          Agent:{' '}
                          {task.assigned_agent_id ? task.assigned_agent_id.slice(0, 8) : 'Unassigned'}
                        </span>
                        <span>Pri: {task.priority}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </div>
      </div>
    </div>
  );
};

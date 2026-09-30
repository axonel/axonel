import React, { useEffect, useState } from 'react';
import {
  Workflow,
  WorkflowGraph,
  Task,
  AgentMessage,
  RecoveryRecord,
  Verification,
  Agent,
} from '../types';
import { api } from '../services/api';
import { TaskGraphView } from './TaskGraphView';
import { TaskDetailDrawer } from './TaskDetailDrawer';
import { DiffViewer } from './DiffViewer';
import {
  Play,
  Pause,
  RotateCcw,
  Ban,
  ArrowLeft,
  Share2,
  List,
  MessageSquare,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  GitPullRequest,
  ArrowRight,
} from 'lucide-react';
import { GitDiffResponse } from '../types';
import { Button, Badge, BadgeVariant, Panel, Table, Thead, Tbody, Tr, Th, Td } from './ui';

interface WorkflowDetailViewProps {
  workflowId: string;
  onBack: () => void;
  availableAgents: Agent[];
  workspaceId?: string | null;
}

type WorkflowSubTab = 'graph' | 'tasks' | 'diff' | 'messages' | 'recoveries' | 'verifications';

export const WorkflowDetailView: React.FC<WorkflowDetailViewProps> = ({
  workflowId,
  onBack,
  availableAgents,
  workspaceId,
}) => {
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [recoveries, setRecoveries] = useState<RecoveryRecord[]>([]);
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [activeSubTab, setActiveSubTab] = useState<WorkflowSubTab>('graph');
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [diffData, setDiffData] = useState<GitDiffResponse | null>(null);
  const [loadingDiff, setLoadingDiff] = useState(false);

  const effectiveWorkspaceId = workflow?.workspace_id || workspaceId;

  const loadDiff = async () => {
    if (!effectiveWorkspaceId) return;
    setLoadingDiff(true);
    try {
      const d = await api.getGitDiff(effectiveWorkspaceId);
      setDiffData(d);
    } catch (err) {
      console.error('Failed to load git diff:', err);
    } finally {
      setLoadingDiff(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'diff') {
      loadDiff();
    }
  }, [activeSubTab, effectiveWorkspaceId]);

  const handleCommit = async (message: string) => {
    if (!effectiveWorkspaceId) return;
    await api.commitGit(effectiveWorkspaceId, message);
    await loadDiff();
  };

  const loadData = async () => {
    try {
      const [w, g, t, m, r, v] = await Promise.all([
        api.getWorkflow(workflowId),
        api.getWorkflowGraph(workflowId),
        api.getWorkflowTasks(workflowId),
        api.getWorkflowMessages(workflowId).catch(() => []),
        api.getWorkflowRecoveries(workflowId).catch(() => []),
        api.getWorkflowVerifications(workflowId).catch(() => []),
      ]);
      setWorkflow(w);
      setGraph(g);
      setTasks(t);
      setMessages(m);
      setRecoveries(r);
      setVerifications(v);
    } catch (err) {
      console.error('Failed to load workflow detail:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 3000);
    return () => clearInterval(interval);
  }, [workflowId]);

  const handlePlan = async () => {
    setActionLoading(true);
    try {
      await api.planWorkflow(workflowId);
      await loadData();
    } catch (e) {
      alert(`Planning failed: ${e}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleStart = async () => {
    setActionLoading(true);
    try {
      await api.startWorkflow(workflowId);
      await loadData();
    } catch (e) {
      alert(`Start failed: ${e}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handlePause = async () => {
    setActionLoading(true);
    try {
      await api.pauseWorkflow(workflowId);
      await loadData();
    } catch (e) {
      alert(`Pause failed: ${e}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleResume = async () => {
    setActionLoading(true);
    try {
      await api.resumeWorkflow(workflowId);
      await loadData();
    } catch (e) {
      alert(`Resume failed: ${e}`);
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!confirm('Are you sure you want to cancel this workflow?')) return;
    setActionLoading(true);
    try {
      await api.cancelWorkflow(workflowId);
      await loadData();
    } catch (e) {
      alert(`Cancel failed: ${e}`);
    } finally {
      setActionLoading(false);
    }
  };

  if (loading && !workflow) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="flex flex-col items-center gap-3">
          <RefreshCw className="w-5 h-5 animate-spin text-sentinel-lime" />
          <span className="text-xs font-mono text-gray-400">Loading workflow state...</span>
        </div>
      </div>
    );
  }

  if (!workflow) {
    return (
      <div className="p-8 text-center bg-surface-card border border-surface-border rounded">
        <p className="text-xs text-gray-400">Workflow not found.</p>
        <Button onClick={onBack} variant="outline" size="sm" className="mt-4">
          Back to Workflows
        </Button>
      </div>
    );
  }

  const getStatusVariant = (state: string): BadgeVariant => {
    switch (state.toLowerCase()) {
      case 'executing':
      case 'running':
        return 'running';
      case 'completed':
        return 'verified';
      case 'planned':
        return 'lime';
      case 'paused':
        return 'awaiting';
      case 'failed':
        return 'failed';
      default:
        return 'neutral';
    }
  };

  const subTabs = [
    { id: 'graph', label: 'Interactive DAG', icon: <Share2 className="w-3.5 h-3.5" /> },
    { id: 'tasks', label: `Tasks (${tasks.length})`, icon: <List className="w-3.5 h-3.5" /> },
    { id: 'diff', label: 'Workspace Diff', icon: <GitPullRequest className="w-3.5 h-3.5" /> },
    { id: 'messages', label: `Messages (${messages.length})`, icon: <MessageSquare className="w-3.5 h-3.5" /> },
    { id: 'verifications', label: `Verifications (${verifications.length})`, icon: <ShieldCheck className="w-3.5 h-3.5" /> },
    { id: 'recoveries', label: `Recoveries (${recoveries.length})`, icon: <AlertTriangle className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="space-y-5 pb-12">
      {/* Workflow Header Panel */}
      <Panel noPadding>
        <div className="p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <Button
                onClick={onBack}
                variant="ghost"
                size="xs"
                className="p-1 text-gray-400 hover:text-white"
                title="Back to workflows"
              >
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight truncate">
                {workflow.name || workflow.title}
              </h1>
              <Badge
                variant={getStatusVariant(workflow.state)}
                size="xs"
                statusDot
                pulse={workflow.state.toLowerCase() === 'executing'}
              >
                {workflow.state}
              </Badge>
            </div>
            <p className="text-xs text-gray-300 ml-6 line-clamp-2">
              {workflow.description || workflow.objective}
            </p>
            <div className="text-[11px] font-mono text-gray-500 ml-6 flex items-center gap-2">
              <span>ID: {workflow.id}</span>
              <span>•</span>
              <span>Created: {new Date(workflow.created_at).toLocaleString()}</span>
            </div>
          </div>

          {/* Action Toolbar */}
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            {workflow.state === 'Draft' && (
              <Button
                disabled={actionLoading}
                onClick={handlePlan}
                variant="secondary"
                size="xs"
                icon={<GitPullRequest className="w-3.5 h-3.5 text-sentinel-lime" />}
              >
                Autonomous Plan
              </Button>
            )}

            {(workflow.state === 'Planned' || workflow.state === 'Draft') && (
              <Button
                disabled={actionLoading}
                onClick={handleStart}
                variant="primary"
                size="xs"
                icon={<Play className="w-3.5 h-3.5" />}
              >
                Start Execution
              </Button>
            )}

            {workflow.state === 'Executing' && (
              <Button
                disabled={actionLoading}
                onClick={handlePause}
                variant="secondary"
                size="xs"
                icon={<Pause className="w-3.5 h-3.5 text-amber-400" />}
              >
                Pause
              </Button>
            )}

            {workflow.state === 'Paused' && (
              <Button
                disabled={actionLoading}
                onClick={handleResume}
                variant="secondary"
                size="xs"
                icon={<Play className="w-3.5 h-3.5 text-emerald-400" />}
              >
                Resume
              </Button>
            )}

            {workflow.state !== 'Completed' && workflow.state !== 'Cancelled' && (
              <Button
                disabled={actionLoading}
                onClick={handleCancel}
                variant="danger-ghost"
                size="xs"
                icon={<Ban className="w-3.5 h-3.5" />}
              >
                Cancel
              </Button>
            )}

            <Button
              onClick={loadData}
              variant="outline"
              size="xs"
              title="Refresh workflow data"
              className="px-2"
            >
              <RotateCcw className="w-3.5 h-3.5 text-gray-400" />
            </Button>
          </div>
        </div>

        {/* Sub Navigation Bar */}
        <div className="flex items-center gap-1 px-4 border-t border-surface-border bg-surface-header/40 overflow-x-auto">
          {subTabs.map((tab) => {
            const isActive = activeSubTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveSubTab(tab.id as WorkflowSubTab)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium border-b-2 transition-colors whitespace-nowrap select-none ${
                  isActive
                    ? 'border-sentinel-lime text-gray-100'
                    : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-surface-hover/30'
                }`}
              >
                <span className={isActive ? 'text-sentinel-lime' : 'text-gray-400'}>
                  {tab.icon}
                </span>
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>
      </Panel>

      {/* Main SubTab Content */}
      <div>
        {activeSubTab === 'graph' && (
          <div>
            {graph ? (
              <TaskGraphView
                graph={graph}
                selectedTaskId={selectedTaskId}
                onSelectTask={(id) => setSelectedTaskId(id)}
              />
            ) : (
              <div className="p-8 text-center text-gray-500 font-mono text-xs bg-surface-card border border-surface-border rounded">
                No graph data available.
              </div>
            )}
          </div>
        )}

        {activeSubTab === 'tasks' && (
          <Panel noPadding>
            {tasks.length === 0 ? (
              <div className="p-8 text-center text-gray-500 font-mono text-xs">
                No tasks created for this workflow.
              </div>
            ) : (
              <Table>
                <Thead>
                  <tr>
                    <Th>Task Objective</Th>
                    <Th>State</Th>
                    <Th>Priority</Th>
                    <Th>Assigned Agent</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </Thead>
                <Tbody>
                  {tasks.map((task) => (
                    <Tr
                      key={task.id}
                      isInteractive
                      onClick={() => setSelectedTaskId(task.id)}
                    >
                      <Td className="max-w-xs">
                        <div className="font-medium text-gray-200 truncate">{task.objective}</div>
                        <div className="text-[10px] font-mono text-gray-500 truncate">{task.id}</div>
                      </Td>
                      <Td>
                        <Badge
                          variant={getStatusVariant(task.state)}
                          size="xs"
                          statusDot
                        >
                          {task.state}
                        </Badge>
                      </Td>
                      <Td mono>P{task.priority}</Td>
                      <Td mono className="text-gray-400 truncate max-w-[120px]">
                        {task.assigned_agent_id ? task.assigned_agent_id.slice(0, 12) : 'Unassigned'}
                      </Td>
                      <Td className="text-right">
                        <span className="text-sentinel-lime font-mono text-[11px] inline-flex items-center gap-1">
                          Inspect <ArrowRight className="w-3 h-3" />
                        </span>
                      </Td>
                    </Tr>
                  ))}
                </Tbody>
              </Table>
            )}
          </Panel>
        )}

        {activeSubTab === 'diff' && (
          <div>
            {effectiveWorkspaceId ? (
              <DiffViewer
                diff={diffData}
                loading={loadingDiff}
                onRefresh={loadDiff}
                onCommit={handleCommit}
              />
            ) : (
              <div className="bg-surface-card border border-surface-border rounded p-8 text-center text-gray-400 font-mono text-xs">
                No workspace bound to this workflow to inspect git diff.
              </div>
            )}
          </div>
        )}

        {activeSubTab === 'messages' && (
          <Panel
            title="Inter-Agent Communication Stream"
            dense
          >
            {messages.length === 0 ? (
              <div className="p-8 text-center text-gray-500 font-mono text-xs">
                No inter-agent messages recorded for this workflow yet.
              </div>
            ) : (
              <div className="space-y-2 py-1">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className="p-3 bg-surface-base border border-surface-border rounded space-y-1.5"
                  >
                    <div className="flex items-center justify-between text-xs">
                      <div className="flex items-center gap-2 font-mono">
                        <span className="text-sentinel-lime font-semibold">{m.from_agent.slice(0, 8)}</span>
                        <span className="text-gray-500">→</span>
                        <span className="text-sky-400 font-semibold">{m.to_agent.slice(0, 8)}</span>
                        <span className="text-[10px] text-gray-400 px-1.5 py-0.2 bg-surface-card border border-surface-border rounded">
                          {m.message_type}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-gray-500">
                        {new Date(m.created_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <p className="text-xs text-gray-300 whitespace-pre-wrap font-mono leading-relaxed">
                      {m.content}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {activeSubTab === 'verifications' && (
          <Panel noPadding>
            {verifications.length === 0 ? (
              <div className="p-8 text-center text-gray-500 font-mono text-xs">
                No independent verifications recorded yet.
              </div>
            ) : (
              <div className="divide-y divide-surface-border">
                {verifications.map((v) => (
                  <div key={v.id} className="p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={v.passed ? 'verified' : 'failed'}
                          size="xs"
                        >
                          {v.passed ? 'PASSED' : 'FAILED'}
                        </Badge>
                        <span className="text-xs font-semibold text-gray-200">{v.verdict}</span>
                      </div>
                      <span className="text-xs font-mono text-gray-500">
                        Task: {v.task_id.slice(0, 8)} • {new Date(v.verified_at).toLocaleTimeString()}
                      </span>
                    </div>
                    {v.evidence && (
                      <div className="bg-surface-base p-2.5 rounded border border-surface-border font-mono text-xs text-gray-300 overflow-x-auto">
                        <pre>{JSON.stringify(v.evidence, null, 2)}</pre>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}

        {activeSubTab === 'recoveries' && (
          <Panel
            title="Recovery Diagnostic Records"
            dense
          >
            {recoveries.length === 0 ? (
              <div className="p-8 text-center text-gray-500 font-mono text-xs">
                No recovery attempts logged for this workflow. Execution nominal.
              </div>
            ) : (
              <div className="space-y-2 py-1">
                {recoveries.map((r) => (
                  <div
                    key={r.id}
                    className="p-3 bg-amber-950/20 border border-amber-800/40 rounded font-mono text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between text-amber-300 font-semibold">
                      <span>
                        Attempt #{r.attempt_number} • Strategy: {r.strategy}
                      </span>
                      <span className="text-[10px] uppercase text-status-awaiting">{r.status}</span>
                    </div>
                    <div className="text-gray-300">{r.diagnostics}</div>
                    <div className="text-[10px] text-gray-500">
                      Logged: {new Date(r.created_at).toLocaleString()}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        )}
      </div>

      {/* Slide-out Task Detail Drawer */}
      <TaskDetailDrawer
        taskId={selectedTaskId}
        onClose={() => setSelectedTaskId(null)}
        onSelectTask={(id) => setSelectedTaskId(id)}
        availableAgents={availableAgents}
        onTaskUpdated={loadData}
        workspaceId={effectiveWorkspaceId}
      />
    </div>
  );
};

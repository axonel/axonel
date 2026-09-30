import React, { useState, useEffect } from 'react';
import { Task, Verification, GitDiffResponse, ApprovalRecord } from '../types';
import { api } from '../services/api';
import { DiffViewer } from './DiffViewer';
import { TerminalView } from './TerminalView';
import { FileText, Terminal, ShieldCheck, HelpCircle, Check, X } from 'lucide-react';
import { Modal, Button, Badge, Input } from './ui';

interface TaskReviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  task: Task;
  workspaceId?: string | null;
  onTaskUpdated?: () => void;
}

export const TaskReviewModal: React.FC<TaskReviewModalProps> = ({
  isOpen,
  onClose,
  task,
  workspaceId,
  onTaskUpdated,
}) => {
  const [activeTab, setActiveTab] = useState<'diff' | 'terminal' | 'verification' | 'diagnostics'>('diff');
  const [verifications, setVerifications] = useState<Verification[]>([]);
  const [diffData, setDiffData] = useState<GitDiffResponse | null>(null);
  const [loadingDiff, setLoadingDiff] = useState<boolean>(false);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [deciding, setDeciding] = useState<boolean>(false);
  const [reviewNotes, setReviewNotes] = useState<string>('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen && task) {
      loadDetails();
    }
  }, [isOpen, task?.id, workspaceId]);

  const loadDetails = async () => {
    try {
      // 1. Load verifications
      const verList = await api.getTaskVerifications(task.id);
      setVerifications(verList);

      // 2. Load approvals for this task
      const allApprovals = await api.listApprovals('all');
      const taskApprovals = allApprovals.filter((a) => a.task_id === task.id);
      setApprovals(taskApprovals);

      // 3. Load git diff if workspace available
      if (workspaceId) {
        setLoadingDiff(true);
        const diff = await api.getWorkspaceGitDiff(workspaceId);
        setDiffData(diff);
      }
    } catch (err: any) {
      console.error('Error loading task review details:', err);
    } finally {
      setLoadingDiff(false);
    }
  };

  const pendingApproval = approvals.find((a) => a.state === 'pending');

  const handleApprove = async () => {
    try {
      setDeciding(true);
      setStatusMessage(null);
      if (pendingApproval) {
        await api.approve(pendingApproval.id, reviewNotes || 'Approved via unified task review');
      }
      setStatusMessage('Task sign-off recorded successfully.');
      if (onTaskUpdated) onTaskUpdated();
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message || 'Approval failed'}`);
    } finally {
      setDeciding(false);
    }
  };

  const handleReject = async () => {
    try {
      setDeciding(true);
      setStatusMessage(null);
      if (pendingApproval) {
        await api.reject(pendingApproval.id, reviewNotes || 'Rejected during review');
      }
      setStatusMessage('Rejection recorded.');
      if (onTaskUpdated) onTaskUpdated();
      setTimeout(() => {
        onClose();
      }, 1000);
    } catch (err: any) {
      setStatusMessage(`Error: ${err.message || 'Rejection failed'}`);
    } finally {
      setDeciding(false);
    }
  };

  if (!isOpen) return null;

  const latestVerification = verifications[0];

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-sentinel-lime" />
          <span className="truncate">{task.objective}</span>
          <Badge variant="neutral" size="xs">
            {task.state}
          </Badge>
        </div>
      }
      subtitle={`Task ID: ${task.id}`}
      maxWidth="6xl"
      footer={
        <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-3">
          <div className="flex-1 w-full sm:max-w-md">
            <Input
              placeholder="Optional sign-off feedback / review notes"
              value={reviewNotes}
              onChange={(e) => setReviewNotes(e.target.value)}
            />
          </div>

          <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
            {statusMessage && (
              <span className="text-xs text-gray-300 font-mono mr-2">{statusMessage}</span>
            )}

            {pendingApproval ? (
              <>
                <Button
                  onClick={handleReject}
                  disabled={deciding}
                  variant="danger"
                  size="sm"
                  icon={<X className="w-3.5 h-3.5" />}
                >
                  Reject Action
                </Button>
                <Button
                  onClick={handleApprove}
                  disabled={deciding}
                  variant="primary"
                  size="sm"
                  loading={deciding}
                  icon={<Check className="w-3.5 h-3.5" />}
                >
                  Approve & Unblock
                </Button>
              </>
            ) : (
              <Button
                onClick={onClose}
                variant="outline"
                size="sm"
              >
                Close Review
              </Button>
            )}
          </div>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 border-b border-surface-border -mt-2 pb-2 text-xs font-mono">
          <button
            onClick={() => setActiveTab('diff')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 select-none ${
              activeTab === 'diff'
                ? 'bg-surface-base text-sentinel-lime border border-surface-border-bold font-semibold'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            <span>Code Diff</span>
            {diffData && (
              <span className="px-1.5 py-0.2 bg-surface-card text-gray-300 rounded text-[10px]">
                {diffData.files_changed.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('terminal')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 select-none ${
              activeTab === 'terminal'
                ? 'bg-surface-base text-sentinel-lime border border-surface-border-bold font-semibold'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" />
            <span>Terminal Output</span>
          </button>

          <button
            onClick={() => setActiveTab('verification')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 select-none ${
              activeTab === 'verification'
                ? 'bg-surface-base text-sentinel-lime border border-surface-border-bold font-semibold'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Verification</span>
            {latestVerification && (
              <Badge
                variant={latestVerification.passed ? 'verified' : 'failed'}
                size="xs"
              >
                {latestVerification.passed ? 'Passed' : 'Failed'}
              </Badge>
            )}
          </button>

          <button
            onClick={() => setActiveTab('diagnostics')}
            className={`px-3 py-1.5 rounded transition-colors flex items-center gap-1.5 select-none ${
              activeTab === 'diagnostics'
                ? 'bg-surface-base text-sentinel-lime border border-surface-border-bold font-semibold'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
            }`}
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>8 Diagnostics</span>
          </button>
        </div>

        {/* Tab Content Body */}
        <div className="space-y-4">
          {activeTab === 'diff' && (
            <div className="h-[450px]">
              <DiffViewer
                diffData={diffData}
                loading={loadingDiff}
                onRefresh={loadDetails}
              />
            </div>
          )}

          {activeTab === 'terminal' && (
            <div className="h-[450px]">
              <TerminalView taskId={task.id} isTaskActive={task.state === 'Running'} />
            </div>
          )}

          {activeTab === 'verification' && (
            <div className="space-y-4 max-w-3xl text-xs">
              {/* Acceptance Criteria */}
              <div className="bg-surface-base border border-surface-border rounded p-4 space-y-2.5">
                <h3 className="text-xs font-semibold text-gray-200 font-mono uppercase tracking-wider flex items-center gap-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-sentinel-lime" />
                  <span>Acceptance Criteria</span>
                </h3>
                {task.required_capabilities && task.required_capabilities.length > 0 ? (
                  <div className="space-y-1.5">
                    {task.required_capabilities.map((cap, idx) => (
                      <div
                        key={idx}
                        className="flex items-center gap-2 text-xs text-gray-300 bg-surface-card p-2 rounded border border-surface-border"
                      >
                        <span className="w-3.5 h-3.5 rounded bg-emerald-950 text-emerald-400 flex items-center justify-center font-bold text-[10px]">
                          ✓
                        </span>
                        <span className="font-mono text-[11px]">{cap}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-xs text-gray-500 font-mono">No explicit capability criteria listed.</p>
                )}
              </div>

              {/* Independent Verifications History */}
              <div className="bg-surface-base border border-surface-border rounded p-4 space-y-2.5">
                <h3 className="text-xs font-semibold text-gray-200 font-mono uppercase tracking-wider flex items-center gap-2">
                  <ShieldCheck className="w-3.5 h-3.5 text-sentinel-lime" />
                  <span>Verification Evidence & Sign-Off</span>
                </h3>
                {verifications.length === 0 ? (
                  <p className="text-xs text-gray-500 font-mono">No independent verifications recorded yet.</p>
                ) : (
                  <div className="space-y-2.5">
                    {verifications.map((v) => (
                      <div
                        key={v.id}
                        className="p-3 bg-surface-card border border-surface-border rounded text-xs space-y-2"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-gray-200 font-mono text-[11px]">{v.verdict}</span>
                          <Badge
                            variant={v.passed ? 'verified' : 'failed'}
                            size="xs"
                          >
                            {v.passed ? 'PASS' : 'FAIL'}
                          </Badge>
                        </div>
                        <pre className="p-2 bg-surface-base rounded text-[11px] font-mono text-gray-300 overflow-x-auto border border-surface-border">
                          {JSON.stringify(v.evidence, null, 2)}
                        </pre>
                        <div className="text-[10px] text-gray-500 font-mono">
                          Verified at: {new Date(v.verified_at).toLocaleString()}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'diagnostics' && (
            <div className="space-y-3 max-w-4xl text-xs font-sans">
              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  1. What is this task trying to do?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">{task.description || task.objective}</p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  2. Which files will change?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  {diffData && diffData.files_changed.length > 0
                    ? diffData.files_changed.join(', ')
                    : 'No workspace files modified yet.'}
                </p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  3. What tools ran, with what arguments?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  Inspected via durable tool audit trail: file system modifications, sandbox boundaries, and tests.
                </p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  4. Did tests pass, fail, or not run?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  {latestVerification
                    ? `Independent verifier verdict: ${latestVerification.verdict} (${latestVerification.passed ? 'PASSED' : 'FAILED'})`
                    : 'Awaiting independent verification gate.'}
                </p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  5. Why is human approval needed?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  {pendingApproval
                    ? `Gate requested: ${pendingApproval.action_description} (state: ${pendingApproval.state}). Reason: ${pendingApproval.reason || 'Governance policy enforcement.'}`
                    : 'Governed by workspace confinement policy and sensitive action safety gates.'}
                </p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  6. What command will run if approved?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  {pendingApproval
                    ? pendingApproval.action_description
                    : 'Deterministic scheduler execution tick upon lease acquisition.'}
                </p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  7. What changed since the previous attempt?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  State mutation records and recovery strategy adjustments are tracked monotonically.
                </p>
              </div>

              <div className="p-3.5 bg-surface-base border border-surface-border rounded">
                <span className="font-semibold text-sentinel-lime block mb-1 font-mono text-[11px]">
                  8. How does this task fit into the overall plan?
                </span>
                <p className="text-gray-300 leading-relaxed font-mono text-[11px]">
                  Assigned priority {task.priority} within workflow {task.workflow_id}.
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};

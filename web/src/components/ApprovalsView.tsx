import React, { useState } from 'react';
import { ApprovalRecord } from '../types';
import { api } from '../services/api';
import {
  ShieldAlert,
  ShieldCheck,
  CheckCircle,
  XCircle,
  Clock,
  ExternalLink,
  RefreshCw,
} from 'lucide-react';
import { Button, Badge, BadgeVariant, Panel, Input } from './ui';

interface ApprovalsViewProps {
  approvals: ApprovalRecord[];
  loading: boolean;
  onRefresh: () => void;
  onSelectWorkflow: (id: string) => void;
}

export const ApprovalsView: React.FC<ApprovalsViewProps> = ({
  approvals,
  loading,
  onRefresh,
  onSelectWorkflow,
}) => {
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>('pending');
  const [activeActionId, setActiveActionId] = useState<string | null>(null);
  const [decisionNotes, setDecisionNotes] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const getApprovalStatus = (a: ApprovalRecord): string => {
    const s = a.status || (a as unknown as { state?: string }).state || 'pending';
    return s.toLowerCase();
  };

  const getActionName = (a: ApprovalRecord): string => {
    return a.action_name || (a as unknown as { action_description?: string }).action_description || 'Authorized Action';
  };

  const getRiskLevel = (a: ApprovalRecord): string => {
    return a.risk_level || 'High';
  };

  const getRequestedTime = (a: ApprovalRecord): string => {
    return a.requested_at || (a as unknown as { created_at?: string }).created_at || new Date().toISOString();
  };

  const filtered = approvals.filter((a) => {
    if (filter === 'all') return true;
    return getApprovalStatus(a) === filter.toLowerCase();
  });

  const handleApprove = async (id: string) => {
    setIsSubmitting(true);
    try {
      await api.approve(id, decisionNotes || undefined);
      setActiveActionId(null);
      setDecisionNotes('');
      onRefresh();
    } catch (e) {
      alert(`Approval failed: ${e}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleReject = async (id: string) => {
    setIsSubmitting(true);
    try {
      await api.reject(id, decisionNotes || 'Rejected by operator');
      setActiveActionId(null);
      setDecisionNotes('');
      onRefresh();
    } catch (e) {
      alert(`Rejection failed: ${e}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const getRiskVariant = (risk: string): BadgeVariant => {
    switch (risk.toLowerCase()) {
      case 'critical':
      case 'high':
        return 'failed';
      case 'medium':
        return 'awaiting';
      default:
        return 'running';
    }
  };

  const pendingCount = approvals.filter((a) => getApprovalStatus(a) === 'pending').length;

  return (
    <div className="space-y-5 pb-12">
      {/* Top Banner & Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-status-needshuman" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-sans">
              Human Governance & Approvals
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 font-sans">
            Operator review and policy gating for high-risk autonomous operations
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={onRefresh}
            variant="outline"
            size="sm"
            title="Refresh Approvals"
            aria-label="Refresh Approvals"
            loading={loading}
            icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
          >
            <span>Refresh</span>
          </Button>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1 border-b border-surface-border pb-2.5">
        {(['pending', 'approved', 'rejected', 'all'] as const).map((tab) => (
          <button
            key={tab}
            onClick={() => setFilter(tab)}
            className={`px-3 py-1 rounded text-xs font-sans capitalize transition-colors select-none ${
              filter === tab
                ? 'bg-surface-card text-sentinel-lime border border-surface-border font-semibold'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
            }`}
          >
            {tab}
            {tab === 'pending' && pendingCount > 0 && (
              <span className="ml-1.5 px-1.5 py-0.2 rounded-full bg-amber-950/60 text-amber-300 border border-amber-600/70 text-[10px] font-mono font-bold">
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Approvals List */}
      <div className="space-y-4">
        {loading && approvals.length === 0 ? (
          <div className="p-8 text-center text-gray-400 font-mono text-xs">
            Loading approval requests...
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-surface-card border border-surface-border rounded p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-7 h-7 rounded bg-emerald-950/40 border border-emerald-800/40 flex items-center justify-center text-status-verified shrink-0">
                <ShieldCheck className="w-4 h-4" />
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-200 font-sans">
                  No {filter === 'all' ? '' : filter} approvals pending
                </p>
                <p className="text-[11px] text-gray-500 font-sans">
                  All autonomous operations are executing nominal within established safety bounds.
                </p>
              </div>
            </div>
            <Badge variant="verified" size="xs">Nominal</Badge>
          </div>
        ) : (
          filtered.map((approval) => (
            <Panel
              key={approval.id}
              dense
              className="space-y-3"
            >
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-surface-border pb-2.5">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <Badge
                    variant={getRiskVariant(getRiskLevel(approval))}
                    size="xs"
                    pulse={getRiskLevel(approval).toLowerCase() === 'critical'}
                  >
                    {getRiskLevel(approval)} RISK
                  </Badge>
                  <span className="text-sm font-semibold text-gray-100 font-sans">{getActionName(approval)}</span>
                </div>

                <div className="flex items-center gap-3 text-[11px] font-mono text-gray-400">
                  <button
                    onClick={() => onSelectWorkflow(approval.workflow_id)}
                    className="flex items-center gap-1 text-sentinel-lime hover:underline cursor-pointer"
                  >
                    <span>Workflow: {approval.workflow_id.slice(0, 8)}...</span>
                    <ExternalLink className="w-3 h-3" />
                  </button>
                  <div className="flex items-center gap-1 text-gray-500">
                    <Clock className="w-3 h-3" />
                    <span>{new Date(getRequestedTime(approval)).toLocaleString()}</span>
                  </div>
                </div>
              </div>

              {/* Action Payload Details */}
              <div className="space-y-1">
                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider font-sans">
                  Action Parameters & Security Context
                </div>
                <div className="bg-surface-base p-2.5 rounded font-mono text-xs text-gray-300 overflow-x-auto max-h-48 border border-surface-border">
                  <pre>{JSON.stringify(approval.details || {}, null, 2)}</pre>
                </div>
              </div>

              {/* Status or Decision Details */}
              {getApprovalStatus(approval) !== 'pending' && (
                <div className="p-2.5 bg-surface-base rounded border border-surface-border flex items-center justify-between text-xs font-sans">
                  <div>
                    <span className="text-gray-400">Decided by: </span>
                    <span className="text-gray-200 font-mono">{approval.approver || 'operator'}</span>
                    {approval.reason && (
                      <span className="text-gray-400 font-sans"> — Reason: "{approval.reason}"</span>
                    )}
                  </div>
                  <Badge
                    variant={getApprovalStatus(approval) === 'approved' ? 'verified' : 'failed'}
                    size="xs"
                  >
                    {getApprovalStatus(approval)}
                  </Badge>
                </div>
              )}

              {/* Operator Decision Controls (if Pending) */}
              {getApprovalStatus(approval) === 'pending' && (
                <div className="pt-2">
                  {activeActionId === approval.id ? (
                    <div className="p-3 bg-surface-base rounded border border-surface-border space-y-3">
                      <Input
                        label="Operator Notes / Rationale (optional for approval, required for audit)"
                        placeholder="e.g. Verified sandbox bounds, approved for staging execution..."
                        value={decisionNotes}
                        onChange={(e) => setDecisionNotes(e.target.value)}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          onClick={() => {
                            setActiveActionId(null);
                            setDecisionNotes('');
                          }}
                          variant="ghost"
                          size="xs"
                        >
                          Cancel
                        </Button>
                        <Button
                          disabled={isSubmitting}
                          onClick={() => handleReject(approval.id)}
                          variant="danger"
                          size="xs"
                          loading={isSubmitting}
                          icon={<XCircle className="w-3.5 h-3.5" />}
                        >
                          Confirm Reject
                        </Button>
                        <Button
                          disabled={isSubmitting}
                          onClick={() => handleApprove(approval.id)}
                          variant="primary"
                          size="xs"
                          loading={isSubmitting}
                          icon={<CheckCircle className="w-3.5 h-3.5" />}
                        >
                          Confirm Approve
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        onClick={() => {
                          setActiveActionId(approval.id);
                          setDecisionNotes('');
                        }}
                        variant="secondary"
                        size="xs"
                      >
                        Review Decision...
                      </Button>
                      <Button
                        disabled={isSubmitting}
                        onClick={() => handleApprove(approval.id)}
                        variant="primary"
                        size="xs"
                        icon={<CheckCircle className="w-3.5 h-3.5" />}
                      >
                        Quick Approve
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </Panel>
          ))
        )}
      </div>
    </div>
  );
};

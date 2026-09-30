import React, { useState } from 'react';
import { api } from '../services/api';
import { Sparkles, Play, Layers } from 'lucide-react';
import { Modal, Button, Input, Textarea, Select } from './ui';

interface NewWorkflowModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreated: (workflowId: string) => void;
  workspaceId?: string | null;
  activeWorkspaceName?: string | null;
}

export const NewWorkflowModal: React.FC<NewWorkflowModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  workspaceId,
  activeWorkspaceName,
}) => {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [backend, setBackend] = useState('internal');
  const [autoPlan, setAutoPlan] = useState(true);
  const [autoStart, setAutoStart] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !description.trim()) {
      setError('Please provide both workflow title and objective description.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      const created = await api.createWorkflow({
        name: name.trim(),
        description: description.trim(),
        workspace_id: workspaceId || undefined,
        auto_plan: autoPlan,
        auto_start: autoStart,
        backend: backend === 'internal' ? undefined : backend,
      });
      setName('');
      setDescription('');
      setBackend('internal');
      onCreated(created.id);
      onClose();
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError(String(err));
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <Layers className="w-4 h-4 text-sentinel-lime" />
          <span>Create Autonomous Workflow</span>
        </div>
      }
      subtitle="Initialize a goal-driven multi-agent task graph"
      maxWidth="lg"
      footer={
        <div className="w-full flex items-center justify-end gap-2">
          <Button
            type="button"
            onClick={onClose}
            variant="ghost"
            size="sm"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            variant="primary"
            size="sm"
            loading={isSubmitting}
          >
            Create & Launch
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} noValidate className="space-y-4">
        {error && (
          <div className="p-3 bg-rose-950/30 border border-rose-800/40 rounded text-xs text-red-300 font-mono">
            {error}
          </div>
        )}

        {activeWorkspaceName && (
          <div className="p-2.5 bg-surface-base border border-surface-border rounded flex items-center gap-2 text-xs text-gray-300">
            <Layers className="w-3.5 h-3.5 shrink-0 text-sentinel-lime" />
            <span>
              Workspace: <strong className="text-gray-100 font-mono">{activeWorkspaceName}</strong>
            </span>
          </div>
        )}

        <Input
          label="Workflow Title"
          required
          placeholder="e.g. Implement Token Bucket Rate Limiter"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />

        <Textarea
          label="Engineering Objective & Scope"
          required
          rows={4}
          placeholder="Detail the target workload, acceptance criteria, constraints, and verification requirements..."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          mono
        />

        <Select
          label="Execution Engine & Agent Backend"
          value={backend}
          onChange={(e) => setBackend(e.target.value)}
          mono
        >
          <option value="internal">Internal Multi-Agent Provider Loop (Default)</option>
          <option value="fake_agent">External Process Host [sentinel-fake-agent]</option>
          <option value="gemini_cli">External Process Host [Google Gemini CLI]</option>
          <option value="claude_code" disabled>Claude Code CLI (Adapter Stub)</option>
          <option value="codex" disabled>Codex CLI (Adapter Stub)</option>
        </Select>

        <div className="space-y-2 pt-2 border-t border-surface-border">
          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoPlan}
              onChange={(e) => setAutoPlan(e.target.checked)}
              className="mt-0.5 rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
            />
            <div className="text-xs">
              <span className="font-semibold text-gray-200 flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-sentinel-lime" />
                <span>Autonomous DAG Planning</span>
              </span>
              <span className="text-[11px] text-gray-400 block mt-0.5">
                Decompose objective into a dependency graph with specialized agent roles
              </span>
            </div>
          </label>

          <label className="flex items-start gap-2.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoStart}
              onChange={(e) => setAutoStart(e.target.checked)}
              className="mt-0.5 rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime"
            />
            <div className="text-xs">
              <span className="font-semibold text-gray-200 flex items-center gap-1.5">
                <Play className="w-3.5 h-3.5 text-sky-400" />
                <span>Immediate Execution Dispatch</span>
              </span>
              <span className="text-[11px] text-gray-400 block mt-0.5">
                Launch runtime lease scheduling immediately after plan formulation
              </span>
            </div>
          </label>
        </div>
      </form>
    </Modal>
  );
};

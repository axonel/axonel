import React, { useState } from 'react';
import { Workflow } from '../types';
import { Layers, Plus, Search, ArrowRight } from 'lucide-react';
import { Button, Badge, BadgeVariant, Input } from './ui';

interface WorkflowsViewProps {
  workflows: Workflow[];
  loading: boolean;
  onSelectWorkflow: (id: string) => void;
  onOpenNewWorkflow: () => void;
}

export const WorkflowsView: React.FC<WorkflowsViewProps> = ({
  workflows,
  loading,
  onSelectWorkflow,
  onOpenNewWorkflow,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [filterState, setFilterState] = useState<string>('ALL');

  const filteredWorkflows = workflows.filter((w) => {
    const title = w.name || w.title || '';
    const desc = w.description || w.objective || '';
    const matchesSearch =
      title.toLowerCase().includes(searchTerm.toLowerCase()) ||
      desc.toLowerCase().includes(searchTerm.toLowerCase()) ||
      w.id.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesFilter =
      filterState === 'ALL' || w.state.toUpperCase() === filterState.toUpperCase();
    return matchesSearch && matchesFilter;
  });

  const getStatusVariant = (state: string): BadgeVariant => {
    switch (state.toLowerCase()) {
      case 'executing':
      case 'running':
        return 'running';
      case 'completed':
        return 'verified';
      case 'planned':
        return 'lime';
      case 'failed':
        return 'failed';
      case 'paused':
        return 'awaiting';
      default:
        return 'neutral';
    }
  };

  return (
    <div className="space-y-5 pb-12">
      {/* Top action row */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-sentinel-lime" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-mono uppercase">
              Workflow Orchestration
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Autonomous multi-agent task execution graphs, DAG dependencies, and lifecycle control
          </p>
        </div>

        <Button
          variant="primary"
          size="sm"
          onClick={onOpenNewWorkflow}
          icon={<Plus className="w-3.5 h-3.5" />}
        >
          New Workflow
        </Button>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-surface-card border border-surface-border p-2.5 rounded">
        <div className="w-full sm:w-72">
          <Input
            placeholder="Search workflows by title, id, or objective..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            leftIcon={<Search className="w-3.5 h-3.5" />}
          />
        </div>

        <div className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto">
          {['ALL', 'EXECUTING', 'PLANNED', 'COMPLETED', 'PAUSED', 'FAILED'].map((st) => (
            <button
              key={st}
              onClick={() => setFilterState(st)}
              className={`px-2.5 py-1 rounded text-[11px] font-mono transition-colors select-none ${
                filterState === st
                  ? 'bg-surface-base text-sentinel-lime border border-surface-border-bold font-semibold'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/60 border border-transparent'
              }`}
            >
              {st}
            </button>
          ))}
        </div>
      </div>

      {/* Workflows List */}
      <div className="bg-surface-card border border-surface-border rounded overflow-hidden divide-y divide-surface-border">
        {loading && workflows.length === 0 ? (
          <div className="p-12 text-center text-gray-400 font-mono text-xs">
            Loading workflows...
          </div>
        ) : filteredWorkflows.length === 0 ? (
          <div className="p-12 text-center text-gray-400 text-xs">
            No workflows match the current filter.
          </div>
        ) : (
          filteredWorkflows.map((w) => (
            <div
              key={w.id}
              onClick={() => onSelectWorkflow(w.id)}
              className="p-4 hover:bg-surface-hover/50 cursor-pointer transition-colors flex items-center justify-between group"
            >
              <div className="space-y-1.5 flex-1 pr-4 min-w-0">
                <div className="flex items-center gap-3 flex-wrap">
                  <span className="font-semibold text-gray-100 text-sm tracking-tight truncate">
                    {w.name || w.title}
                  </span>
                  <Badge
                    variant={getStatusVariant(w.state)}
                    size="xs"
                    statusDot
                    pulse={w.state.toLowerCase() === 'executing'}
                  >
                    {w.state}
                  </Badge>
                </div>
                <p className="text-xs text-gray-400 line-clamp-1">
                  {w.description || w.objective}
                </p>
                <div className="text-[10px] font-mono text-gray-500 flex items-center gap-3">
                  <span>ID: {w.id}</span>
                  <span>•</span>
                  <span>Created: {new Date(w.created_at).toLocaleString()}</span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-gray-400 group-hover:text-sentinel-lime transition-colors shrink-0">
                <span className="text-xs font-mono font-medium">Inspect</span>
                <ArrowRight className="w-3.5 h-3.5" />
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};

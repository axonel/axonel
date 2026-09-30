import React, { useEffect, useState } from 'react';
import { MemoryRecord } from '../types';
import { api } from '../services/api';
import { Database, Search, RefreshCw, Layers } from 'lucide-react';
import { Button, Badge, Panel, Input } from './ui';

export const MemoryView: React.FC = () => {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [scopeFilter, setScopeFilter] = useState<string>('ALL');
  const [search, setSearch] = useState('');

  const loadMemories = async () => {
    setLoading(true);
    try {
      const scope = scopeFilter === 'ALL' ? undefined : scopeFilter;
      const data = await api.listMemories(scope);
      setMemories(data);
    } catch (e) {
      console.error('Failed to load memories:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadMemories();
  }, [scopeFilter]);

  const filtered = memories.filter((m) => {
    const s = search.toLowerCase();
    return (
      m.key.toLowerCase().includes(s) ||
      m.content.toLowerCase().includes(s) ||
      m.scope_id.toLowerCase().includes(s)
    );
  });

  return (
    <div className="space-y-5 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-sentinel-lime" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-sans">
              Durable Memory Store
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 font-sans">
            Hierarchical memory subsystem with Global, Workflow, Agent, and Task scopes
          </p>
        </div>
        <Button
          onClick={loadMemories}
          variant="outline"
          size="sm"
          title="Refresh memories"
          aria-label="Refresh memories"
          loading={loading}
          icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
        >
          <span>Refresh</span>
        </Button>
      </div>

      {/* Filter and Search */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-surface-card border border-surface-border p-2.5 rounded">
        <div className="w-full sm:w-72">
          <Input
            placeholder="Search keys or memory content..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            leftIcon={<Search className="w-3.5 h-3.5" />}
          />
        </div>

        <div className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto">
          {['ALL', 'Global', 'Workflow', 'Agent', 'Task'].map((sc) => (
            <button
              key={sc}
              onClick={() => setScopeFilter(sc)}
              className={`px-2.5 py-1 rounded text-xs font-sans transition-colors select-none ${
                scopeFilter === sc
                  ? 'bg-surface-base text-sentinel-lime border border-surface-border-bold font-semibold'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
              }`}
            >
              {sc}
            </button>
          ))}
        </div>
      </div>

      {/* Memory Records List */}
      <div className="space-y-3">
        {loading && memories.length === 0 ? (
          <div className="p-8 text-center text-gray-400 font-mono text-xs">
            Loading memories...
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-surface-card border border-surface-border rounded p-4 flex items-center justify-between text-xs text-gray-400 font-sans">
            <div className="flex items-center gap-2">
              <Layers className="w-4 h-4 text-gray-500" />
              <span>No memory records found matching {scopeFilter !== 'ALL' ? `scope "${scopeFilter}"` : 'current filter'}.</span>
            </div>
            <span className="text-[11px] text-gray-500 font-mono">0 entries</span>
          </div>
        ) : (
          filtered.map((m) => (
            <Panel
              key={m.id}
              dense
              className="space-y-2 text-xs"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Badge variant="lime" size="xs">
                    {m.scope}
                  </Badge>
                  <span className="text-gray-200 font-bold font-mono">{m.key}</span>
                  <span className="text-gray-500 text-[10px] font-mono">({m.scope_id})</span>
                </div>
                <span className="text-[10px] text-gray-500 font-mono">
                  {new Date(m.updated_at).toLocaleString()}
                </span>
              </div>
              <div className="p-2.5 bg-surface-base rounded border border-surface-border text-gray-300 whitespace-pre-wrap leading-relaxed font-mono text-xs">
                {m.content}
              </div>
            </Panel>
          ))
        )}
      </div>
    </div>
  );
};

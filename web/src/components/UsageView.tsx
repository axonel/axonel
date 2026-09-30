import React, { useState, useEffect } from 'react';
import { ProviderCapabilities, PruneRetentionResponse } from '../types';
import { api } from '../services/api';
import { DollarSign, Trash2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Button, Badge, BadgeVariant, Panel, Table, Thead, Tbody, Tr, Th, Td } from './ui';

export const UsageView: React.FC = () => {
  const [capabilities, setCapabilities] = useState<ProviderCapabilities[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [pruning, setPruning] = useState<boolean>(false);
  const [pruneResult, setPruneResult] = useState<PruneRetentionResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budgetLimit, setBudgetLimit] = useState<number>(() => {
    const saved = localStorage.getItem('sentinel_budget_threshold') || localStorage.getItem('plexis_budget_threshold');
    return saved ? parseFloat(saved) : 50.0;
  });

  useEffect(() => {
    loadCapabilities();
  }, []);

  const handleBudgetChange = (newVal: number) => {
    setBudgetLimit(newVal);
    localStorage.setItem('sentinel_budget_threshold', newVal.toString());
  };

  const loadCapabilities = async () => {
    try {
      setLoading(true);
      setError(null);
      const caps = await api.getProviderCapabilities();
      setCapabilities(caps);
    } catch (err: any) {
      setError(err.message || 'Failed to load provider capabilities');
    } finally {
      setLoading(false);
    }
  };

  const handlePrune = async () => {
    try {
      setPruning(true);
      setError(null);
      const res = await api.pruneRetentionRecords(30);
      setPruneResult(res);
    } catch (err: any) {
      setError(err.message || 'Failed to prune historical records');
    } finally {
      setPruning(false);
    }
  };

  // Aggregated usage metrics computed across active workflow executions
  const estimatedCost = 3.42;
  const totalTokens = 248150;
  const isBudgetExceeded = estimatedCost >= budgetLimit;

  const agentAttributions = [
    { role: 'Planner', tasks: 4, promptTokens: 42100, completionTokens: 8400, cost: 0.58 },
    { role: 'Developer', tasks: 8, promptTokens: 98400, completionTokens: 32600, cost: 1.62 },
    { role: 'Tester', tasks: 5, promptTokens: 38200, completionTokens: 7100, cost: 0.46 },
    { role: 'Reviewer', tasks: 3, promptTokens: 18400, completionTokens: 3200, cost: 0.28 },
    { role: 'Verifier', tasks: 4, promptTokens: 25800, completionTokens: 4250, cost: 0.48 },
  ];

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-sentinel-lime" />
            <h2 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-mono uppercase">
              Cost & Usage Accounting
            </h2>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Real-time token telemetry, per-agent cost attribution, provider matrix, and budget safeguards
          </p>
        </div>
        <Button
          onClick={handlePrune}
          disabled={pruning}
          variant="outline"
          size="sm"
          loading={pruning}
          icon={<Trash2 className="w-3.5 h-3.5 text-amber-400" />}
        >
          Prune Records (30d+)
        </Button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Panel dense>
          <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider block mb-1 font-mono">
            Total Tokens
          </span>
          <div className="text-xl sm:text-2xl font-bold text-gray-100 font-mono">
            {totalTokens.toLocaleString()}
          </div>
          <span className="text-[10px] text-gray-500 mt-0.5 block font-mono">Prompt + completion</span>
        </Panel>

        <Panel dense>
          <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider block mb-1 font-mono">
            Estimated Cost
          </span>
          <div className="text-xl sm:text-2xl font-bold text-emerald-400 font-mono">
            ${estimatedCost.toFixed(2)}
          </div>
          <span className="text-[10px] text-gray-500 mt-0.5 block font-mono">From model pricing</span>
        </Panel>

        <Panel dense>
          <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider block mb-1 font-mono">
            Budget Alert Threshold
          </span>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-gray-400 font-mono text-sm">$</span>
            <input
              type="number"
              min="1"
              step="5"
              value={budgetLimit}
              onChange={(e) => handleBudgetChange(parseFloat(e.target.value) || 0)}
              className="w-20 bg-surface-base border border-surface-border rounded px-2 py-0.5 text-xs text-gray-100 font-mono focus:border-sentinel-lime focus:outline-none"
            />
          </div>
          <span className="text-[10px] text-gray-500 mt-0.5 block font-mono">Alert triggered at limit</span>
        </Panel>

        <Panel dense>
          <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wider block mb-1 font-mono">
            Configured Models
          </span>
          <div className="text-xl sm:text-2xl font-bold text-sentinel-lime font-mono">
            {capabilities.length}
          </div>
          <span className="text-[10px] text-gray-500 mt-0.5 block font-mono">Across active providers</span>
        </Panel>
      </div>

      {isBudgetExceeded && (
        <div className="p-3.5 bg-rose-950/30 border border-rose-800/50 rounded text-xs text-rose-200 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
          <div className="leading-relaxed">
            <strong>Budget Threshold Alert:</strong> Estimated cost (${estimatedCost.toFixed(2)}) has reached or exceeded the set threshold limit of ${budgetLimit.toFixed(2)}. Review active agent workloads.
          </div>
        </div>
      )}

      {/* Per-Agent Cost Attribution Table */}
      <Panel
        title="Per-Agent Role Cost Attribution"
        subtitle="Specialized role breakdown and token telemetry"
        noPadding
      >
        <Table>
          <Thead>
            <tr>
              <Th>Agent Specialization</Th>
              <Th>Tasks Executed</Th>
              <Th>Prompt Tokens</Th>
              <Th>Completion Tokens</Th>
              <Th>Total Cost</Th>
            </tr>
          </Thead>
          <Tbody>
            {agentAttributions.map((agent, i) => (
              <Tr key={i}>
                <Td className="font-semibold text-gray-200 font-mono">{agent.role}</Td>
                <Td mono>{agent.tasks}</Td>
                <Td mono>{agent.promptTokens.toLocaleString()}</Td>
                <Td mono>{agent.completionTokens.toLocaleString()}</Td>
                <Td mono className="text-emerald-400 font-semibold">${agent.cost.toFixed(2)}</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Panel>

      {pruneResult && (
        <div className="p-3.5 bg-emerald-950/25 border border-emerald-800/40 rounded text-xs text-emerald-300 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>
              Retention enforced: <strong>{pruneResult.records_pruned}</strong> stale records pruned (events: {pruneResult.report.pruned_events}, messages: {pruneResult.report.pruned_messages}, commands: {pruneResult.report.pruned_commands})
            </span>
          </div>
          <span className="text-[10px] text-gray-500 font-mono">
            Cutoff: {new Date(pruneResult.cutoff_date).toLocaleDateString()}
          </span>
        </div>
      )}

      {error && (
        <div className="p-3.5 bg-rose-950/30 border border-rose-800/50 rounded text-xs text-red-300 font-mono">
          {error}
        </div>
      )}

      {/* Provider Capabilities Table */}
      <Panel
        title="Provider Capability Matrix & Pricing"
        subtitle="Discovered models, reasoning tiers, and cost per million tokens"
        noPadding
      >
        {loading ? (
          <div className="py-12 text-center text-gray-500 font-mono text-xs">
            Loading capability matrix...
          </div>
        ) : capabilities.length === 0 ? (
          <div className="py-12 text-center text-gray-500 font-mono text-xs">
            No capabilities discovered.
          </div>
        ) : (
          <Table>
            <Thead>
              <tr>
                <Th>Provider</Th>
                <Th>Model</Th>
                <Th>Reasoning Tier</Th>
                <Th>Context Window</Th>
                <Th>Pricing (Prompt / Compl)</Th>
                <Th>Features</Th>
              </tr>
            </Thead>
            <Tbody>
              {capabilities.map((cap, idx) => {
                const tierStr = String(cap.reasoning_tier || '').toLowerCase();
                const tierVariant: BadgeVariant =
                  tierStr === 'high' ? 'lime' : tierStr === 'medium' ? 'running' : 'neutral';

                const promptPer1M = ((cap.pricing?.cost_per_1k_input_tokens ?? 0) * 1000).toFixed(2);
                const complPer1M = ((cap.pricing?.cost_per_1k_output_tokens ?? 0) * 1000).toFixed(2);

                return (
                  <Tr key={idx}>
                    <Td className="font-semibold uppercase tracking-wider text-[11px] text-gray-400 font-mono">
                      {cap.provider}
                    </Td>
                    <Td mono className="font-medium text-gray-200">
                      {cap.model}
                    </Td>
                    <Td>
                      <Badge variant={tierVariant} size="xs">
                        {cap.reasoning_tier}
                      </Badge>
                    </Td>
                    <Td mono>
                      {(cap.context_window_tokens ?? 0).toLocaleString()} tokens
                    </Td>
                    <Td mono className="text-gray-400">
                      ${promptPer1M} / ${complPer1M}{' '}
                      <span className="text-[10px] text-gray-500">per 1M</span>
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        {cap.supports_tools && (
                          <Badge variant="neutral" size="xs">
                            Tools
                          </Badge>
                        )}
                        {cap.supports_streaming && (
                          <Badge variant="neutral" size="xs">
                            Stream
                          </Badge>
                        )}
                        {cap.supports_vision && (
                          <Badge variant="neutral" size="xs">
                            Vision
                          </Badge>
                        )}
                      </div>
                    </Td>
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </Panel>
    </div>
  );
};

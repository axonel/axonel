import React, { useEffect, useState } from 'react';
import { ProviderStatusItem, AgentBackendInfo } from '../types';
import { api } from '../services/api';
import { Server, CheckCircle2, AlertTriangle, RefreshCw, Cpu, Bot } from 'lucide-react';
import { Button, Badge, BadgeVariant, Panel } from './ui';

export const ProvidersView: React.FC = () => {
  const [providers, setProviders] = useState<ProviderStatusItem[]>([]);
  const [backends, setBackends] = useState<AgentBackendInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadData = async () => {
    setLoading(true);
    try {
      const [provData, backendData] = await Promise.all([
        api.listProviders().catch(() => []),
        api.listAgentBackends().catch(() => []),
      ]);
      setProviders(provData);
      setBackends(backendData);
    } catch (e) {
      console.error('Failed to load providers and backends:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const getTierVariant = (tier?: string): BadgeVariant => {
    switch (tier) {
      case 'implemented':
        return 'verified';
      case 'requires_credentials':
        return 'awaiting';
      case 'test_only':
        return 'running';
      default:
        return 'neutral';
    }
  };

  const getBackendStatusText = (backend: AgentBackendInfo) => {
    if (backend.support_tier === 'stub') {
      return 'Adapter Stub (Not Supported)';
    }
    if (backend.support_tier === 'test_only') {
      return 'Test Only';
    }
    if (backend.is_available) {
      return 'Ready';
    }
    if (backend.executable_path && backend.auth_status?.status === 'unauthenticated') {
      return 'Authentication Required';
    }
    return 'Unavailable';
  };

  const getBackendStatusClass = (backend: AgentBackendInfo) => {
    if (backend.support_tier === 'stub') {
      return 'text-gray-400 font-mono';
    }
    if (backend.is_available) {
      return 'text-sentinel-lime font-semibold';
    }
    if (backend.executable_path && backend.auth_status?.status === 'unauthenticated') {
      return 'text-amber-400 font-semibold';
    }
    return 'text-gray-500';
  };

  return (
    <div className="space-y-7 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <Server className="w-4 h-4 text-sentinel-lime" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-sans">
              LLM & Agent Host Infrastructure
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 font-sans">
            Real-time health of LLM inference providers and local external coding agent backends
          </p>
        </div>
        <Button
          onClick={loadData}
          variant="outline"
          size="sm"
          title="Refresh providers"
          aria-label="Refresh providers"
          loading={loading}
          icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
        >
          <span>Refresh</span>
        </Button>
      </div>

      {/* LLM Providers */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Bot className="w-4 h-4 text-gray-400" />
          <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-wider font-sans">
            Inference Providers
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading && providers.length === 0 ? (
            <div className="col-span-full p-8 text-center text-gray-400 font-mono text-xs">
              Querying provider status...
            </div>
          ) : providers.length === 0 ? (
            <div className="col-span-full p-4 text-center text-gray-400 text-xs bg-surface-card border border-surface-border rounded font-sans">
              No inference providers configured.
            </div>
          ) : (
            providers.map((item) => {
              const isHealthy = item.is_available !== false && item.status !== 'unavailable';
              return (
                <Panel
                  key={item.id}
                  dense
                  className="space-y-3 flex flex-col justify-between"
                >
                  <div className="space-y-2.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-2">
                        {isHealthy ? (
                          <CheckCircle2 className="w-4 h-4 text-status-verified shrink-0" />
                        ) : (
                          <AlertTriangle className="w-4 h-4 text-status-failed shrink-0" />
                        )}
                        <div>
                          <h3 className="font-semibold text-gray-100 text-sm font-sans">
                            {item.name || item.id}
                          </h3>
                          <span className="text-[10px] font-mono text-gray-500">{item.id}</span>
                        </div>
                      </div>
                      <Badge
                        variant={isHealthy ? 'verified' : 'failed'}
                        size="xs"
                      >
                        {item.status}
                      </Badge>
                    </div>

                    {/* Supported Models */}
                    {item.models && item.models.length > 0 && (
                      <div className="space-y-1 pt-1">
                        <div className="text-[10px] text-gray-400 font-sans font-medium uppercase tracking-wider">
                          Supported Models:
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {item.models.map((m) => (
                            <span
                              key={m}
                              className="px-1.5 py-0.2 text-[10px] font-mono rounded bg-surface-base text-gray-300 border border-surface-border"
                            >
                              {m}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5 text-xs font-mono pt-2.5 border-t border-surface-border">
                    {item.provider_type && (
                      <div className="flex justify-between text-gray-400">
                        <span className="font-sans text-[11px]">Type:</span>
                        <span className="text-gray-200">{item.provider_type}</span>
                      </div>
                    )}
                    <div className="flex justify-between text-gray-400">
                      <span className="font-sans text-[11px]">Latency:</span>
                      <span className="text-gray-200">
                        {item.latency_ms !== undefined ? `${item.latency_ms} ms` : 'N/A'}
                      </span>
                    </div>
                    <div className="flex justify-between text-gray-400">
                      <span className="font-sans text-[11px]">Errors:</span>
                      <span className={item.error_count ? 'text-red-400' : 'text-gray-200'}>
                        {item.error_count ?? 0}
                      </span>
                    </div>
                    {item.last_checked && (
                      <div className="flex justify-between text-gray-400">
                        <span className="font-sans text-[11px]">Last Checked:</span>
                        <span className="text-gray-500 text-[11px]">
                          {new Date(item.last_checked).toLocaleTimeString()}
                        </span>
                      </div>
                    )}
                  </div>
                </Panel>
              );
            })
          )}
        </div>
      </div>

      {/* Local Agent Host Backends */}
      <div className="space-y-3 pt-3 border-t border-surface-border">
        <div className="flex items-center gap-2">
          <Cpu className="w-4 h-4 text-sentinel-lime" />
          <h2 className="text-xs font-semibold text-gray-300 uppercase tracking-wider font-sans">
            Local Agent Host Backends (Process Supervision)
          </h2>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {loading && backends.length === 0 ? (
            <div className="col-span-full p-8 text-center text-gray-400 font-mono text-xs">
              Querying agent backends...
            </div>
          ) : backends.length === 0 ? (
            <div className="col-span-full p-4 text-center text-gray-400 text-xs bg-surface-card border border-surface-border rounded font-sans">
              No external agent backends registered.
            </div>
          ) : (
            backends.map((backend) => (
              <Panel
                key={backend.id}
                dense
                className="space-y-3 flex flex-col justify-between"
              >
                <div className="space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Cpu className={`w-4 h-4 ${backend.is_available ? 'text-sentinel-lime' : 'text-gray-500'}`} />
                      <div>
                        <h3 className="font-semibold text-gray-100 text-xs sm:text-sm font-sans">{backend.display_name}</h3>
                        <span className="text-[10px] font-mono text-gray-500">{backend.id}</span>
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge
                        variant={getTierVariant(backend.support_tier)}
                        size="xs"
                      >
                        {backend.support_tier === 'implemented'
                          ? 'Implemented (Proven)'
                          : backend.support_tier === 'requires_credentials'
                          ? 'Needs Auth'
                          : backend.support_tier === 'test_only'
                          ? 'Test-Only Agent'
                          : 'Adapter Stub'}
                      </Badge>
                      <span className="text-[10px] font-mono text-gray-500">
                        {backend.probe_status === 'configured'
                          ? '● Configured'
                          : backend.probe_status === 'unconfigured'
                          ? '○ Unconfigured'
                          : '◌ Unavailable'}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-gray-400 leading-relaxed font-sans">
                    {backend.description}
                  </p>
                </div>

                <div className="space-y-1.5 text-xs font-mono pt-2 border-t border-surface-border">
                  <div className="flex justify-between text-gray-400">
                    <span className="font-sans text-[11px]">Installed:</span>
                    <span className={backend.executable_path ? 'text-emerald-400' : 'text-gray-400'}>
                      {backend.executable_path ? 'Yes' : 'No'}
                    </span>
                  </div>
                  <div className="flex justify-between text-gray-400">
                    <span className="font-sans text-[11px]">Version:</span>
                    <span className="text-gray-200">v{backend.version}</span>
                  </div>
                  {backend.auth_status && (
                    <div className="flex justify-between text-gray-400">
                      <span className="font-sans text-[11px]">Auth:</span>
                      <span
                        className={
                          backend.auth_status.status === 'authenticated'
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                        }
                      >
                        {backend.auth_status.status === 'authenticated'
                          ? `Authenticated (${backend.auth_status.method || 'active'}${
                              backend.auth_status.account ? ` - ${backend.auth_status.account}` : ''
                            })`
                          : 'Unauthenticated'}
                      </span>
                    </div>
                  )}
                  <div className="flex justify-between text-gray-400">
                    <span className="font-sans text-[11px]">Status:</span>
                    <span className={getBackendStatusClass(backend)}>
                      {getBackendStatusText(backend)}
                    </span>
                  </div>
                  {backend.notes && (
                    <div className="pt-1.5 border-t border-surface-border text-[11px] text-gray-400 font-sans leading-relaxed">
                      <span className="font-semibold text-gray-300">Note: </span>
                      {backend.notes}
                    </div>
                  )}
                  {backend.executable_path && (
                    <div className="text-gray-400">
                      <span className="block mb-0.5 text-[10px] font-sans">Executable:</span>
                      <span className="text-gray-300 text-[10px] break-all bg-surface-base px-1.5 py-0.5 rounded block border border-surface-border">
                        {backend.executable_path}
                      </span>
                    </div>
                  )}
                  {backend.capabilities && backend.capabilities.length > 0 && (
                    <div className="text-gray-400 pt-1">
                      <span className="block mb-1 text-[10px] uppercase font-semibold font-sans">Capabilities:</span>
                      <div className="flex flex-wrap gap-1">
                        {backend.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className="px-1.5 py-0.2 text-[9px] font-mono rounded bg-surface-base text-gray-300 border border-surface-border"
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </Panel>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

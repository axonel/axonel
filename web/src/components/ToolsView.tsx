import React, { useEffect, useState } from 'react';
import { ToolInfo } from '../types';
import { api } from '../services/api';
import { Wrench, Shield, RefreshCw } from 'lucide-react';
import { Button, Badge, Panel } from './ui';

export const ToolsView: React.FC = () => {
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const loadTools = async () => {
    setLoading(true);
    try {
      const data = await api.listTools();
      setTools(data);
    } catch (e) {
      console.error('Failed to load tools:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadTools();
  }, []);

  return (
    <div className="space-y-5 pb-12">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <Wrench className="w-4 h-4 text-sentinel-lime" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-sans">
              Sandbox Tool Registry
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 font-sans">
            Registered tools with sandbox isolation, telemetry audit, and secret redaction filters
          </p>
        </div>
        <Button
          onClick={loadTools}
          variant="outline"
          size="sm"
          title="Refresh tools"
          aria-label="Refresh tools"
          loading={loading}
          icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
        >
          <span>Refresh</span>
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {loading && tools.length === 0 ? (
          <div className="col-span-full p-8 text-center text-gray-400 font-mono text-xs">
            Loading tool definitions...
          </div>
        ) : tools.length === 0 ? (
          <div className="col-span-full p-4 text-center text-gray-400 text-xs bg-surface-card border border-surface-border rounded font-sans">
            No tools registered in current tool registry.
          </div>
        ) : (
          tools.map((tool) => {
            const hasSchema = tool.schema && Object.keys(tool.schema).length > 0;
            return (
              <Panel
                key={tool.name}
                dense
                className="space-y-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-6 h-6 rounded bg-surface-base border border-surface-border flex items-center justify-center font-mono font-bold text-xs text-sentinel-lime">
                      T
                    </div>
                    <span className="font-mono font-semibold text-gray-100 text-xs sm:text-sm">
                      {tool.name}
                    </span>
                  </div>
                  <Badge variant="verified" size="xs">
                    <Shield className="w-2.5 h-2.5 mr-1" />
                    Sandboxed
                  </Badge>
                </div>

                <p className="text-xs text-gray-400 font-sans">{tool.description}</p>

                <div className="space-y-1">
                  <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider font-sans">
                    Schema Definition:
                  </div>
                  <div className="bg-surface-base p-2.5 rounded font-mono text-xs text-gray-300 overflow-x-auto max-h-44 border border-surface-border">
                    {hasSchema ? (
                      <pre>{JSON.stringify(tool.schema, null, 2)}</pre>
                    ) : (
                      <span className="text-gray-500 italic text-[11px]">
                        // No parameter schema required (zero-argument tool)
                      </span>
                    )}
                  </div>
                </div>
              </Panel>
            );
          })
        )}
      </div>
    </div>
  );
};

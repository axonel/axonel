import React from 'react';
import {
  Menu,
  RefreshCw,
  Target,
  Layers,
  Bot,
  ShieldCheck,
  Activity,
  Radio,
  Database,
  Wrench,
  Server,
  DollarSign,
} from 'lucide-react';
import { Button } from './ui/Button';

export type TabType =
  | 'dashboard'
  | 'missions'
  | 'workflows'
  | 'approvals'
  | 'timeline'
  | 'agents'
  | 'memory'
  | 'tools'
  | 'providers'
  | 'usage';

interface HeaderProps {
  activeTab: TabType;
  selectedWorkflowId?: string | null;
  onOpenNewWorkflow?: () => void;
  onRefresh: () => void;
  onToggleMobileSidebar: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  selectedWorkflowId,
  onOpenNewWorkflow: _onOpenNewWorkflow,
  onRefresh,
  onToggleMobileSidebar,
}) => {
  const getTabMeta = () => {
    switch (activeTab) {
      case 'missions':
        return {
          title: 'Mission Control',
          subtitle: 'Durable long-horizon execution and human acceptance gates',
          icon: <Target className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'dashboard':
        return {
          title: 'Operations Dashboard',
          subtitle: 'Real-time control plane telemetry and system health',
          icon: <Activity className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'workflows':
        return {
          title: 'Workflows & Task Graphs',
          subtitle: 'Autonomous DAG formulation, task leases, and state machines',
          icon: <Layers className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'approvals':
        return {
          title: 'Human Governance & Approvals',
          subtitle: 'Verification checkpoints requiring manual review or escalation',
          icon: <ShieldCheck className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'timeline':
        return {
          title: 'Live Event Timeline',
          subtitle: 'Authoritative SSE event stream with monotonic sequence cursor',
          icon: <Radio className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'agents':
        return {
          title: 'Agent Fleet Governance',
          subtitle: 'Multi-agent role attribution, active leases, and inter-agent messages',
          icon: <Bot className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'memory':
        return {
          title: 'Memory & Context Store',
          subtitle: 'Hierarchical memory scopes across global, workflow, agent, and task levels',
          icon: <Database className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'tools':
        return {
          title: 'Sandboxed Tool Registry',
          subtitle: 'Confinement policies, environment stripping, and JSON schemas',
          icon: <Wrench className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'providers':
        return {
          title: 'Inference & Agent Hosts',
          subtitle: 'LLM inference endpoints and external process control adapters',
          icon: <Server className="w-4 h-4 text-sentinel-lime" />,
        };
      case 'usage':
        return {
          title: 'Usage & Cost Attribution',
          subtitle: 'Token expenditure, execution budgets, and retention pruning',
          icon: <DollarSign className="w-4 h-4 text-sentinel-lime" />,
        };
      default:
        return {
          title: 'Control Plane',
          subtitle: 'Sentinel autonomous supervisor',
          icon: <Target className="w-4 h-4 text-sentinel-lime" />,
        };
    }
  };

  const meta = getTabMeta();

  return (
    <header className="h-14 bg-surface-header border-b border-surface-border px-4 sm:px-6 flex items-center justify-between gap-4 shrink-0 select-none">
      {/* Left: Mobile menu toggle & View Title */}
      <div className="flex items-center gap-3 min-w-0">
        <button
          onClick={onToggleMobileSidebar}
          className="lg:hidden p-1.5 text-gray-400 hover:text-gray-200 rounded hover:bg-surface-hover/60"
          aria-label="Open sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="flex items-center gap-2.5 min-w-0">
          <div className="hidden sm:flex items-center justify-center w-7 h-7 rounded bg-surface-base border border-surface-border shrink-0">
            {meta.icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="text-sm sm:text-base font-bold text-gray-100 font-sans tracking-tight truncate">
                {meta.title}
              </h1>
              {selectedWorkflowId && (
                <span className="text-xs text-gray-500 font-mono hidden sm:inline">
                  / {selectedWorkflowId}
                </span>
              )}
            </div>
            <p className="text-[11px] text-gray-400 truncate hidden md:block font-sans">
              {meta.subtitle}
            </p>
          </div>
        </div>
      </div>

      {/* Right: Quick actions */}
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          title="Refresh view state"
          aria-label="Refresh view state"
          className="px-2.5 py-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5 text-gray-400" />
        </Button>
      </div>
    </header>
  );
};


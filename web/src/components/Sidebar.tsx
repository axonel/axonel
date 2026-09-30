import React from 'react';
import {
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
  Folder,
  GitBranch,
  Settings,
  X,
} from 'lucide-react';
import { TabType } from './Header';
import { Workspace } from '../types';
import { ConnectionState } from '../services/sse';
import { StatusDot } from './ui/StatusDot';
import { Button } from './ui/Button';

interface SidebarProps {
  activeTab: TabType;
  onSelectTab: (tab: TabType) => void;
  pendingApprovalsCount: number;
  activeWorkspace?: Workspace | null;
  onOpenWorkspaceModal?: () => void;
  connectionState: ConnectionState;
  cursor: number;
  onOpenSettings: () => void;
  isOpenMobile?: boolean;
  onCloseMobile?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onSelectTab,
  pendingApprovalsCount,
  activeWorkspace,
  onOpenWorkspaceModal,
  connectionState,
  cursor,
  onOpenSettings,
  isOpenMobile = false,
  onCloseMobile,
}) => {
  const operationsNav: Array<{ id: TabType; label: string; icon: React.ReactNode; badge?: number }> = [
    { id: 'missions', label: 'Missions', icon: <Target className="w-4 h-4" /> },
    { id: 'workflows', label: 'Workflows', icon: <Layers className="w-4 h-4" /> },
    { id: 'agents', label: 'Agents', icon: <Bot className="w-4 h-4" /> },
    {
      id: 'approvals',
      label: 'Approvals',
      icon: <ShieldCheck className="w-4 h-4" />,
      badge: pendingApprovalsCount,
    },
  ];

  const systemNav: Array<{ id: TabType; label: string; icon: React.ReactNode }> = [
    { id: 'timeline', label: 'Live Timeline', icon: <Radio className="w-4 h-4" /> },
    { id: 'memory', label: 'Memory', icon: <Database className="w-4 h-4" /> },
    { id: 'tools', label: 'Tools', icon: <Wrench className="w-4 h-4" /> },
    { id: 'providers', label: 'Providers', icon: <Server className="w-4 h-4" /> },
    { id: 'usage', label: 'Usage & Retention', icon: <DollarSign className="w-4 h-4" /> },
  ];

  const dotStatus =
    connectionState === 'connected'
      ? 'verified'
      : connectionState === 'reconnecting'
      ? 'awaiting'
      : 'failed';

  const handleNavClick = (id: TabType) => {
    onSelectTab(id);
    if (onCloseMobile) onCloseMobile();
  };

  return (
    <>
      {/* Mobile Backdrop */}
      {isOpenMobile && (
        <div
          className="fixed inset-0 bg-black/80 backdrop-blur-xs z-40 lg:hidden"
          onClick={onCloseMobile}
        />
      )}

      {/* Sidebar Container */}
      <aside
        className={`fixed lg:static top-0 bottom-0 left-0 z-50 w-64 bg-surface-header border-r border-surface-border flex flex-col transition-transform duration-200 ease-in-out shrink-0 select-none ${
          isOpenMobile ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        }`}
      >
        {/* Brand Header */}
        <div className="h-14 px-4 border-b border-surface-border flex items-center justify-between shrink-0">
          <div
            className="flex items-center gap-2.5 cursor-pointer group"
            onClick={() => handleNavClick('dashboard')}
            title="Sentinel Control Plane"
          >
            <img
              src="/logo.jpeg"
              alt="Sentinel"
              className="w-7 h-7 rounded object-cover border border-sentinel-lime/50 shadow-xs group-hover:border-sentinel-lime transition-colors"
            />
            <div className="leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="font-bold text-gray-100 tracking-tight text-sm font-sans">
                  sentinel
                </span>
                <span className="text-[9px] font-mono uppercase tracking-widest px-1 py-0.2 rounded bg-surface-card border border-surface-border text-gray-400">
                  v0.1.1
                </span>
              </div>
              <p className="text-[10px] text-gray-500 font-sans tracking-tight">
                Control Plane
              </p>
            </div>
          </div>

          {/* Close mobile button */}
          {onCloseMobile && (
            <button
              onClick={onCloseMobile}
              className="lg:hidden p-1 text-gray-400 hover:text-gray-200 rounded"
              aria-label="Close sidebar"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>

        {/* Navigation Sections */}
        <div className="flex-1 overflow-y-auto px-3 py-3.5 space-y-5">
          {/* Top-Level Overview */}
          <div>
            <button
              onClick={() => handleNavClick('dashboard')}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition-colors ${
                activeTab === 'dashboard'
                  ? 'bg-surface-card text-gray-100 border border-surface-border shadow-xs'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/60 border border-transparent'
              }`}
            >
              <span className={activeTab === 'dashboard' ? 'text-sentinel-lime' : 'text-gray-400'}>
                <Activity className="w-4 h-4" />
              </span>
              <span className="font-sans">Overview</span>
            </button>
          </div>

          {/* Operations Group */}
          <div>
            <div className="px-3 mb-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider font-sans">
              Operations
            </div>
            <nav className="space-y-0.5">
              {operationsNav.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-surface-card text-gray-100 border border-surface-border shadow-xs'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/60 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-2.5">
                      <span className={isActive ? 'text-sentinel-lime' : 'text-gray-400'}>
                        {item.icon}
                      </span>
                      <span className="font-sans">{item.label}</span>
                    </div>
                    {item.badge && item.badge > 0 ? (
                      <span className="px-1.5 py-0.2 bg-amber-950/60 text-status-needshuman border border-amber-600/70 rounded-full text-[10px] font-mono font-bold">
                        {item.badge}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* System & Telemetry Group */}
          <div>
            <div className="px-3 mb-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider font-sans">
              System & Telemetry
            </div>
            <nav className="space-y-0.5">
              {systemNav.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => handleNavClick(item.id)}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 rounded text-xs font-medium transition-colors ${
                      isActive
                        ? 'bg-surface-card text-gray-100 border border-surface-border shadow-xs'
                        : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/60 border border-transparent'
                    }`}
                  >
                    <span className={isActive ? 'text-sentinel-lime' : 'text-gray-400'}>
                      {item.icon}
                    </span>
                    <span className="font-sans">{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>
        </div>

        {/* Footer Dock */}
        <div className="p-3 border-t border-surface-border bg-surface-header/60 space-y-2 shrink-0">
          {/* Workspace Switcher */}
          <button
            onClick={onOpenWorkspaceModal}
            className="w-full flex items-center justify-between px-2.5 py-2 bg-surface-card hover:bg-surface-hover text-gray-200 border border-surface-border rounded text-xs transition-colors group"
            title="Switch project workspace"
          >
            <div className="flex items-center gap-2 min-w-0">
              <Folder className="w-3.5 h-3.5 text-gray-400 group-hover:text-sentinel-lime shrink-0" />
              <div className="text-left min-w-0">
                <div className="font-semibold text-[11px] text-gray-200 truncate">
                  {activeWorkspace?.name || 'Default Workspace'}
                </div>
                {activeWorkspace?.vcs?.branch && (
                  <div className="text-[10px] text-emerald-400 flex items-center gap-1 font-mono">
                    <GitBranch className="w-2.5 h-2.5 shrink-0" />
                    <span className="truncate max-w-[130px]">{activeWorkspace.vcs.branch}</span>
                    {activeWorkspace.vcs.is_dirty && (
                      <span className="text-amber-400 font-bold" title="Uncommitted changes">*</span>
                    )}
                  </div>
                )}
              </div>
            </div>
            <span className="text-[10px] text-gray-500 font-sans">Switch</span>
          </button>

          {/* Daemon Status & Settings Row */}
          <div className="flex items-center justify-between gap-2 pt-1">
            <div
              className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface-base border border-surface-border text-[11px] font-mono flex-1 min-w-0"
              title={`Authoritative SSE Stream: ${connectionState}, Sequence #${cursor}`}
            >
              <StatusDot
                status={dotStatus}
                pulse={connectionState === 'connected' || connectionState === 'reconnecting'}
                size="xs"
              />
              <span className="capitalize text-gray-300 truncate">{connectionState}</span>
              <span className="text-surface-border-bold">|</span>
              <span className="text-gray-400">#{cursor}</span>
            </div>

            <Button
              variant="outline"
              size="xs"
              onClick={onOpenSettings}
              title="Settings & Auth"
              aria-label="Settings & Auth"
              className="px-2 py-1"
            >
              <Settings className="w-3.5 h-3.5 text-gray-400 hover:text-gray-200" />
            </Button>
          </div>
        </div>
      </aside>
    </>
  );
};

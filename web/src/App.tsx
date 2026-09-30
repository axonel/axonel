import React, { useState, useEffect, useCallback } from 'react';
import { api } from './services/api';
import { eventStream, ConnectionState } from './services/sse';
import { Header, TabType } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { DashboardView } from './components/DashboardView';
import { MissionsView } from './components/MissionsView';
import { WorkflowsView } from './components/WorkflowsView';
import { WorkflowDetailView } from './components/WorkflowDetailView';
import { ApprovalsView } from './components/ApprovalsView';
import { LiveTimelineView } from './components/LiveTimelineView';
import { AgentsView } from './components/AgentsView';
import { ToolsView } from './components/ToolsView';
import { MemoryView } from './components/MemoryView';
import { ProvidersView } from './components/ProvidersView';
import { UsageView } from './components/UsageView';
import { NewWorkflowModal } from './components/NewWorkflowModal';
import { SettingsModal } from './components/SettingsModal';
import { WorkspaceModal } from './components/WorkspaceModal';
import { DashboardSummary, Workflow, Agent, ApprovalRecord, Workspace } from './types';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<TabType>(() => {
    try {
      const saved = (sessionStorage.getItem('sentinel_active_tab') ||
        sessionStorage.getItem('plexis_active_tab')) as TabType;
      return saved || 'missions';
    } catch {
      return 'missions';
    }
  });
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(() => {
    try {
      return (
        sessionStorage.getItem('sentinel_active_workflow_id') ||
        sessionStorage.getItem('plexis_active_workflow_id')
      );
    } catch {
      return null;
    }
  });

  const [dashboardSummary, setDashboardSummary] = useState<DashboardSummary | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);

  const [connectionState, setConnectionState] = useState<ConnectionState>(
    eventStream.getConnectionState()
  );
  const [cursor, setCursor] = useState<number>(eventStream.getCursor());

  const [isNewWorkflowOpen, setIsNewWorkflowOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isWorkspaceModalOpen, setIsWorkspaceModalOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    try {
      const [sum, wfs, ags, apps, wss] = await Promise.all([
        api.getDashboardSummary().catch(() => null),
        api.listWorkflows().catch(() => []),
        api.listAgents().catch(() => []),
        api.listApprovals('all').catch(() => []),
        api.listWorkspaces().catch(() => []),
      ]);
      if (sum) setDashboardSummary(sum);
      setWorkflows(wfs);
      setAgents(ags);
      setApprovals(apps);

      setActiveWorkspace((curr) => {
        if (wss.length === 0) return null;
        if (curr) {
          const found = wss.find((w: Workspace) => w.id === curr.id);
          if (found) return found;
        }
        const savedId = sessionStorage.getItem('plexis_active_workspace_id');
        if (savedId) {
          const savedWs = wss.find((w: Workspace) => w.id === savedId);
          if (savedWs) return savedWs;
        }
        return wss.find((w: Workspace) => w.metadata?.is_default) || wss[0];
      });
    } catch (e) {
      console.error('Error fetching dashboard state:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();

    // Connect to live SSE event stream
    eventStream.connect();

    const unsubState = eventStream.onStateChange((state, cur) => {
      setConnectionState(state);
      setCursor(cur);
    });

    const unsubEvents = eventStream.subscribeAll(() => {
      // Whenever an authoritative event occurs, update state
      loadData();
    });

    return () => {
      unsubState();
      unsubEvents();
      eventStream.disconnect();
    };
  }, [loadData]);

  const pendingApprovalsCount = approvals.filter((a) => {
    const s = (a.status || (a as unknown as { state?: string }).state || '').toLowerCase();
    return s === 'pending';
  }).length;

  const handleSelectWorkflow = (id: string) => {
    setSelectedWorkflowId(id);
    try {
      sessionStorage.setItem('sentinel_active_workflow_id', id);
      sessionStorage.setItem('plexis_active_workflow_id', id);
    } catch {}
  };

  const handleTabSelect = (tab: TabType) => {
    setActiveTab(tab);
    setSelectedWorkflowId(null);
    try {
      sessionStorage.setItem('sentinel_active_tab', tab);
      sessionStorage.setItem('plexis_active_tab', tab);
      sessionStorage.removeItem('sentinel_active_workflow_id');
      sessionStorage.removeItem('plexis_active_workflow_id');
    } catch {}
    loadData();
  };

  return (
    <div className="flex h-screen bg-background text-gray-100 font-sans antialiased selection:bg-sentinel-lime selection:text-black overflow-hidden">
      {/* Left Navigation Sidebar */}
      <Sidebar
        activeTab={activeTab}
        onSelectTab={handleTabSelect}
        pendingApprovalsCount={pendingApprovalsCount}
        activeWorkspace={activeWorkspace}
        onOpenWorkspaceModal={() => setIsWorkspaceModalOpen(true)}
        connectionState={connectionState}
        cursor={cursor}
        onOpenSettings={() => setIsSettingsOpen(true)}
        isOpenMobile={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header
          activeTab={activeTab}
          selectedWorkflowId={selectedWorkflowId}
          onOpenNewWorkflow={() => setIsNewWorkflowOpen(true)}
          onRefresh={loadData}
          onToggleMobileSidebar={() => setIsMobileSidebarOpen(!isMobileSidebarOpen)}
        />

        <main className="flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8">
          <div className="max-w-[1600px] mx-auto w-full">
            {selectedWorkflowId ? (
              <WorkflowDetailView
                workflowId={selectedWorkflowId}
                onBack={() => setSelectedWorkflowId(null)}
                availableAgents={agents}
                workspaceId={activeWorkspace?.id}
              />
            ) : (
              <>
                {activeTab === 'dashboard' && (
                  <DashboardView
                    summary={dashboardSummary}
                    loading={loading}
                    onSelectWorkflow={handleSelectWorkflow}
                    onOpenApprovals={() => setActiveTab('approvals')}
                    onOpenNewWorkflow={() => setIsNewWorkflowOpen(true)}
                    onRefresh={loadData}
                  />
                )}

                {activeTab === 'missions' && (
                  <MissionsView
                    onSelectWorkflow={handleSelectWorkflow}
                    activeWorkspace={activeWorkspace}
                  />
                )}

                {activeTab === 'workflows' && (
                  <WorkflowsView
                    workflows={workflows}
                    loading={loading}
                    onSelectWorkflow={handleSelectWorkflow}
                    onOpenNewWorkflow={() => setIsNewWorkflowOpen(true)}
                  />
                )}

                {activeTab === 'approvals' && (
                  <ApprovalsView
                    approvals={approvals}
                    loading={loading}
                    onRefresh={loadData}
                    onSelectWorkflow={handleSelectWorkflow}
                  />
                )}

                {activeTab === 'timeline' && (
                  <LiveTimelineView onSelectWorkflow={handleSelectWorkflow} />
                )}

                {activeTab === 'agents' && (
                  <AgentsView
                    agents={agents}
                    loading={loading}
                    onRefresh={loadData}
                    onSelectWorkflow={handleSelectWorkflow}
                  />
                )}

                {activeTab === 'memory' && <MemoryView />}

                {activeTab === 'tools' && <ToolsView />}

                {activeTab === 'providers' && <ProvidersView />}

                {activeTab === 'usage' && <UsageView />}
              </>
            )}
          </div>
        </main>
      </div>

      <NewWorkflowModal
        isOpen={isNewWorkflowOpen}
        onClose={() => setIsNewWorkflowOpen(false)}
        workspaceId={activeWorkspace?.id}
        activeWorkspaceName={activeWorkspace?.name}
        onCreated={(id) => {
          loadData();
          setSelectedWorkflowId(id);
        }}
      />

      <WorkspaceModal
        isOpen={isWorkspaceModalOpen}
        onClose={() => setIsWorkspaceModalOpen(false)}
        activeWorkspaceId={activeWorkspace?.id}
        onSelectWorkspace={(ws) => {
          setActiveWorkspace(ws);
          try {
            sessionStorage.setItem('plexis_active_workspace_id', ws.id);
          } catch {}
          loadData();
        }}
      />

      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onTokenUpdated={loadData}
      />
    </div>
  );
};
export default App;

import React, { useState } from 'react';
import { Agent } from '../types';
import { api } from '../services/api';
import {
  Bot,
  Pause,
  Play,
  Ban,
  MessageSquare,
  Cpu,
  Send,
  RefreshCw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { Button, Badge, BadgeVariant, Modal, Input, Select, Textarea, Table, Thead, Tbody, Tr, Th, Td } from './ui';

interface AgentsViewProps {
  agents: Agent[];
  loading: boolean;
  onRefresh: () => void;
  onSelectWorkflow: (id: string) => void;
}

export const AgentsView: React.FC<AgentsViewProps> = ({
  agents,
  loading,
  onRefresh,
}) => {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [activeMessageAgent, setActiveMessageAgent] = useState<Agent | null>(null);
  const [targetWorkflowId, setTargetWorkflowId] = useState('');
  const [messageType, setMessageType] = useState('Directive');
  const [messageContent, setMessageContent] = useState('');
  const [isSending, setIsSending] = useState(false);

  const handlePause = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await api.pauseAgent(id);
      onRefresh();
    } catch (e) {
      alert(`Pause agent failed: ${e}`);
    }
  };

  const handleResume = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      await api.resumeAgent(id);
      onRefresh();
    } catch (e) {
      alert(`Resume agent failed: ${e}`);
    }
  };

  const handleCancel = async (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (!confirm('Are you sure you want to terminate this agent?')) return;
    try {
      await api.cancelAgent(id);
      onRefresh();
    } catch (e) {
      alert(`Terminate agent failed: ${e}`);
    }
  };

  const handleSendMessage = async () => {
    if (!activeMessageAgent || !messageContent) return;
    setIsSending(true);
    try {
      await api.sendAgentMessage(activeMessageAgent.id, {
        to_agent: activeMessageAgent.id,
        workflow_id: targetWorkflowId,
        message_type: messageType,
        content: messageContent,
      });
      setActiveMessageAgent(null);
      setMessageContent('');
      setTargetWorkflowId('');
      alert('Message dispatched to agent communication channel.');
    } catch (e) {
      alert(`Send message failed: ${e}`);
    } finally {
      setIsSending(false);
    }
  };

  const getStatusVariant = (state: string): BadgeVariant => {
    switch (state.toLowerCase()) {
      case 'busy':
        return 'running';
      case 'idle':
        return 'verified';
      case 'paused':
        return 'awaiting';
      case 'terminated':
        return 'failed';
      default:
        return 'neutral';
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-3 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <Bot className="w-4 h-4 text-sentinel-lime" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-sans">
              Agent Fleet Governance
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5 font-sans">
            Registered autonomous agent runtimes, specialized capabilities, and live execution leases
          </p>
        </div>

        <Button
          onClick={onRefresh}
          variant="outline"
          size="sm"
          title="Refresh Agents"
          aria-label="Refresh Agents"
          loading={loading}
          icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
        >
          <span>Refresh</span>
        </Button>
      </div>

      {/* Operational Agents Table */}
      <div className="bg-surface-card border border-surface-border rounded overflow-hidden">
        {loading && agents.length === 0 ? (
          <div className="p-12 text-center text-gray-400 font-mono text-xs">
            Loading agent registry...
          </div>
        ) : agents.length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-xs font-sans">
            No agents registered in runtime.
          </div>
        ) : (
          <Table>
            <Thead>
              <Tr>
                <Th className="w-8"></Th>
                <Th>Agent</Th>
                <Th>Role</Th>
                <Th>State</Th>
                <Th>Active Lease / Task</Th>
                <Th>Capabilities</Th>
                <Th className="text-right">Actions</Th>
              </Tr>
            </Thead>
            <Tbody>
              {agents.map((agent) => {
                const isSelected = selectedAgentId === agent.id;
                return (
                  <React.Fragment key={agent.id}>
                    <Tr
                      isInteractive
                      onClick={() => setSelectedAgentId(isSelected ? null : agent.id)}
                      className={isSelected ? 'bg-surface-hover/70' : ''}
                    >
                      <Td className="text-gray-500 pl-3.5 pr-0">
                        {isSelected ? (
                          <ChevronDown className="w-3.5 h-3.5 text-sentinel-lime" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5" />
                        )}
                      </Td>
                      <Td>
                        <div className="flex items-center gap-2.5">
                          <div className="w-6 h-6 rounded bg-surface-base border border-surface-border flex items-center justify-center text-sentinel-lime shrink-0">
                            <Cpu className="w-3 h-3" />
                          </div>
                          <div>
                            <div className="font-semibold text-gray-100 text-xs font-sans">
                              {agent.display_name}
                            </div>
                            <div className="text-[10px] font-mono text-gray-500">
                              {agent.id}
                            </div>
                          </div>
                        </div>
                      </Td>
                      <Td className="font-sans text-gray-300 text-xs">
                        {agent.role}
                      </Td>
                      <Td>
                        <Badge
                          variant={getStatusVariant(agent.state)}
                          size="xs"
                          statusDot
                          pulse={agent.state.toLowerCase() === 'busy'}
                        >
                          {agent.state}
                        </Badge>
                      </Td>
                      <Td mono>
                        {agent.current_task_id ? (
                          <span className="text-status-running font-medium">
                            task_{agent.current_task_id.slice(0, 8)}...
                          </span>
                        ) : (
                          <span className="text-gray-500">—</span>
                        )}
                      </Td>
                      <Td>
                        <div className="flex flex-wrap gap-1 max-w-xs">
                          {agent.capabilities.slice(0, 3).map((cap) => (
                            <span
                              key={cap}
                              className="text-[10px] font-mono px-1.5 py-0.2 bg-surface-base text-gray-300 rounded border border-surface-border"
                            >
                              {cap}
                            </span>
                          ))}
                          {agent.capabilities.length > 3 && (
                            <span className="text-[10px] font-mono text-gray-500">
                              +{agent.capabilities.length - 3}
                            </span>
                          )}
                        </div>
                      </Td>
                      <Td className="text-right">
                        <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                          {agent.state === 'Busy' && (
                            <Button
                              onClick={(e) => handlePause(agent.id, e)}
                              variant="secondary"
                              size="xs"
                              title="Pause Agent"
                              className="px-2"
                            >
                              <Pause className="w-3 h-3 text-amber-400" />
                            </Button>
                          )}
                          {agent.state === 'Paused' && (
                            <Button
                              onClick={(e) => handleResume(agent.id, e)}
                              variant="secondary"
                              size="xs"
                              title="Resume Agent"
                              className="px-2"
                            >
                              <Play className="w-3 h-3 text-emerald-400" />
                            </Button>
                          )}
                          {agent.state !== 'Terminated' && (
                            <Button
                              onClick={(e) => handleCancel(agent.id, e)}
                              variant="danger-ghost"
                              size="xs"
                              title="Terminate Agent"
                              className="px-2"
                            >
                              <Ban className="w-3 h-3 text-red-400" />
                            </Button>
                          )}
                          <Button
                            onClick={() => setActiveMessageAgent(agent)}
                            variant="outline"
                            size="xs"
                            icon={<MessageSquare className="w-3 h-3 text-sentinel-lime" />}
                            className="text-[11px]"
                          >
                            <span>Message</span>
                          </Button>
                        </div>
                      </Td>
                    </Tr>

                    {/* Expandable Inspector Row */}
                    {isSelected && (
                      <Tr className="bg-surface-base/60">
                        <Td colSpan={7} className="p-4 border-b border-surface-border">
                          <div className="space-y-3">
                            {/* Executive Summary Narrative */}
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                              <div className="p-2.5 bg-surface-card rounded border border-surface-border">
                                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider font-sans mb-1">
                                  Current State
                                </div>
                                <div className="text-xs text-gray-200 font-sans">
                                  {agent.state === 'Busy'
                                    ? 'Agent is actively executing a leased task graph node.'
                                    : agent.state === 'Paused'
                                    ? 'Agent execution lease is suspended by operator.'
                                    : agent.state === 'Terminated'
                                    ? 'Agent process has exited or was terminated.'
                                    : 'Agent is idle and ready to claim available tasks.'}
                                </div>
                              </div>

                              <div className="p-2.5 bg-surface-card rounded border border-surface-border">
                                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider font-sans mb-1">
                                  Assigned Scope
                                </div>
                                <div className="text-xs font-mono text-gray-200 truncate">
                                  {agent.current_task_id ? `Task ID: ${agent.current_task_id}` : 'No active lease'}
                                </div>
                                <div className="text-[11px] text-gray-400 font-sans mt-0.5">
                                  Role: {agent.role}
                                </div>
                              </div>

                              <div className="p-2.5 bg-surface-card rounded border border-surface-border">
                                <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider font-sans mb-1">
                                  Capabilities ({agent.capabilities.length})
                                </div>
                                <div className="flex flex-wrap gap-1">
                                  {agent.capabilities.map((c) => (
                                    <span
                                      key={c}
                                      className="text-[10px] font-mono px-1.5 py-0.2 bg-surface-base text-gray-300 rounded border border-surface-border"
                                    >
                                      {c}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>

                            {/* Quick Dispatch Bar */}
                            <div className="flex items-center justify-between pt-1">
                              <span className="text-[11px] text-gray-500 font-mono">
                                Registered runtime agent #{agent.id}
                              </span>
                              <Button
                                onClick={() => setActiveMessageAgent(agent)}
                                variant="lime-outline"
                                size="xs"
                                icon={<MessageSquare className="w-3 h-3" />}
                              >
                                Send Direct Directive...
                              </Button>
                            </div>
                          </div>
                        </Td>
                      </Tr>
                    )}
                  </React.Fragment>
                );
              })}
            </Tbody>
          </Table>
        )}
      </div>

      {/* Direct Message Modal */}
      {activeMessageAgent && (
        <Modal
          isOpen={Boolean(activeMessageAgent)}
          onClose={() => setActiveMessageAgent(null)}
          title={
            <div className="flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-sentinel-lime" />
              <span className="font-sans font-bold text-gray-100">
                Message to {activeMessageAgent.display_name}
              </span>
            </div>
          }
          subtitle={`Agent ID: ${activeMessageAgent.id}`}
          maxWidth="md"
          footer={
            <div className="w-full flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setActiveMessageAgent(null)}
              >
                Cancel
              </Button>
              <Button
                disabled={isSending || !messageContent}
                onClick={handleSendMessage}
                variant="primary"
                size="sm"
                loading={isSending}
                icon={<Send className="w-3.5 h-3.5" />}
              >
                Send Message
              </Button>
            </div>
          }
        >
          <div className="space-y-3">
            <Input
              label="Workflow Context (optional)"
              placeholder="Workflow ID..."
              value={targetWorkflowId}
              onChange={(e) => setTargetWorkflowId(e.target.value)}
              mono
            />

            <Select
              label="Message Type"
              value={messageType}
              onChange={(e) => setMessageType(e.target.value)}
              mono
            >
              <option value="Directive">Directive</option>
              <option value="Query">Query</option>
              <option value="Feedback">Feedback</option>
              <option value="Handoff">Handoff</option>
            </Select>

            <Textarea
              label="Instruction / Payload"
              rows={4}
              placeholder="Enter direct operator guidance or data payload..."
              value={messageContent}
              onChange={(e) => setMessageContent(e.target.value)}
              mono
            />
          </div>
        </Modal>
      )}
    </div>
  );
};

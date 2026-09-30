import React, { useState, useEffect, useRef } from 'react';
import { EventRecord } from '../types';
import { api } from '../services/api';
import { eventStream, ConnectionState } from '../services/sse';
import {
  Radio,
  Search,
  Filter,
  ArrowDownCircle,
  Clock,
  ChevronDown,
  ChevronRight,
  Layers,
  Bot,
  Zap,
  MessageSquare,
} from 'lucide-react';
import { Button, Badge, BadgeVariant, Input, Select, StatusDot } from './ui';

interface LiveTimelineViewProps {
  onSelectWorkflow: (id: string) => void;
}

export const LiveTimelineView: React.FC<LiveTimelineViewProps> = ({ onSelectWorkflow }) => {
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [connectionState, setConnectionState] = useState<ConnectionState>(
    eventStream.getConnectionState()
  );
  const [cursor, setCursor] = useState<number>(eventStream.getCursor());
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedType, setSelectedType] = useState<string>('ALL');
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  const endRef = useRef<HTMLDivElement>(null);

  // Load initial historical events
  useEffect(() => {
    api
      .listEvents({ limit: 100 })
      .then((initialEvents) => {
        setEvents(initialEvents);
      })
      .catch((err) => console.error('Failed to load initial events:', err));
  }, []);

  // Listen to live SSE events and connection changes
  useEffect(() => {
    const unsubState = eventStream.onStateChange((state, cur) => {
      setConnectionState(state);
      setCursor(cur);
    });

    const unsubEvents = eventStream.subscribeAll((event) => {
      setEvents((prev) => {
        // Prevent duplicate sequences
        if (prev.some((e) => e.sequence === event.sequence)) {
          return prev;
        }
        return [...prev, event];
      });
    });

    return () => {
      unsubState();
      unsubEvents();
    };
  }, []);

  // Auto scroll to bottom
  useEffect(() => {
    if (autoScroll && endRef.current) {
      endRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events, autoScroll]);

  const toggleExpand = (id: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const getEventBadgeVariant = (type: string): BadgeVariant => {
    const t = type.toLowerCase();
    if (t.includes('mission')) return 'lime';
    if (t.includes('stagnation') || t.includes('budget') || t.includes('approval'))
      return 'awaiting';
    if (t.includes('verification')) return 'verified';
    if (t.includes('recovery') || t.includes('failed')) return 'failed';
    if (t.includes('task')) return 'running';
    if (t.includes('agent')) return 'neutral';
    return 'default';
  };

  const eventTypes = ['ALL', ...Array.from(new Set(events.map((e) => e.event_type)))];

  const filteredEvents = events.filter((e) => {
    const matchesType = selectedType === 'ALL' || e.event_type === selectedType;
    const matchesSearch =
      searchQuery === '' ||
      e.event_type.toLowerCase().includes(searchQuery.toLowerCase()) ||
      JSON.stringify(e.payload).toLowerCase().includes(searchQuery.toLowerCase()) ||
      (e.workflow_id && e.workflow_id.includes(searchQuery)) ||
      (e.task_id && e.task_id.includes(searchQuery));
    return matchesType && matchesSearch;
  });

  const dotStatus =
    connectionState === 'connected'
      ? 'verified'
      : connectionState === 'reconnecting'
      ? 'awaiting'
      : 'failed';

  return (
    <div className="space-y-4 pb-12">
      {/* Header Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-surface-border">
        <div>
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-sentinel-lime animate-pulse" />
            <h1 className="text-base sm:text-lg font-bold text-gray-100 tracking-tight font-mono uppercase">
              Live Audit & Execution Timeline
            </h1>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            Authoritative SSE event stream with sequence cursor tracking and durable catch-up
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <div
            className="flex items-center gap-2 bg-surface-card px-2.5 py-1 rounded border border-surface-border text-xs font-mono"
            title={`Status: ${connectionState}, sequence #${cursor}`}
          >
            <StatusDot
              status={dotStatus}
              pulse={connectionState === 'connected' || connectionState === 'reconnecting'}
              size="xs"
            />
            <span className="text-gray-300 capitalize text-[11px]">{connectionState}</span>
            <span className="text-surface-border-bold">|</span>
            <span className="text-gray-400 text-[11px]">seq #{cursor}</span>
          </div>

          <Button
            onClick={() => setAutoScroll(!autoScroll)}
            variant={autoScroll ? 'lime-outline' : 'secondary'}
            size="xs"
            icon={<ArrowDownCircle className="w-3.5 h-3.5" />}
          >
            Auto-Scroll: {autoScroll ? 'ON' : 'OFF'}
          </Button>
        </div>
      </div>

      {/* Filter and Search */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-surface-card border border-surface-border p-2.5 rounded">
        <div className="w-full sm:w-72">
          <Input
            placeholder="Search payload, task, workflow..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            leftIcon={<Search className="w-3.5 h-3.5" />}
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <Filter className="w-3.5 h-3.5 text-gray-400 shrink-0" />
          <Select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value)}
            mono
            className="text-xs"
          >
            {eventTypes.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Select>
          <span className="text-xs text-gray-500 font-mono whitespace-nowrap">
            ({filteredEvents.length} events)
          </span>
        </div>
      </div>

      {/* Event Stream Log Box */}
      <div className="bg-surface-base border border-surface-border rounded overflow-hidden font-mono divide-y divide-surface-border">
        {filteredEvents.length === 0 ? (
          <div className="p-12 text-center text-gray-500 text-xs">
            No events match current filter or waiting for new events...
          </div>
        ) : (
          filteredEvents.map((evt) => {
            const isExpanded = expandedEvents.has(evt.event_id);
            return (
              <div
                key={evt.sequence}
                className="p-3 hover:bg-surface-hover/30 transition-colors"
              >
                <div
                  className="flex items-center justify-between text-xs cursor-pointer select-none"
                  onClick={() => toggleExpand(evt.event_id)}
                >
                  <div className="flex items-center gap-2.5 flex-wrap min-w-0">
                    <span className="text-gray-500 text-[11px] w-12 text-right shrink-0">
                      #{evt.sequence}
                    </span>

                    <Badge
                      variant={getEventBadgeVariant(evt.event_type)}
                      size="xs"
                    >
                      {evt.event_type}
                    </Badge>

                    {evt.workflow_id && (
                      <span
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectWorkflow(evt.workflow_id!);
                        }}
                        className="text-[11px] text-sentinel-lime hover:underline flex items-center gap-1 cursor-pointer"
                      >
                        <Layers className="w-3 h-3" />
                        <span>wf:{evt.workflow_id.slice(0, 6)}</span>
                      </span>
                    )}

                    {evt.agent_id && (
                      <span className="text-[11px] text-gray-400 flex items-center gap-1">
                        <Bot className="w-3 h-3" />
                        <span>agent:{evt.agent_id.slice(0, 6)}</span>
                      </span>
                    )}

                    {evt.task_id && (
                      <span className="text-[11px] text-sky-400 flex items-center gap-1">
                        <Zap className="w-3 h-3" />
                        <span>task:{evt.task_id.slice(0, 6)}</span>
                      </span>
                    )}

                    {evt.event_type === 'message_sent' && evt.payload && (
                      <span className="text-[11px] text-gray-300 font-sans italic truncate max-w-sm flex items-center gap-1">
                        <MessageSquare className="w-3 h-3 text-gray-400 shrink-0" />
                        <span className="truncate">
                          {(evt.payload as any).role ? `[${String((evt.payload as any).role)}] ` : ''}
                          {String((evt.payload as any).content || 'Collaboration message')}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-3 text-gray-500 text-[11px] shrink-0 ml-2">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      <span>{new Date(evt.timestamp).toLocaleTimeString()}</span>
                    </div>
                    {isExpanded ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                  </div>
                </div>

                {/* Expanded JSON payload view */}
                {isExpanded && (
                  <div className="mt-2.5 ml-14 p-3 bg-surface-card rounded border border-surface-border text-[11px] text-gray-300 overflow-x-auto">
                    <pre>{JSON.stringify(evt.payload, null, 2)}</pre>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
};

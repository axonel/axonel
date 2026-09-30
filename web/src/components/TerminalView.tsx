import React, { useState, useEffect, useRef } from 'react';
import { TaskTerminal } from '../types';
import { api } from '../services/api';
import { Terminal, Copy, Check } from 'lucide-react';
import { Button, Badge } from './ui';

interface TerminalViewProps {
  taskId: string;
  isTaskActive?: boolean;
}

export const TerminalView: React.FC<TerminalViewProps> = ({ taskId, isTaskActive = false }) => {
  const [terminal, setTerminal] = useState<TaskTerminal | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [copied, setCopied] = useState<boolean>(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const fetchTerminal = async () => {
    try {
      const data = await api.getTaskTerminal(taskId);
      setTerminal(data);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch terminal output');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTerminal();

    // Poll while active or until completed
    let interval: any = null;
    if (isTaskActive || (terminal && !terminal.is_completed)) {
      interval = setInterval(fetchTerminal, 1500);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [taskId, isTaskActive, terminal?.is_completed]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [terminal?.lines, autoScroll]);

  const handleCopy = () => {
    if (!terminal?.lines) return;
    const text = terminal.lines.map((l) => `[${l.stream.toUpperCase()}] ${l.line}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="bg-surface-base border border-surface-border rounded overflow-hidden flex flex-col h-full font-mono text-xs">
      {/* Terminal Bar */}
      <div className="flex items-center justify-between px-3.5 py-2 bg-surface-header/60 border-b border-surface-border select-none">
        <div className="flex items-center gap-2.5">
          <div className="flex gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500/80 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500/80 inline-block" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-500/80 inline-block" />
          </div>
          <span className="text-gray-300 font-semibold flex items-center gap-1.5 ml-1">
            <Terminal className="w-3.5 h-3.5 text-sentinel-lime" />
            <span>Task Terminal</span>
          </span>
          <Badge variant="lime" size="xs">
            Redaction Active
          </Badge>
        </div>

        <div className="flex items-center gap-3 font-sans">
          {terminal && (
            <div>
              {terminal.is_completed ? (
                terminal.exit_code === 0 ? (
                  <Badge variant="verified" size="xs" statusDot>
                    Exit 0 (Success)
                  </Badge>
                ) : (
                  <Badge variant="failed" size="xs" statusDot>
                    Exit {terminal.exit_code ?? 1} (Failed)
                  </Badge>
                )
              ) : (
                <Badge variant="running" size="xs" statusDot pulse>
                  Executing...
                </Badge>
              )}
            </div>
          )}

          <label className="flex items-center gap-1 text-gray-400 cursor-pointer hover:text-gray-200 select-none">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="rounded bg-surface-base border-surface-border text-sentinel-lime focus:ring-sentinel-lime text-xs"
            />
            <span className="text-[10px] font-mono">Auto-scroll</span>
          </label>

          <Button
            onClick={handleCopy}
            variant="outline"
            size="xs"
            title="Copy Output"
            className="px-2 py-0.5"
            icon={
              copied ? (
                <Check className="w-3 h-3 text-emerald-400" />
              ) : (
                <Copy className="w-3 h-3 text-gray-400" />
              )
            }
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      </div>

      {/* Terminal Buffer Content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3.5 space-y-0.5 text-xs leading-relaxed select-text bg-surface-base"
      >
        {loading && !terminal ? (
          <div className="text-gray-500 py-6 text-center font-mono">
            Connecting to task execution stream...
          </div>
        ) : error ? (
          <div className="text-red-400 py-4 font-mono text-center">{error}</div>
        ) : !terminal?.lines || terminal.lines.length === 0 ? (
          <div className="text-gray-500 py-6 text-center font-mono">
            No terminal output recorded for this task yet.
          </div>
        ) : (
          terminal.lines.map((line, idx) => {
            const isStderr = line.stream === 'stderr';
            const isSystem = line.stream === 'system';

            let tagColor = 'text-sky-400 bg-sky-950/30 border-sky-800/40';
            let textColor = 'text-gray-200';

            if (isStderr) {
              tagColor = 'text-red-400 bg-red-950/30 border-red-800/40';
              textColor = 'text-red-300';
            } else if (isSystem) {
              tagColor = 'text-gray-400 bg-surface-card border-surface-border';
              textColor = 'text-gray-400';
            }

            const timeStr = new Date(line.timestamp).toLocaleTimeString();

            return (
              <div
                key={idx}
                className="flex items-start gap-2 hover:bg-surface-hover/20 py-0.5 px-1 rounded transition-colors"
              >
                <span className="text-gray-600 text-[10px] select-none font-mono shrink-0">
                  {timeStr}
                </span>
                <span
                  className={`px-1 py-0.2 text-[9px] uppercase font-semibold rounded border shrink-0 select-none font-mono ${tagColor}`}
                >
                  {line.stream}
                </span>
                <span className={`flex-1 break-all whitespace-pre-wrap font-mono ${textColor}`}>
                  {line.line}
                </span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

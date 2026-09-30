import React, { useState } from 'react';
import { GitDiffResponse } from '../types';
import { RefreshCw, CheckCircle2, FileText } from 'lucide-react';
import { Button, Input } from './ui';

interface DiffViewerProps {
  diffData?: GitDiffResponse | null;
  diff?: GitDiffResponse | null;
  rawDiff?: string | null;
  loading?: boolean;
  onRefresh?: () => void;
  onCommit?: (message: string) => Promise<void>;
}

export const DiffViewer: React.FC<DiffViewerProps> = ({
  diffData: propDiffData,
  diff: aliasDiff,
  rawDiff,
  loading = false,
  onRefresh,
  onCommit,
}) => {
  const diffData = propDiffData || aliasDiff;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSuccess, setCommitSuccess] = useState(false);

  const diffText = diffData?.diff || rawDiff || '';
  const filesChanged = diffData?.files_changed || [];
  const insertions = diffData?.insertions ?? 0;
  const deletions = diffData?.deletions ?? 0;

  // Split diff into per-file chunks
  const fileChunks: { filename: string; content: string[] }[] = [];
  const lines = diffText.split('\n');
  let currentFile = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git')) {
      if (currentFile && currentLines.length > 0) {
        fileChunks.push({ filename: currentFile, content: currentLines });
      }
      currentLines = [line];
      const match = line.match(/b\/(.+)$/);
      currentFile = match ? match[1] : 'unknown';
    } else {
      currentLines.push(line);
    }
  }
  if (currentFile && currentLines.length > 0) {
    fileChunks.push({ filename: currentFile, content: currentLines });
  }

  // Filter if file selected
  const activeChunks = selectedFile
    ? fileChunks.filter((c) => c.filename === selectedFile)
    : fileChunks;

  const handleCommitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!commitMessage.trim() || !onCommit) return;

    try {
      setCommitting(true);
      setCommitError(null);
      await onCommit(commitMessage.trim());
      setCommitSuccess(true);
      setCommitMessage('');
      setTimeout(() => setCommitSuccess(false), 3000);
    } catch (err: any) {
      setCommitError(err.message || 'Failed to commit changes');
    } finally {
      setCommitting(false);
    }
  };

  return (
    <div className="bg-surface-card border border-surface-border rounded overflow-hidden flex flex-col h-full font-mono text-xs">
      {/* Diff Toolbar */}
      <div className="flex flex-wrap items-center justify-between px-4 py-2.5 border-b border-surface-border bg-surface-header/60 gap-2 select-none">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-300">
            <span className="text-gray-400">Files:</span>
            <span className="px-1.5 py-0.2 bg-surface-base text-gray-200 border border-surface-border rounded text-[11px]">
              {filesChanged.length || fileChunks.length}
            </span>
          </div>
          {(insertions > 0 || deletions > 0) && (
            <div className="flex items-center gap-2 text-xs font-mono">
              <span className="text-emerald-400 font-semibold">+{insertions}</span>
              <span className="text-red-400 font-semibold">-{deletions}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onRefresh && (
            <Button
              onClick={onRefresh}
              disabled={loading}
              variant="outline"
              size="xs"
              title="Refresh Diff"
              aria-label="Refresh Diff"
              loading={loading}
              icon={<RefreshCw className="w-3.5 h-3.5 text-gray-400" />}
            />
          )}
        </div>
      </div>

      {/* File filter tabs if multiple files */}
      {fileChunks.length > 1 && (
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-surface-border bg-surface-base overflow-x-auto text-xs">
          <button
            onClick={() => setSelectedFile(null)}
            className={`px-2 py-0.5 rounded text-[11px] font-mono transition-colors select-none ${
              selectedFile === null
                ? 'bg-surface-card text-sentinel-lime border border-surface-border font-semibold'
                : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
            }`}
          >
            All Files ({fileChunks.length})
          </button>
          {fileChunks.map((chunk) => (
            <button
              key={chunk.filename}
              onClick={() => setSelectedFile(chunk.filename)}
              className={`px-2 py-0.5 rounded font-mono text-[11px] truncate max-w-[200px] transition-colors select-none ${
                selectedFile === chunk.filename
                  ? 'bg-surface-card text-sentinel-lime border border-surface-border font-semibold'
                  : 'text-gray-400 hover:text-gray-200 hover:bg-surface-hover/50 border border-transparent'
              }`}
            >
              {chunk.filename}
            </button>
          ))}
        </div>
      )}

      {/* Diff Content Body */}
      <div className="flex-1 overflow-y-auto font-mono text-xs p-3.5 space-y-3 bg-surface-base">
        {loading ? (
          <div className="py-12 text-center text-gray-500 font-mono">
            Loading git diff inspection...
          </div>
        ) : !diffText.trim() ? (
          <div className="py-12 text-center text-gray-400 font-sans">
            <CheckCircle2 className="w-7 h-7 text-emerald-400/80 mx-auto mb-2" />
            <p className="text-gray-200 font-medium text-xs">Working tree is clean</p>
            <p className="text-[11px] text-gray-500 mt-0.5">
              No unstaged or staged modifications in this workspace.
            </p>
          </div>
        ) : (
          activeChunks.map((chunk) => (
            <div
              key={chunk.filename}
              className="border border-surface-border rounded overflow-hidden bg-surface-card"
            >
              <div className="px-3 py-1.5 bg-surface-header/70 border-b border-surface-border flex items-center justify-between">
                <span className="font-semibold text-gray-200 flex items-center gap-2 text-[11px]">
                  <FileText className="w-3.5 h-3.5 text-gray-400" />
                  <span>{chunk.filename}</span>
                </span>
              </div>
              <div className="overflow-x-auto p-1.5 leading-snug">
                {chunk.content.map((line, idx) => {
                  let lineClass = 'text-gray-400';
                  let bgClass = '';

                  if (line.startsWith('+') && !line.startsWith('+++')) {
                    lineClass = 'text-emerald-300';
                    bgClass = 'bg-emerald-950/25';
                  } else if (line.startsWith('-') && !line.startsWith('---')) {
                    lineClass = 'text-red-300';
                    bgClass = 'bg-red-950/25';
                  } else if (line.startsWith('@@')) {
                    lineClass = 'text-sky-400 font-bold';
                    bgClass = 'bg-sky-950/20';
                  } else if (line.startsWith('diff --git') || line.startsWith('index')) {
                    lineClass = 'text-gray-500 font-semibold';
                  }

                  return (
                    <div
                      key={idx}
                      className={`whitespace-pre font-mono px-2 py-0.2 rounded-xs ${bgClass} ${lineClass}`}
                    >
                      {line || ' '}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Commit Bar if commit action enabled and diff exists */}
      {onCommit && diffText.trim().length > 0 && (
        <form
          onSubmit={handleCommitSubmit}
          className="p-3 border-t border-surface-border bg-surface-header/60 flex items-center gap-2"
        >
          <div className="flex-1">
            <Input
              placeholder="Commit message (e.g. feat: implement rate limiting algorithm)"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              disabled={committing}
            />
          </div>
          <Button
            type="submit"
            disabled={committing || !commitMessage.trim()}
            variant="primary"
            size="sm"
            loading={committing}
          >
            Commit Changes
          </Button>
          {commitSuccess && <span className="text-xs text-emerald-400 font-mono">Committed!</span>}
          {commitError && <span className="text-xs text-red-400 font-mono">{commitError}</span>}
        </form>
      )}
    </div>
  );
};

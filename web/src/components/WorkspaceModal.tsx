import React, { useState, useEffect } from 'react';
import { Workspace } from '../types';
import { api } from '../services/api';
import { FolderGit2, Plus, Check, GitBranch, Shield, ArrowLeft } from 'lucide-react';
import { Modal, Button, Input, Badge } from './ui';

interface WorkspaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  activeWorkspaceId?: string | null;
  onSelectWorkspace: (workspace: Workspace) => void;
}

export const WorkspaceModal: React.FC<WorkspaceModalProps> = ({
  isOpen,
  onClose,
  activeWorkspaceId,
  onSelectWorkspace,
}) => {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // New Workspace form state
  const [showCreateForm, setShowCreateForm] = useState<boolean>(false);
  const [newName, setNewName] = useState('');
  const [newPath, setNewPath] = useState('');
  const [newDescription, setNewDescription] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadWorkspaces();
    }
  }, [isOpen]);

  const loadWorkspaces = async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await api.listWorkspaces();
      setWorkspaces(list);
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to load workspaces');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim() || !newPath.trim()) return;

    try {
      setCreating(true);
      setError(null);
      const created = await api.createWorkspace({
        name: newName.trim(),
        canonical_path: newPath.trim(),
        description: newDescription.trim() || undefined,
        is_default: workspaces.length === 0,
      });
      setWorkspaces((prev) => [...prev, created]);
      onSelectWorkspace(created);
      setShowCreateForm(false);
      setNewName('');
      setNewPath('');
      setNewDescription('');
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('Failed to create workspace');
      }
    } finally {
      setCreating(false);
    }
  };

  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <FolderGit2 className="w-4 h-4 text-sentinel-lime" />
          <span>Project Workspaces</span>
        </div>
      }
      subtitle="Confined directory roots with Git worktree isolation and path containment"
      maxWidth="2xl"
      footer={
        showCreateForm ? (
          <div className="w-full flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowCreateForm(false)}
              className="flex items-center gap-1.5"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back to Workspaces</span>
            </Button>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setShowCreateForm(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                loading={creating}
                disabled={creating || !newName.trim() || !newPath.trim()}
                onClick={handleCreate}
              >
                Register Workspace
              </Button>
            </div>
          </div>
        ) : (
          <div className="w-full flex items-center justify-between">
            <span className="text-[11px] text-gray-500 font-mono flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-sentinel-lime" />
              <span>Security: Path confinement and secret redactor enforced</span>
            </span>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={onClose}
              >
                Close
              </Button>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={() => setShowCreateForm(true)}
                className="flex items-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Register Workspace</span>
              </Button>
            </div>
          </div>
        )
      }
    >
      <div className="space-y-4">
        {error && (
          <div className="p-3 bg-rose-950/30 border border-rose-800/40 rounded text-xs text-red-300 font-mono">
            {error}
          </div>
        )}

        {!showCreateForm ? (
          <>
            <div className="flex justify-between items-center pb-2 border-b border-surface-border">
              <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider font-mono">
                Registered Workspaces ({workspaces.length})
              </span>
            </div>

            {loading ? (
              <div className="py-8 text-center text-xs text-gray-500 font-mono">Loading workspaces...</div>
            ) : workspaces.length === 0 ? (
              <div className="py-8 text-center bg-surface-base rounded border border-dashed border-surface-border p-6">
                <p className="text-gray-400 text-xs mb-3 font-mono">No workspaces registered yet.</p>
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => setShowCreateForm(true)}
                >
                  Register First Workspace
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                {workspaces.map((ws) => {
                  const isActive = ws.id === activeWorkspaceId;
                  const branch = ws.vcs?.branch;
                  const headSha = ws.vcs?.head_sha ? ws.vcs.head_sha.substring(0, 7) : null;
                  const isDirty = ws.vcs?.is_dirty;

                  return (
                    <div
                      key={ws.id}
                      onClick={() => {
                        onSelectWorkspace(ws);
                        onClose();
                      }}
                      className={`p-3.5 rounded border transition cursor-pointer flex items-center justify-between gap-3 ${
                        isActive
                          ? 'bg-sentinel-lime/5 border-sentinel-lime/40 ring-1 ring-sentinel-lime/20'
                          : 'bg-surface-base border-surface-border hover:border-surface-border-strong hover:bg-surface-raised'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-gray-100 text-xs truncate">{ws.name}</span>
                          {isActive && (
                            <Badge variant="lime" size="xs">
                              Active
                            </Badge>
                          )}
                          {branch && (
                            <span className="px-1.5 py-0.5 text-[11px] bg-surface-card text-gray-300 font-mono rounded flex items-center gap-1 border border-surface-border">
                              <GitBranch className="w-3 h-3 text-emerald-400" />
                              <span>{branch}</span>
                              {headSha && <span className="text-gray-500">@{headSha}</span>}
                              {isDirty && <span className="text-amber-400 font-bold" title="Uncommitted changes">*</span>}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-gray-400 font-mono truncate mt-1">{ws.canonical_path}</p>
                      </div>
                      <div className="text-xs shrink-0">
                        {isActive ? (
                          <span className="text-sentinel-lime font-mono text-[11px] font-medium flex items-center gap-1">
                            <Check className="w-3.5 h-3.5" />
                            <span>Selected</span>
                          </span>
                        ) : (
                          <Button variant="ghost" size="xs" className="text-gray-400 hover:text-white">
                            Select
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <form onSubmit={handleCreate} className="space-y-4">
            <Input
              label="Workspace Name"
              required
              placeholder="e.g. token-limiter"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />

            <Input
              label="Absolute Canonical Path"
              required
              placeholder="e.g. /home/user/Projects/token-limiter"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              mono
              helperText="Sentinel strictly confines file reads, writes, and shell execution inside this directory root."
            />

            <Input
              label="Description (Optional)"
              placeholder="e.g. Rate limiter crate for Sentinel core"
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
            />
          </form>
        )}
      </div>
    </Modal>
  );
};

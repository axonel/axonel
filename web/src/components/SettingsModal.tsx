import React, { useState, useEffect } from 'react';
import { api } from '../services/api';
import { SystemStatus, AuthStatus } from '../types';
import { CheckCircle2, Sliders, Shield, Key, Server } from 'lucide-react';
import { Modal, Button, Input, Select, StatusDot, Badge } from './ui';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onTokenUpdated: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  isOpen,
  onClose,
  onTokenUpdated,
}) => {
  const [token, setToken] = useState(api.getAuthToken());
  const [provider, setProvider] = useState(
    () => localStorage.getItem('sentinel_default_provider') || localStorage.getItem('plexis_default_provider') || 'mock'
  );
  const [openaiKey, setOpenaiKey] = useState(
    () => localStorage.getItem('sentinel_openai_key') || localStorage.getItem('plexis_openai_key') || ''
  );
  const [geminiKey, setGeminiKey] = useState(
    () => localStorage.getItem('sentinel_gemini_key') || localStorage.getItem('plexis_gemini_key') || ''
  );
  const [anthropicKey, setAnthropicKey] = useState(
    () => localStorage.getItem('sentinel_anthropic_key') || localStorage.getItem('plexis_anthropic_key') || ''
  );
  const [ollamaUrl, setOllamaUrl] = useState(
    () => localStorage.getItem('sentinel_ollama_url') || localStorage.getItem('plexis_ollama_url') || 'http://localhost:11434'
  );
  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setToken(api.getAuthToken());
      setProvider(
        localStorage.getItem('sentinel_default_provider') || localStorage.getItem('plexis_default_provider') || 'mock'
      );
      setOpenaiKey(
        localStorage.getItem('sentinel_openai_key') || localStorage.getItem('plexis_openai_key') || ''
      );
      setGeminiKey(
        localStorage.getItem('sentinel_gemini_key') || localStorage.getItem('plexis_gemini_key') || ''
      );
      setAnthropicKey(
        localStorage.getItem('sentinel_anthropic_key') || localStorage.getItem('plexis_anthropic_key') || ''
      );
      setOllamaUrl(
        localStorage.getItem('sentinel_ollama_url') || localStorage.getItem('plexis_ollama_url') || 'http://localhost:11434'
      );
      api.getSystemStatus().then(setSystemStatus).catch(() => null);
      api.getAuthStatus().then(setAuthStatus).catch(() => null);
      setSaved(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSave = (e: React.FormEvent) => {
    e.preventDefault();
    api.setAuthToken(token.trim());
    localStorage.setItem('sentinel_default_provider', provider);
    localStorage.setItem('plexis_default_provider', provider);
    localStorage.setItem('sentinel_openai_key', openaiKey.trim());
    localStorage.setItem('plexis_openai_key', openaiKey.trim());
    localStorage.setItem('sentinel_gemini_key', geminiKey.trim());
    localStorage.setItem('plexis_gemini_key', geminiKey.trim());
    localStorage.setItem('sentinel_anthropic_key', anthropicKey.trim());
    localStorage.setItem('plexis_anthropic_key', anthropicKey.trim());
    localStorage.setItem('sentinel_ollama_url', ollamaUrl.trim());
    localStorage.setItem('plexis_ollama_url', ollamaUrl.trim());
    setSaved(true);
    onTokenUpdated();
    setTimeout(() => {
      onClose();
    }, 800);
  };

  const formatUptime = (secs?: number | null): string => {
    if (secs === undefined || secs === null || isNaN(secs)) return '—';
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    if (mins < 60) return `${mins}m ${remSecs}s`;
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m`;
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        <div className="flex items-center gap-2">
          <Sliders className="w-4 h-4 text-sentinel-lime" />
          <span className="font-sans font-bold text-gray-100">Control Plane Settings</span>
        </div>
      }
      subtitle="Daemon bearer token, LLM credentials, and runtime node health"
      maxWidth="lg"
      footer={
        <div className="w-full flex items-center justify-between">
          <div className="text-[11px] text-gray-500 font-sans">
            {saved ? (
              <span className="text-emerald-400 flex items-center gap-1.5 font-medium">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Settings saved
              </span>
            ) : (
              'Credentials stored hermetically in local browser state'
            )}
          </div>
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
              onClick={handleSave}
            >
              Save Configuration
            </Button>
          </div>
        </div>
      }
    >
      <form onSubmit={handleSave} className="space-y-5">
        {/* Section 1: Control Plane Authentication */}
        <div className="space-y-3">
          <div className="flex items-center justify-between pb-1.5 border-b border-surface-border">
            <div className="flex items-center gap-2">
              <Shield className="w-3.5 h-3.5 text-sentinel-lime" />
              <h3 className="text-xs font-semibold text-gray-200 uppercase tracking-wider font-sans">
                Control Plane Authentication
              </h3>
            </div>
            {authStatus && (
              <Badge
                variant={authStatus.authenticated ? 'verified' : authStatus.auth_required ? 'awaiting' : 'neutral'}
                size="xs"
              >
                {authStatus.authenticated
                  ? 'Authenticated'
                  : authStatus.auth_required
                  ? 'Auth Required'
                  : 'Open (Loopback)'}
              </Badge>
            )}
          </div>

          <Input
            label="Bearer Authentication Token"
            type="password"
            placeholder="SENTINEL_AUTH_TOKEN value..."
            value={token}
            onChange={(e) => setToken(e.target.value)}
            mono
            helperText={
              authStatus?.auth_required
                ? 'Authentication is required by this Sentinel daemon.'
                : 'Local loopback authentication is optional. Set token if daemon is protected.'
            }
          />
        </div>

        {/* Section 2: LLM Inference Defaults */}
        <div className="space-y-3 pt-2">
          <div className="flex items-center gap-2 pb-1.5 border-b border-surface-border">
            <Key className="w-3.5 h-3.5 text-sentinel-lime" />
            <h3 className="text-xs font-semibold text-gray-200 uppercase tracking-wider font-sans">
              LLM Inference Defaults
            </h3>
          </div>

          <Select
            label="Default LLM Inference Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            mono
          >
            <option value="mock">Local Deterministic Mock (Testing / Offline)</option>
            <option value="openai">OpenAI (GPT-4o, o1, o3-mini)</option>
            <option value="gemini">Google Gemini (Gemini 1.5 Pro, 2.0 Flash)</option>
            <option value="anthropic">Anthropic Claude (Claude 3.5 Sonnet)</option>
            <option value="ollama">Ollama (Local Hermetic LLM)</option>
          </Select>

          {provider === 'openai' && (
            <Input
              label="OpenAI API Key (OPENAI_API_KEY)"
              type="password"
              placeholder="sk-proj-..."
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              mono
            />
          )}

          {provider === 'gemini' && (
            <Input
              label="Google Gemini API Key (GEMINI_API_KEY)"
              type="password"
              placeholder="AIzaSy..."
              value={geminiKey}
              onChange={(e) => setGeminiKey(e.target.value)}
              mono
            />
          )}

          {provider === 'anthropic' && (
            <Input
              label="Anthropic API Key (ANTHROPIC_API_KEY)"
              type="password"
              placeholder="sk-ant-..."
              value={anthropicKey}
              onChange={(e) => setAnthropicKey(e.target.value)}
              mono
            />
          )}

          {provider === 'ollama' && (
            <Input
              label="Ollama Base URL (OLLAMA_HOST)"
              type="text"
              placeholder="http://localhost:11434"
              value={ollamaUrl}
              onChange={(e) => setOllamaUrl(e.target.value)}
              mono
            />
          )}
        </div>

        {/* Section 3: Runtime Node Status */}
        {systemStatus && (
          <div className="space-y-3 pt-2">
            <div className="flex items-center justify-between pb-1.5 border-b border-surface-border">
              <div className="flex items-center gap-2">
                <Server className="w-3.5 h-3.5 text-sentinel-lime" />
                <h3 className="text-xs font-semibold text-gray-200 uppercase tracking-wider font-sans">
                  Runtime Node Status
                </h3>
              </div>
              <div className="flex items-center gap-1.5 text-xs">
                <StatusDot status="active" />
                <span className="text-emerald-400 font-medium capitalize font-mono">{systemStatus.status}</span>
              </div>
            </div>

            <div className="p-3 bg-surface-base rounded border border-surface-border text-xs font-mono">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-gray-400">
                <div>
                  <span className="text-[10px] text-gray-500 block uppercase font-sans font-medium">Version</span>
                  <span className="text-gray-200 font-mono">{systemStatus.version || 'v0.1.1'}</span>
                </div>
                <div>
                  <span className="text-[10px] text-gray-500 block uppercase font-sans font-medium">Uptime</span>
                  <span className="text-gray-200 font-mono">{formatUptime(systemStatus.uptime_secs)}</span>
                </div>
                <div>
                  <span className="text-[10px] text-gray-500 block uppercase font-sans font-medium">Agents</span>
                  <span className="text-gray-200 font-mono">{systemStatus.agents_count ?? 0}</span>
                </div>
                <div>
                  <span className="text-[10px] text-gray-500 block uppercase font-sans font-medium">Tools</span>
                  <span className="text-gray-200 font-mono">{systemStatus.tools_count ?? 0}</span>
                </div>
              </div>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
};

'use client';

import { useState, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'anthropic/claude-haiku-4',
  anthropic: 'claude-haiku-4-5-20251001',
  openai: 'gpt-4o-mini',
  'claude-code': 'opus',
  codex: 'gpt-5.5',
};

interface ProviderOption {
  id: string;
  label: string;
  local: boolean;
  available: boolean;
  requires_api_key: boolean;
  models: string[];
}

const FALLBACK_PROVIDERS: ProviderOption[] = [
  { id: 'openrouter', label: 'OpenRouter', local: false, available: true, requires_api_key: true, models: [DEFAULT_MODELS.openrouter] },
  { id: 'anthropic', label: 'Anthropic API', local: false, available: true, requires_api_key: true, models: [DEFAULT_MODELS.anthropic] },
  { id: 'openai', label: 'OpenAI API', local: false, available: true, requires_api_key: true, models: [DEFAULT_MODELS.openai] },
];

interface GraphLlmSettingsProps {
  onSaved?: () => void;
}

export function GraphLlmSettings({ onSaved }: GraphLlmSettingsProps) {
  const [provider, setProvider] = useState('openrouter');
  const [model, setModel] = useState(DEFAULT_MODELS.openrouter);
  const [providers, setProviders] = useState<ProviderOption[]>(FALLBACK_PROVIDERS);
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [keyMasked, setKeyMasked] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/memory', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'graph.get_llm_config' }),
        });
        const data = await res.json();
        if (Array.isArray(data.providers) && data.providers.length > 0) {
          setProviders(data.providers);
        }
        if (data.provider) setProvider(data.provider);
        if (data.model) setModel(data.model);
        const isConfigured = data.configured === true;
        setConfigured(isConfigured);
        setKeyMasked(isConfigured);
      } catch {
        setConfigured(false);
      }
    };
    fetchConfig();
  }, []);

  const handleProviderChange = (value: string) => {
    setProvider(value);
    const selected = providers.find((candidate) => candidate.id === value);
    setModel(selected?.models[0] ?? DEFAULT_MODELS[value] ?? '');
    setKeyMasked(false);
    setApiKey('');
  };

  const selectedProvider = providers.find((candidate) => candidate.id === provider);
  const usesLocalAuth = selectedProvider?.local ?? (provider === 'claude-code' || provider === 'codex');
  const requiresApiKey = selectedProvider?.requires_api_key ?? !usesLocalAuth;
  const modelOptions = selectedProvider?.models ?? [];

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const body: { type: string; provider: string; model: string; api_key?: string } = {
        type: 'graph.set_llm_config',
        provider,
        model,
      };
      if (apiKey) {
        body.api_key = apiKey;
      }
      const res = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.error) {
        setSaveError(data.error);
        return;
      }
      setApiKey('');
      setConfigured(true);
      setKeyMasked(true);
      onSaved?.();
    } catch {
      setSaveError('Failed to save configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-2">
        <Label htmlFor="llm-provider">Provider</Label>
        <Select value={provider} onValueChange={handleProviderChange}>
          <SelectTrigger id="llm-provider">
            <SelectValue placeholder="Select provider" />
          </SelectTrigger>
          <SelectContent>
            {providers.map((candidate) => (
              <SelectItem key={candidate.id} value={candidate.id}>
                {candidate.label}{candidate.local && !candidate.available ? ' (not found)' : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="llm-model">Model</Label>
        <Input
          id="llm-model"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          list={modelOptions.length > 0 ? 'llm-model-options' : undefined}
          placeholder="Model name"
        />
      </div>
      {modelOptions.length > 0 && (
        <datalist id="llm-model-options">
          {modelOptions.map((option) => <option key={option} value={option} />)}
        </datalist>
      )}
      {requiresApiKey ? (
        <div className="grid gap-2">
          <Label htmlFor="llm-api-key">API Key</Label>
          <Input
            id="llm-api-key"
            type={keyMasked ? 'text' : 'password'}
            readOnly={keyMasked}
            value={keyMasked ? '*****' : apiKey}
            onFocus={() => {
              if (keyMasked) {
                setKeyMasked(false);
                setApiKey('');
              }
            }}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="Enter your API key"
            className={keyMasked ? 'cursor-pointer text-muted-foreground' : ''}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Uses the local {provider === 'codex' ? 'Codex CLI' : 'Claude Code'} login and settings on the server host; no API key is stored here.
        </p>
      )}
      {saveError && (
        <p className="text-xs text-destructive">{saveError}</p>
      )}
      <Button onClick={handleSave} disabled={isSaving} size="sm">
        {isSaving ? 'Saving…' : 'Save'}
      </Button>
      <p className="text-xs text-muted-foreground">
        Extracts entities and facts from your memories automatically, and powers the &quot;Suggest with AI&quot;
        button on memory, task, and resource create forms. OpenRouter, Anthropic, OpenAI, Claude Code, and Codex CLI are supported.
      </p>
    </div>
  );
}

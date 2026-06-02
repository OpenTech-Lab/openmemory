'use client';

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
};

interface GraphLlmSettingsProps {
  onSaved?: () => void;
}

export function GraphLlmSettings({ onSaved }: GraphLlmSettingsProps) {
  const [provider, setProvider] = useState('openrouter');
  const [model, setModel] = useState(DEFAULT_MODELS.openrouter);
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
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
        if (data.provider) setProvider(data.provider);
        if (data.model) setModel(data.model);
        setConfigured(data.configured === true);
      } catch {
        setConfigured(false);
      }
    };
    fetchConfig();
  }, []);

  const handleProviderChange = (value: string) => {
    setProvider(value);
    setModel(DEFAULT_MODELS[value] ?? '');
  };

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
      onSaved?.();
    } catch {
      setSaveError('Failed to save configuration.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">LLM Provider Settings</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="llm-provider">Provider</Label>
          <Select value={provider} onValueChange={handleProviderChange}>
            <SelectTrigger id="llm-provider">
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openrouter">OpenRouter</SelectItem>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="llm-model">Model</Label>
          <Input
            id="llm-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="Model name"
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="llm-api-key">API Key</Label>
          <Input
            id="llm-api-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={configured ? 'API key configured (leave blank to keep)' : 'Enter your API key'}
          />
        </div>
        {saveError && (
          <p className="text-xs text-destructive">{saveError}</p>
        )}
        <Button onClick={handleSave} disabled={isSaving} size="sm">
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
        <p className="text-xs text-muted-foreground">
          Extracts entities and facts from your memories automatically. OpenRouter, Anthropic, and OpenAI are supported.
        </p>
      </CardContent>
    </Card>
  );
}

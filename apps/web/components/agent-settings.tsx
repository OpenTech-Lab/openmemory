'use client';

import { useState, useEffect, useCallback } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus, RefreshCw, Pencil, Trash2, Bot } from 'lucide-react';
import { toast } from 'sonner';

interface WatcherAgent {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  is_builtin: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

export function AgentSettings() {
  const [agents, setAgents] = useState<WatcherAgent[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  // Add dialog
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addPath, setAddPath] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [isSaving, setIsSaving] = useState(false);

  // Edit dialog
  const [editAgent, setEditAgent] = useState<WatcherAgent | null>(null);
  const [editPath, setEditPath] = useState('');
  const [editDescription, setEditDescription] = useState('');

  // Delete confirm
  const [deleteAgent, setDeleteAgent] = useState<WatcherAgent | null>(null);

  const loadAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/agents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setAgents(data.agents ?? []);
    } catch (err) {
      toast.error('Failed to load agents');
      console.error(err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => { loadAgents(); }, [loadAgents]);

  async function toggleEnabled(agent: WatcherAgent) {
    const optimistic = agents.map(a =>
      a.id === agent.id ? { ...a, enabled: !a.enabled } : a
    );
    setAgents(optimistic);
    try {
      const res = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !agent.enabled }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(`${agent.name} ${!agent.enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast.error(`Failed to update: ${err instanceof Error ? err.message : err}`);
      setAgents(agents); // rollback
    }
  }

  async function handleAdd() {
    const name = addName.trim();
    const path = addPath.trim();
    if (!name || !path) { toast.error('Name and path are required'); return; }
    setIsSaving(true);
    try {
      const res = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, path, description: addDescription.trim() || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Agent "${name}" added`);
      setIsAddOpen(false);
      setAddName(''); setAddPath(''); setAddDescription('');
      await loadAgents();
    } catch (err) {
      toast.error(`Failed to add: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleEdit() {
    if (!editAgent) return;
    const path = editPath.trim();
    if (!path) { toast.error('Path is required'); return; }
    setIsSaving(true);
    try {
      const res = await fetch(`/api/agents/${editAgent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, description: editDescription.trim() || null }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success('Agent updated');
      setEditAgent(null);
      await loadAgents();
    } catch (err) {
      toast.error(`Failed to update: ${err instanceof Error ? err.message : err}`);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteAgent) return;
    try {
      const res = await fetch(`/api/agents/${deleteAgent.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${res.status}`);
      }
      toast.success(`Agent "${deleteAgent.name}" deleted`);
      setDeleteAgent(null);
      await loadAgents();
    } catch (err) {
      toast.error(`Failed to delete: ${err instanceof Error ? err.message : err}`);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center justify-between pb-4">
          <div>
            <h2 className="font-semibold flex items-center gap-2">
              <Bot className="h-5 w-5" />
              Watcher Agents
            </h2>
            <p className="text-sm text-muted-foreground mt-1">
              Choose which AI tools to record. The watcher reloads agent config every 60 seconds.
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={loadAgents} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-1 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setIsAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />
              Add Agent
            </Button>
          </div>
        </div>
        <div>
          {agents.length === 0 && !isLoading ? (
            <p className="text-sm text-muted-foreground text-center py-8">No agents configured.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Path</TableHead>
                  <TableHead className="w-28">Record</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agents.map(agent => (
                  <TableRow key={agent.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{agent.name}</span>
                        {agent.is_builtin && (
                          <Badge variant="secondary" className="text-xs">built-in</Badge>
                        )}
                      </div>
                      {agent.description && (
                        <p className="text-xs text-muted-foreground mt-0.5">{agent.description}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <code className="text-xs bg-muted px-1.5 py-0.5 rounded">{agent.path}</code>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={agent.enabled}
                        onCheckedChange={() => toggleEnabled(agent)}
                        size="sm"
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          title="Edit path"
                          onClick={() => {
                            setEditAgent(agent);
                            setEditPath(agent.path);
                            setEditDescription(agent.description ?? '');
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        {!agent.is_builtin && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive hover:text-destructive"
                            title="Delete agent"
                            onClick={() => setDeleteAgent(agent)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </div>

      {/* Add Agent Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Custom Agent</DialogTitle>
            <DialogDescription>
              Point the watcher at any directory containing JSONL session files.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-name">Name</Label>
              <Input
                id="add-name"
                placeholder="My AI Tool"
                value={addName}
                onChange={e => setAddName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-path">Path</Label>
              <Input
                id="add-path"
                placeholder="~/.myai/sessions"
                value={addPath}
                onChange={e => setAddPath(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Supports <code>~/</code> and <code>$HOME/</code> prefixes.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-desc">Description (optional)</Label>
              <Input
                id="add-desc"
                placeholder="Short description"
                value={addDescription}
                onChange={e => setAddDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={isSaving}>
              {isSaving ? 'Adding…' : 'Add Agent'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Agent Dialog */}
      <Dialog open={!!editAgent} onOpenChange={open => { if (!open) setEditAgent(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit Agent — {editAgent?.name}</DialogTitle>
            <DialogDescription>Update the path or description for this agent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-path">Path</Label>
              <Input
                id="edit-path"
                value={editPath}
                onChange={e => setEditPath(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-desc">Description (optional)</Label>
              <Input
                id="edit-desc"
                value={editDescription}
                onChange={e => setEditDescription(e.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditAgent(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={isSaving}>
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog open={!!deleteAgent} onOpenChange={open => { if (!open) setDeleteAgent(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete agent?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove &quot;{deleteAgent?.name}&quot; from the watcher. Recorded sessions are not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

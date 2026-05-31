'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { Plus, RefreshCw, Eye, EyeOff, Pencil, Trash2, Lock, Globe } from 'lucide-react';
import { toast } from 'sonner';

interface EnvParam {
  id: string;
  key: string;
  is_secret: boolean;
  description: string | null;
  created_at: string;
  updated_at: string;
}

async function callApi(body: object): Promise<Response> {
  return fetch('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function EnvParamsPanel() {
  const [params, setParams] = useState<EnvParam[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Add dialog
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addKey, setAddKey] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addIsSecret, setAddIsSecret] = useState(false);
  const [addDescription, setAddDescription] = useState('');

  // Edit dialog
  const [editParam, setEditParam] = useState<EnvParam | null>(null);
  const [editValue, setEditValue] = useState('');
  const [editIsSecret, setEditIsSecret] = useState(false);
  const [editDescription, setEditDescription] = useState('');

  // View dialog (reveal secret)
  const [viewParam, setViewParam] = useState<EnvParam | null>(null);
  const [revealedValue, setRevealedValue] = useState<string | null>(null);
  const [isRevealing, setIsRevealing] = useState(false);
  const [revealTimer, setRevealTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  // Delete dialog
  const [deleteParam, setDeleteParam] = useState<EnvParam | null>(null);

  const fetchParams = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await callApi({ type: 'env.list' });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setParams(data.params ?? []);
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchParams();
  }, [fetchParams]);

  // Cleanup reveal timer on unmount
  useEffect(() => {
    return () => {
      if (revealTimer) clearTimeout(revealTimer);
    };
  }, [revealTimer]);

  const handleAdd = async () => {
    if (!addKey.trim() || !addValue.trim()) return;
    setIsSaving(true);
    try {
      const res = await callApi({
        type: 'env.set',
        key: addKey.trim(),
        value: addValue,
        is_secret: addIsSecret,
        description: addDescription.trim() || undefined,
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Parameter '${addKey.trim()}' saved`);
      setIsAddOpen(false);
      setAddKey(''); setAddValue(''); setAddIsSecret(false); setAddDescription('');
      fetchParams();
    } catch {
      toast.error('Failed to save parameter');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editParam) return;
    setIsSaving(true);
    try {
      const body: Record<string, unknown> = {
        type: 'env.set',
        key: editParam.key,
        value: editValue,
        is_secret: editIsSecret,
      };
      if (editDescription.trim()) body.description = editDescription.trim();
      const res = await callApi(body);
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Parameter '${editParam.key}' updated`);
      setEditParam(null);
      fetchParams();
    } catch {
      toast.error('Failed to update parameter');
    } finally {
      setIsSaving(false);
    }
  };

  const handleReveal = async (param: EnvParam) => {
    setViewParam(param);
    setRevealedValue(null);
    setIsRevealing(true);
    try {
      const res = await callApi({ type: 'env.get', key: param.key });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      setRevealedValue(data.value ?? null);
      // Auto-hide after 30 seconds
      const timer = setTimeout(() => {
        setRevealedValue(null);
        setViewParam(null);
      }, 30000);
      setRevealTimer(timer);
    } catch {
      toast.error('Failed to reveal value');
    } finally {
      setIsRevealing(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteParam) return;
    try {
      const res = await callApi({ type: 'env.delete', key: deleteParam.key });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Parameter '${deleteParam.key}' deleted`);
      setDeleteParam(null);
      fetchParams();
    } catch {
      toast.error('Failed to delete parameter');
    }
  };

  const openEdit = (param: EnvParam) => {
    setEditParam(param);
    setEditValue('');
    setEditIsSecret(param.is_secret);
    setEditDescription(param.description ?? '');
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-base">Environment Parameters</CardTitle>
            <CardDescription>
              Store config values and secrets. AI agents can write any param but cannot read secret values.
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={fetchParams} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={() => setIsAddOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Parameter
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading && params.length === 0 ? (
          <div className="flex items-center justify-center h-[300px]">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : params.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Lock className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No environment parameters configured.</p>
            <p className="text-xs mt-1">Add API keys, tokens, or config values for AI agents to use.</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {params.map((param) => (
                <TableRow key={param.id}>
                  <TableCell className="font-mono text-sm font-medium">{param.key}</TableCell>
                  <TableCell>
                    {param.is_secret ? (
                      <Badge variant="destructive" className="gap-1 text-xs">
                        <Lock className="h-3 w-3" /> Secret
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <Globe className="h-3 w-3" /> Normal
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {param.description ?? <span className="italic opacity-50">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(param.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Reveal value"
                        onClick={() => handleReveal(param)}
                      >
                        <Eye className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Edit"
                        onClick={() => openEdit(param)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => setDeleteParam(param)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {/* Add Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Parameter</DialogTitle>
            <DialogDescription>
              Store a configuration value or secret for AI agents to use.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-key">Key <span className="text-destructive">*</span></Label>
              <Input
                id="add-key"
                placeholder="e.g. OPENAI_API_KEY"
                value={addKey}
                onChange={(e) => setAddKey(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-value">Value <span className="text-destructive">*</span></Label>
              <Input
                id="add-value"
                type="password"
                placeholder="Enter value"
                value={addValue}
                onChange={(e) => setAddValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-desc">Description</Label>
              <Textarea
                id="add-desc"
                placeholder="Optional description"
                value={addDescription}
                onChange={(e) => setAddDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="add-secret"
                checked={addIsSecret}
                onCheckedChange={setAddIsSecret}
              />
              <div className="space-y-0.5">
                <Label htmlFor="add-secret" className="cursor-pointer">
                  {addIsSecret ? (
                    <span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Secret</span>
                  ) : (
                    <span className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Normal</span>
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {addIsSecret
                    ? 'Agents can write but cannot read this value back.'
                    : 'Agents can read and write this value freely.'}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>Cancel</Button>
            <Button onClick={handleAdd} disabled={isSaving || !addKey.trim() || !addValue.trim()}>
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editParam} onOpenChange={() => setEditParam(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Parameter</DialogTitle>
            <DialogDescription>
              Update the value or settings for{' '}
              <code className="font-mono text-sm">{editParam?.key}</code>.
              The key name cannot be changed.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Key</Label>
              <Input value={editParam?.key ?? ''} disabled className="font-mono opacity-60" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-value">New Value <span className="text-destructive">*</span></Label>
              <Input
                id="edit-value"
                type="password"
                placeholder="Enter new value"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea
                id="edit-desc"
                placeholder="Optional description"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex items-center gap-3">
              <Switch
                id="edit-secret"
                checked={editIsSecret}
                onCheckedChange={setEditIsSecret}
              />
              <div className="space-y-0.5">
                <Label htmlFor="edit-secret" className="cursor-pointer">
                  {editIsSecret ? (
                    <span className="flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" /> Secret</span>
                  ) : (
                    <span className="flex items-center gap-1.5"><Globe className="h-3.5 w-3.5" /> Normal</span>
                  )}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {editIsSecret
                    ? 'Agents can write but cannot read this value back.'
                    : 'Agents can read and write this value freely.'}
                </p>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditParam(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={isSaving || !editValue.trim()}>
              {isSaving ? 'Saving…' : 'Update'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* View / Reveal Dialog */}
      <Dialog
        open={!!viewParam}
        onOpenChange={() => {
          setViewParam(null);
          setRevealedValue(null);
          if (revealTimer) clearTimeout(revealTimer);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reveal Value</DialogTitle>
            <DialogDescription>
              Value for <code className="font-mono text-sm">{viewParam?.key}</code>.
              {revealedValue && ' Auto-hides in 30 seconds.'}
            </DialogDescription>
          </DialogHeader>
          <div className="py-4">
            {isRevealing ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin" />
                <span className="text-sm">Decrypting…</span>
              </div>
            ) : revealedValue !== null ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Input
                    value={revealedValue}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => {
                      navigator.clipboard.writeText(revealedValue);
                      toast.success('Copied to clipboard');
                    }}
                  >
                    <EyeOff className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Value could not be retrieved.</p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setViewParam(null);
                setRevealedValue(null);
                if (revealTimer) clearTimeout(revealTimer);
              }}
            >
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteParam} onOpenChange={() => setDeleteParam(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Parameter</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deleteParam?.key}</code>? This cannot be undone.
              Any agent or tool referencing this key will stop working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
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
import { Plus, RefreshCw, Eye, EyeOff, Pencil, Trash2, Lock, Globe, Upload, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { TablePagination } from '@/components/ui/table-pagination';

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

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // readAsDataURL yields "data:<mime>;base64,<data>" — strip the prefix
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function EnvParamsPanel() {
  const [params, setParams] = useState<EnvParam[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  // Add dialog
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addMode, setAddMode] = useState<'text' | 'file'>('text');
  const [addKey, setAddKey] = useState('');
  const [addValue, setAddValue] = useState('');
  const [addFile, setAddFile] = useState<File | null>(null);
  const [addIsSecret, setAddIsSecret] = useState(false);
  const [addDescription, setAddDescription] = useState('');

  // Edit dialog
  const [editParam, setEditParam] = useState<EnvParam | null>(null);
  const [editKey, setEditKey] = useState('');
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
  const [deleteConfirmKey, setDeleteConfirmKey] = useState('');
  const isDeleteConfirmed = !!deleteParam && deleteConfirmKey === deleteParam.key;

  const openDelete = (param: EnvParam) => {
    setDeleteConfirmKey('');
    setDeleteParam(param);
  };

  const closeDelete = () => {
    setDeleteParam(null);
    setDeleteConfirmKey('');
  };

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

  const filteredParams = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return params;
    return params.filter((param) =>
      [param.key, param.description ?? '', param.is_secret ? 'secret' : 'normal'].some((field) =>
        field.toLowerCase().includes(query)
      )
    );
  }, [params, searchQuery]);

  useEffect(() => {
    setPage(0);
  }, [searchQuery]);

  // Cleanup reveal timer on unmount
  useEffect(() => {
    return () => {
      if (revealTimer) clearTimeout(revealTimer);
    };
  }, [revealTimer]);

  const handleAdd = async () => {
    if (!addKey.trim()) return;
    if (addMode === 'text' && !addValue.trim()) return;
    if (addMode === 'file' && !addFile) return;
    setIsSaving(true);
    try {
      const res = addMode === 'file' && addFile
        ? await callApi({
            type: 'env.set_file',
            key: addKey.trim(),
            file_content_base64: await fileToBase64(addFile),
            description: addDescription.trim() || undefined,
          })
        : await callApi({
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
      setAddKey(''); setAddValue(''); setAddFile(null); setAddMode('text');
      setAddIsSecret(false); setAddDescription('');
      setPage(0);
      fetchParams();
    } catch {
      toast.error('Failed to save parameter');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEdit = async () => {
    if (!editParam) return;
    const newKey = editKey.trim();
    if (!newKey) return;
    setIsSaving(true);
    try {
      const body: Record<string, unknown> = {
        type: 'env.rename',
        old_key: editParam.key,
        new_key: newKey,
        is_secret: editIsSecret,
        description: editDescription.trim() || null,
      };
      if (editValue.trim()) body.value = editValue;
      const res = await callApi(body);
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Parameter '${newKey}' updated`);
      setEditParam(null);
      setPage(0);
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
    if (!deleteParam || !isDeleteConfirmed) return;
    try {
      const res = await callApi({ type: 'env.delete', key: deleteParam.key });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Parameter '${deleteParam.key}' deleted`);
      closeDelete();
      setPage(0);
      fetchParams();
    } catch {
      toast.error('Failed to delete parameter');
    }
  };

  const openEdit = (param: EnvParam) => {
    setEditParam(param);
    setEditKey(param.key);
    setEditValue('');
    setEditIsSecret(param.is_secret);
    setEditDescription(param.description ?? '');
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  return (
    <div>
      <div className="flex items-center justify-between pb-3">
        <div>
          <h2 className="text-base font-semibold">Environment Parameters</h2>
          <p className="text-sm text-muted-foreground">
            Store config values and secrets. AI agents can write any param but cannot read secret values.
          </p>
        </div>
        <div className="flex gap-2">
          {params.length > 0 && (
            <Input
              placeholder="Search parameters..."
              aria-label="Search environment parameters"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-[220px]"
            />
          )}
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
      <div>
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
        ) : filteredParams.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Lock className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No parameters match your search.</p>
          </div>
        ) : (
          <div className="space-y-4">
          <Table containerClassName="rounded-md border overflow-auto max-h-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Key</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Type</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Description</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Created</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredParams.slice(page * pageSize, (page + 1) * pageSize).map((param) => (
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
                        onClick={() => openDelete(param)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          
          <TablePagination
            page={page}
            pageSize={pageSize}
            totalRows={filteredParams.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
          </div>
        )}
      </div>

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
              <div className="flex items-center justify-between">
                <Label htmlFor={addMode === 'text' ? 'add-value' : 'add-file'}>
                  {addMode === 'text' ? 'Value' : 'File'} <span className="text-destructive">*</span>
                </Label>
                <div className="flex gap-1">
                  <Button
                    type="button"
                    variant={addMode === 'text' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-6 px-2 text-xs gap-1"
                    onClick={() => { setAddMode('text'); setAddFile(null); }}
                  >
                    <FileText className="h-3 w-3" /> Text
                  </Button>
                  <Button
                    type="button"
                    variant={addMode === 'file' ? 'secondary' : 'ghost'}
                    size="sm"
                    className="h-6 px-2 text-xs gap-1"
                    onClick={() => { setAddMode('file'); setAddValue(''); setAddIsSecret(true); }}
                  >
                    <Upload className="h-3 w-3" /> File
                  </Button>
                </div>
              </div>
              {addMode === 'text' ? (
                <Input
                  id="add-value"
                  type="password"
                  placeholder="Enter value"
                  value={addValue}
                  onChange={(e) => setAddValue(e.target.value)}
                />
              ) : (
                <>
                  <Input
                    id="add-file"
                    type="file"
                    onChange={(e) => setAddFile(e.target.files?.[0] ?? null)}
                    className="cursor-pointer file:cursor-pointer"
                  />
                  <p className="text-xs text-muted-foreground">
                    {addFile
                      ? `${addFile.name} (${(addFile.size / 1024).toFixed(1)} KB) — always stored as a secret.`
                      : 'Uploaded files are read directly by the server and always stored as a secret; agents can use them via env_http_request / env_sign_jwt but never read the raw content back.'}
                  </p>
                </>
              )}
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
            {addMode === 'text' && (
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
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setIsAddOpen(false);
                setAddMode('text'); setAddFile(null);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={isSaving || !addKey.trim() || (addMode === 'text' ? !addValue.trim() : !addFile)}
            >
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
              Update the name, value, or settings for this parameter. Existing resource links are updated automatically.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-key">Key <span className="text-destructive">*</span></Label>
              <Input
                id="edit-key"
                value={editKey}
                onChange={(e) => setEditKey(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-value">New Value</Label>
              <Input
                id="edit-value"
                type="password"
                placeholder="•••••••• (leave blank to keep current value)"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                The current value is hidden. Enter a new value to overwrite it, or leave this blank to keep it.
              </p>
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
            <Button onClick={handleEdit} disabled={isSaving || !editKey.trim()}>
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
      <AlertDialog open={!!deleteParam} onOpenChange={(open) => { if (!open) closeDelete(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Parameter</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deleteParam?.key}</code>? This cannot be undone.
              Any agent or tool referencing this key will stop working.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="delete-confirm-key">
              Type <code className="font-mono font-semibold">{deleteParam?.key}</code> to confirm
            </Label>
            <Input
              id="delete-confirm-key"
              autoComplete="off"
              autoFocus
              spellCheck={false}
              value={deleteConfirmKey}
              placeholder={deleteParam?.key}
              onChange={(e) => setDeleteConfirmKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isDeleteConfirmed) {
                  e.preventDefault();
                  handleDelete();
                }
              }}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={!isDeleteConfirmed}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

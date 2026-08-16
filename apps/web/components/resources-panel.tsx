'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Checkbox } from '@/components/ui/checkbox';
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
import { Plus, RefreshCw, Pencil, Trash2, FolderOpen, Link2, Boxes, Lock, ChevronDown, X, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { mergeAutofillField, isNonEmptyArray } from '@/lib/autofill-merge';
import { TablePagination } from '@/components/ui/table-pagination';

interface Resource {
  id: string | null;
  name: string;
  kind: string;
  location: string;
  description: string | null;
  tags: string[];
  env_param_keys: string[];
  source: string;
  env_key: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface EnvParamKeyInfo {
  key: string;
  is_secret: boolean;
}

async function callApi(body: object): Promise<Response> {
  return fetch('/api/memory', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function truncateKey(key: string, max = 10): string {
  return key.length > max ? `${key.slice(0, max)}...` : key;
}

function CredentialsMultiSelect({
  value,
  onChange,
  options,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  options: EnvParamKeyInfo[];
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const toggle = (key: string) => {
    onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  };

  const remove = (key: string) => onChange(value.filter((k) => k !== key));

  const addCustom = () => {
    const key = search.trim();
    if (key && !value.includes(key)) onChange([...value, key]);
    setSearch('');
  };

  const query = search.trim().toLowerCase();
  const filtered = options.filter((o) => o.key.toLowerCase().includes(query));
  const exactMatch = options.some((o) => o.key.toLowerCase() === query);

  return (
    <div className="space-y-1.5">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((key) => (
            <Badge key={key} variant="secondary" className="gap-1 text-xs font-mono">
              {options.find((o) => o.key === key)?.is_secret && <Lock className="h-3 w-3" />}
              {key}
              <button
                type="button"
                onClick={() => remove(key)}
                className="ml-0.5 opacity-60 hover:opacity-100"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 justify-start text-muted-foreground font-normal"
          >
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Add credential
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[280px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search Environment Parameters..."
              value={search}
              onValueChange={setSearch}
            />
            <CommandList className="max-h-[240px]">
              <CommandEmpty>
                {query ? (
                  <button
                    type="button"
                    className="w-full text-left px-2 py-1.5 text-sm hover:bg-accent rounded-sm"
                    onClick={addCustom}
                  >
                    Use custom key &quot;{search.trim()}&quot;
                  </button>
                ) : (
                  'No Environment Parameters found.'
                )}
              </CommandEmpty>
              {filtered.length > 0 && (
                <CommandGroup heading="Environment Parameters">
                  {filtered.map((o) => (
                    <CommandItem key={o.key} onSelect={() => toggle(o.key)} className="gap-2">
                      <Checkbox checked={value.includes(o.key)} className="pointer-events-none" />
                      {o.is_secret && <Lock className="h-3 w-3" />}
                      <span className="font-mono text-xs">{o.key}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {query && !exactMatch && filtered.length > 0 && (
                <CommandGroup>
                  <CommandItem onSelect={addCustom}>
                    Use custom key &quot;{search.trim()}&quot;
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function ResourcesPanel() {
  const [resources, setResources] = useState<Resource[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Add dialog
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addKind, setAddKind] = useState<'path' | 'url'>('path');
  const [addLocation, setAddLocation] = useState('');
  const [addDescription, setAddDescription] = useState('');
  const [addTags, setAddTags] = useState('');
  const [addEnvKeys, setAddEnvKeys] = useState<string[]>([]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  // Only fields the user hasn't hand-edited get overwritten by a suggestion —
  // see the equivalent tracking on the memory Add dialog.
  const [addDescriptionTouched, setAddDescriptionTouched] = useState(false);
  const [addTagsTouched, setAddTagsTouched] = useState(false);

  // Edit dialog
  const [editResource, setEditResource] = useState<Resource | null>(null);
  const [editName, setEditName] = useState('');
  const [editKind, setEditKind] = useState<'path' | 'url'>('path');
  const [editLocation, setEditLocation] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editTags, setEditTags] = useState('');
  const [editEnvKeys, setEditEnvKeys] = useState<string[]>([]);

  // Delete dialog
  const [deleteResource, setDeleteResource] = useState<Resource | null>(null);

  // Known env param keys, for datalist suggestions + secret-status lookup
  const [envParamKeys, setEnvParamKeys] = useState<EnvParamKeyInfo[]>([]);
  const envParamSecretByKey = useMemo(
    () => new Map(envParamKeys.map((p) => [p.key, p.is_secret])),
    [envParamKeys]
  );

  // Tag filter
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  // Keyword search
  const [searchQuery, setSearchQuery] = useState('');

  // Pagination
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);

  const distinctTags = useMemo(
    () => Array.from(new Set(resources.flatMap((r) => r.tags))).sort(),
    [resources]
  );

  const filteredResources = useMemo(() => {
    let result = resources;
    if (activeTags.size > 0) {
      result = result.filter((r) => r.tags.some((t) => activeTags.has(t)));
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter((r) =>
        [r.name, r.location, r.description ?? '', ...r.tags].some((field) =>
          field.toLowerCase().includes(query)
        )
      );
    }
    return result;
  }, [resources, activeTags, searchQuery]);

  useEffect(() => {
    setPage(0);
  }, [searchQuery, activeTags]);

  const pagedResources = useMemo(
    () => filteredResources.slice(page * pageSize, (page + 1) * pageSize),
    [filteredResources, page, pageSize]
  );

  const toggleTag = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  const fetchResources = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await callApi({ type: 'resource.list' });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setResources(data.resources ?? []);
      for (const w of data.warnings ?? []) {
        toast.warning(w);
      }
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchEnvParamKeys = useCallback(async () => {
    try {
      const res = await callApi({ type: 'env.list' });
      const data = await res.json();
      if (data.error) return;
      setEnvParamKeys(
        (data.params ?? []).map((p: { key: string; is_secret: boolean }) => ({
          key: p.key,
          is_secret: p.is_secret,
        }))
      );
    } catch {
      // non-fatal — datalist/lock-icon just won't populate
    }
  }, []);

  useEffect(() => {
    fetchResources();
    fetchEnvParamKeys();
  }, [fetchResources, fetchEnvParamKeys]);

  const handleAdd = async () => {
    if (!addName.trim() || !addLocation.trim()) return;
    setIsSaving(true);
    try {
      const res = await callApi({
        type: 'resource.add',
        name: addName.trim(),
        kind: addKind,
        location: addLocation.trim(),
        description: addDescription.trim() || undefined,
        tags: parseTags(addTags),
        env_param_keys: addEnvKeys,
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Resource '${addName.trim()}' added`);
      if (data.warning) toast.warning(data.warning);
      setIsAddOpen(false);
      setAddName(''); setAddKind('path'); setAddLocation('');
      setAddDescription(''); setAddTags(''); setAddEnvKeys([]);
      setAddDescriptionTouched(false); setAddTagsTouched(false);
      setPage(0);
      fetchResources();
    } catch {
      toast.error('Failed to add resource');
    } finally {
      setIsSaving(false);
    }
  };

  const handleSuggest = async () => {
    const content = [addName.trim(), addLocation.trim(), addDescription.trim()]
      .filter(Boolean)
      .join(' — ');
    if (!content) return;
    setIsSuggesting(true);
    try {
      const res = await callApi({ type: 'ai.autofill', kind: 'resource', content });
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      const suggestion = data.suggestion ?? {};
      setAddDescription(mergeAutofillField(addDescriptionTouched, addDescription, suggestion.description));
      if (!addTagsTouched && isNonEmptyArray(suggestion.tags)) {
        setAddTags((suggestion.tags as string[]).join(', '));
      }
    } catch {
      toast.error('Failed to get AI suggestion');
    } finally {
      setIsSuggesting(false);
    }
  };

  const openEdit = (resource: Resource) => {
    setEditResource(resource);
    setEditName(resource.name);
    setEditKind(resource.kind as 'path' | 'url');
    setEditLocation(resource.location);
    setEditDescription(resource.description ?? '');
    setEditTags(resource.tags.join(', '));
    setEditEnvKeys(resource.env_param_keys);
  };

  const handleEdit = async () => {
    if (!editResource?.id) return;
    setIsSaving(true);
    try {
      const res = await callApi({
        type: 'resource.update',
        id: editResource.id,
        name: editName.trim(),
        kind: editKind,
        location: editLocation.trim(),
        description: editDescription.trim() || null,
        tags: parseTags(editTags),
        env_param_keys: editEnvKeys,
      });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Resource '${editName.trim()}' updated`);
      if (data.warning) toast.warning(data.warning);
      setEditResource(null);
      setPage(0);
      fetchResources();
    } catch {
      toast.error('Failed to update resource');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteResource?.id) return;
    try {
      const res = await callApi({ type: 'resource.delete', id: deleteResource.id });
      const data = await res.json();
      if (data.error) { toast.error(data.error); return; }
      toast.success(`Resource '${deleteResource.name}' deleted`);
      setDeleteResource(null);
      setPage(0);
      fetchResources();
    } catch {
      toast.error('Failed to delete resource');
    }
  };

  const formatDate = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';

  return (
    <div>
      <datalist id="resource-tag-suggestions">
        {distinctTags.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <div className="flex items-center justify-between pb-3">
        <div>
          <h2 className="text-base font-semibold">Resources ({resources.length})</h2>
          <p className="text-sm text-muted-foreground">
            Local paths and website URLs agents can discover, optionally linked to a stored credential.
          </p>
        </div>
        <div className="flex gap-2">
          {resources.length > 0 && (
            <Input
              placeholder="Search resources..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 w-[220px]"
            />
          )}
          <Button variant="outline" size="sm" onClick={fetchResources} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={() => setIsAddOpen(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Resource
          </Button>
        </div>
      </div>
      <div>
        {isLoading && resources.length === 0 ? (
          <div className="flex items-center justify-center h-[300px]">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : resources.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <Boxes className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No resources registered.</p>
            <p className="text-xs mt-1">Register a local path or URL for AI agents to discover.</p>
          </div>
        ) : (
          <>
          {distinctTags.length > 0 && (
            <div className="flex items-center gap-2 pb-3">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8">
                    Tags{activeTags.size > 0 ? ` (${activeTags.size})` : ''}
                    <ChevronDown className="ml-2 h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-[300px] overflow-y-auto">
                  {distinctTags.map((tag) => (
                    <DropdownMenuCheckboxItem
                      key={tag}
                      checked={activeTags.has(tag)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => toggleTag(tag)}
                    >
                      {tag}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              {activeTags.size > 0 && (
                <>
                  <div className="flex flex-wrap gap-1">
                    {Array.from(activeTags).map((tag) => (
                      <Badge key={tag} variant="secondary" className="text-xs">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                  <button
                    className="text-xs text-muted-foreground underline underline-offset-2"
                    onClick={() => setActiveTags(new Set())}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          )}
          {filteredResources.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <Boxes className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No resources match your search.</p>
            </div>
          ) : (
          <div className="space-y-4">
          <Table containerClassName="rounded-md border overflow-auto max-h-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Name</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Category</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Location</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Source</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Tags</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Credentials</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Description</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b">Created</TableHead>
                <TableHead className="sticky top-0 z-10 bg-muted border-b text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedResources.map((r) => (
                <TableRow key={r.id ?? r.env_key ?? r.name}>
                  <TableCell className="font-medium text-sm max-w-[140px] whitespace-normal break-words">{r.name}</TableCell>
                  <TableCell>
                    {r.kind === 'path' ? (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <FolderOpen className="h-3 w-3" /> Path
                      </Badge>
                    ) : (
                      <Badge variant="secondary" className="gap-1 text-xs">
                        <Link2 className="h-3 w-3" /> URL
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground max-w-[280px] truncate" title={r.location}>
                    {r.location}
                  </TableCell>
                  <TableCell>
                    <Badge variant={r.source === 'manual' ? 'outline' : 'secondary'} className="text-xs">
                      {r.source}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    {r.tags.length > 0 ? (
                      <div className="flex flex-wrap gap-1" title={r.tags.join(', ')}>
                        {r.tags.slice(0, 2).map((tag) => (
                          <Badge key={tag} variant="outline" className="text-xs">
                            {tag}
                          </Badge>
                        ))}
                        {r.tags.length > 2 && (
                          <Badge variant="outline" className="text-xs text-muted-foreground">
                            +{r.tags.length - 2}
                          </Badge>
                        )}
                      </div>
                    ) : (
                      <span className="italic opacity-50 text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    {r.env_param_keys.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {r.env_param_keys.map((key) => (
                          <Badge key={key} variant="secondary" className="gap-1 text-xs font-mono" title={key}>
                            {envParamSecretByKey.get(key) && <Lock className="h-3 w-3" />}
                            {truncateKey(key)}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <span className="italic opacity-50 text-sm text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className="text-muted-foreground text-sm max-w-[240px] truncate"
                    title={r.description ?? undefined}
                  >
                    {r.description ?? <span className="italic opacity-50">—</span>}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {formatDate(r.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title={r.source === 'manual' ? 'Edit' : 'Env-declared — edit via env_set on the RESOURCE_* key'}
                        disabled={r.source !== 'manual'}
                        onClick={() => openEdit(r)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        title={r.source === 'manual' ? 'Delete' : 'Env-declared — delete via env_delete on the RESOURCE_* key'}
                        disabled={r.source !== 'manual'}
                        onClick={() => setDeleteResource(r)}
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
            totalRows={filteredResources.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
          </div>
          )}
          </>
        )}
      </div>

      {/* Add Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add Resource</DialogTitle>
            <DialogDescription>
              Register a local path or website URL for AI agents to discover.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-name">Name <span className="text-destructive">*</span></Label>
              <Input
                id="add-name"
                placeholder="e.g. project-docs"
                value={addName}
                onChange={(e) => setAddName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={addKind} onValueChange={(v) => setAddKind(v as 'path' | 'url')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="path">Local path</SelectItem>
                  <SelectItem value="url">Website URL</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-location">Location <span className="text-destructive">*</span></Label>
              <Input
                id="add-location"
                placeholder={addKind === 'path' ? '/home/user/projects/foo' : 'https://example.com'}
                value={addLocation}
                onChange={(e) => setAddLocation(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="add-desc">Description</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 text-xs"
                  onClick={handleSuggest}
                  disabled={(!addName.trim() && !addLocation.trim()) || isSuggesting}
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {isSuggesting ? 'Suggesting...' : 'Suggest with AI'}
                </Button>
              </div>
              <Textarea
                id="add-desc"
                placeholder="Optional description"
                value={addDescription}
                onChange={(e) => { setAddDescription(e.target.value); setAddDescriptionTouched(true); }}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-tags">Tags</Label>
              <Input
                id="add-tags"
                placeholder="comma, separated, tags"
                value={addTags}
                onChange={(e) => { setAddTags(e.target.value); setAddTagsTouched(true); }}
                list="resource-tag-suggestions"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Credentials (optional)</Label>
              <CredentialsMultiSelect value={addEnvKeys} onChange={setAddEnvKeys} options={envParamKeys} />
              <p className="text-xs text-muted-foreground">
                Select existing Environment Parameters or type a custom key to bundle as this account&apos;s credentials.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={isSaving || !addName.trim() || !addLocation.trim()}
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editResource} onOpenChange={() => setEditResource(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Resource</DialogTitle>
            <DialogDescription>
              Update <code className="font-mono text-sm">{editResource?.name}</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" value={editName} onChange={(e) => setEditName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <Select value={editKind} onValueChange={(v) => setEditKind(v as 'path' | 'url')}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="path">Local path</SelectItem>
                  <SelectItem value="url">Website URL</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-location">Location</Label>
              <Input
                id="edit-location"
                value={editLocation}
                onChange={(e) => setEditLocation(e.target.value)}
                className="font-mono"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-desc">Description</Label>
              <Textarea
                id="edit-desc"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                rows={2}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="edit-tags">Tags</Label>
              <Input
                id="edit-tags"
                placeholder="comma, separated, tags"
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                list="resource-tag-suggestions"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Credentials (optional)</Label>
              <CredentialsMultiSelect value={editEnvKeys} onChange={setEditEnvKeys} options={envParamKeys} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditResource(null)}>Cancel</Button>
            <Button onClick={handleEdit} disabled={isSaving || !editName.trim() || !editLocation.trim()}>
              {isSaving ? 'Saving…' : 'Update'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteResource} onOpenChange={() => setDeleteResource(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Resource</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deleteResource?.name}</code>? This cannot be undone.
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
    </div>
  );
}

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Trash2, ImageOff, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import { CATEGORIES, type Category } from '@/app/(sidebar)/library/page';

interface Project {
  id: string;
  name: string;
}

interface LibraryEntry {
  id: string;
  project_id: string | null;
  label: string;
  kind: 'image' | 'video' | 'code';
  category: Category;
  location: string | null;
  code: string | null;
  description: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
}

const NO_PROJECT_VALUE = '__none__';
const NO_CATEGORY_VALUE = '__none__';

const CATEGORY_LABELS: Record<Category, string> = {
  'ui': 'UI',
  'design-system': 'Design System',
  'effects': 'Effects',
  'animation': 'Animation',
  'other': 'Other',
};

type Kind = 'image' | 'video' | 'code';
type Source = 'upload' | 'paste';

function CodePreview({ entry }: { entry: LibraryEntry }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || isNearViewport) return;

    const observer = new IntersectionObserver(
      ([intersection]) => {
        if (!intersection.isIntersecting) return;
        setIsNearViewport(true);
        observer.disconnect();
      },
      { rootMargin: '160px' },
    );

    observer.observe(container);
    return () => observer.disconnect();
  }, [isNearViewport]);

  return (
    <div ref={containerRef} className="h-full w-full">
      {isNearViewport && (
        <iframe
          sandbox="allow-scripts"
          loading="lazy"
          srcDoc={entry.code ?? undefined}
          src={entry.code ? undefined : `/api/library/${entry.id}/file`}
          className="h-full w-full border-0 bg-white"
          title={entry.label}
        />
      )}
    </div>
  );
}

function extFromFilename(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1) : 'bin';
}

export function LibraryGallery({
  category,
  projects,
}: {
  category: Category | null;
  projects: Project[];
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const fetchEntries = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const search = category ? `?category=${category}` : '';
      const res = await fetch(`/api/library${search}`);
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? 'Failed to load library');
        setEntries([]);
        return;
      }
      setEntries(data.entries ?? []);
    } catch {
      setError('Failed to load library');
    } finally {
      setIsLoading(false);
    }
  }, [category]);

  useEffect(() => { fetchEntries(); }, [fetchEntries]);

  const projectNameById = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const filteredEntries = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter((entry) => [
      entry.label,
      entry.kind,
      CATEGORY_LABELS[entry.category],
      entry.location ?? '',
      entry.code ?? '',
      entry.description ?? '',
      projectNameById.get(entry.project_id ?? '') ?? '',
      ...entry.tags,
    ].some((field) => field.toLowerCase().includes(query)));
  }, [entries, projectNameById, searchQuery]);

  const handleDelete = useCallback(async (entry: LibraryEntry) => {
    try {
      const res = await fetch(`/api/library/${entry.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Failed to delete entry');
        return;
      }
      setEntries(prev => prev.filter(e => e.id !== entry.id));
      toast.success(`"${entry.label}" deleted`);
    } catch {
      toast.error('Failed to connect to server');
    }
  }, []);

  const handleCreated = useCallback((entry: LibraryEntry) => {
    setDialogOpen(false);
    // Only splice the new entry into view if it matches the current filter.
    if (!category || entry.category === category) {
      setEntries(prev => [entry, ...prev]);
    }
    toast.success(`"${entry.label}" added`);
  }, [category]);

  return (
    <div className="flex flex-col gap-4 px-6 py-6">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="Search library..."
          aria-label="Search library entries by keyword"
          className="h-8 w-[240px] max-w-full"
        />
        <div className="flex justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => fetchEntries()}
          disabled={isLoading}
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5">
              <Plus className="h-4 w-4" />
              Add entry
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-lg">
            <AddEntryForm
              projects={projects}
              defaultCategory={category}
              onCreated={handleCreated}
              onCancel={() => setDialogOpen(false)}
            />
          </DialogContent>
        </Dialog>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground py-6">Loading…</p>
      ) : error ? (
        <p className="text-sm text-destructive py-6">{error}</p>
      ) : entries.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-16">
          <ImageOff className="h-8 w-8" />
          <p>No library entries yet.</p>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2 py-16">
          <ImageOff className="h-8 w-8" />
          <p>No library entries match your search.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {filteredEntries.map(entry => (
            <div key={entry.id} className="flex flex-col rounded-lg border bg-card overflow-hidden">
              <div className="aspect-video bg-muted flex items-center justify-center overflow-hidden">
                {entry.kind === 'video' ? (
                  <video
                    controls
                    className="w-full h-full object-cover"
                    src={`/api/library/${entry.id}/file`}
                  />
                ) : entry.kind === 'code' ? (
                  <CodePreview entry={entry} />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={`/api/library/${entry.id}/file`}
                    alt={entry.label}
                    className="w-full h-full object-cover"
                  />
                )}
              </div>
              <div className="flex flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium truncate">{entry.label}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={() => handleDelete(entry)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  <Badge variant="outline" className="text-[10px] uppercase">{entry.kind}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{CATEGORY_LABELS[entry.category]}</Badge>
                </div>
                {entry.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{entry.description}</p>
                )}
                {entry.tags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {entry.tags.map(tag => (
                      <Badge key={tag} variant="secondary" className="text-[10px]">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AddEntryForm({
  projects,
  defaultCategory,
  onCreated,
  onCancel,
}: {
  projects: Project[];
  defaultCategory: Category | null;
  onCreated: (entry: LibraryEntry) => void;
  onCancel: () => void;
}) {
  const [kind, setKind] = useState<Kind>('image');
  const [source, setSource] = useState<Source>('upload');
  const [label, setLabel] = useState('');
  const [description, setDescription] = useState('');
  const [tagsInput, setTagsInput] = useState('');
  const [location, setLocation] = useState('');
  const [code, setCode] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<string>(defaultCategory ?? NO_CATEGORY_VALUE);
  const [entryProjectId, setEntryProjectId] = useState<string>(NO_PROJECT_VALUE);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!label.trim()) {
      toast.error('Label is required');
      return;
    }
    if (category === NO_CATEGORY_VALUE) {
      toast.error('Category is required');
      return;
    }
    if (source === 'upload' && !file) {
      toast.error('Choose a file to upload');
      return;
    }
    if (source === 'paste' && kind === 'code' && !code.trim()) {
      toast.error('Paste some HTML/CSS/JS');
      return;
    }
    if (source === 'paste' && kind !== 'code' && !location.trim()) {
      toast.error('Paste a URL or path');
      return;
    }

    setIsSubmitting(true);
    try {
      let resolvedLocation: string | undefined;
      let resolvedCode: string | undefined;

      if (source === 'upload' && file) {
        const ext = extFromFilename(file.name);
        const bytes = await file.arrayBuffer();
        const uploadRes = await fetch(`/api/library/upload?ext=${encodeURIComponent(ext)}`, {
          method: 'POST',
          body: bytes,
        });
        const uploadData = await uploadRes.json();
        if (!uploadRes.ok) {
          toast.error(uploadData.error ?? 'Upload failed');
          setIsSubmitting(false);
          return;
        }
        resolvedLocation = uploadData.location;
      } else if (kind === 'code') {
        resolvedCode = code;
      } else {
        resolvedLocation = location;
      }

      const tags = tagsInput
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);

      const createRes = await fetch('/api/library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_id: entryProjectId === NO_PROJECT_VALUE ? undefined : entryProjectId,
          label,
          kind,
          category,
          location: resolvedLocation,
          code: resolvedCode,
          description: description || undefined,
          tags,
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok) {
        toast.error(createData.error ?? 'Failed to create entry');
        setIsSubmitting(false);
        return;
      }
      if (createData.warning) {
        toast.warning(createData.warning);
      }
      onCreated(createData.entry);
    } catch {
      toast.error('Failed to connect to server');
      setIsSubmitting(false);
    }
  }, [label, source, file, kind, code, location, tagsInput, category, entryProjectId, description, onCreated]);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Add library entry</DialogTitle>
      </DialogHeader>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label>Kind</Label>
          <Tabs value={kind} onValueChange={(v) => { setKind(v as Kind); setSource('upload'); setFile(null); }}>
            <TabsList className="w-full">
              <TabsTrigger value="image" className="flex-1">Image</TabsTrigger>
              <TabsTrigger value="video" className="flex-1">Video</TabsTrigger>
              <TabsTrigger value="code" className="flex-1">Code</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Source</Label>
          <Tabs value={source} onValueChange={(v) => { setSource(v as Source); setFile(null); }}>
            <TabsList className="w-full">
              <TabsTrigger value="upload" className="flex-1">
                {kind === 'code' ? 'Upload .html file' : 'Upload file'}
              </TabsTrigger>
              <TabsTrigger value="paste" className="flex-1">
                {kind === 'code' ? 'Paste code' : 'Paste URL/path'}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="pt-2">
              <Input
                type="file"
                accept={kind === 'code' ? '.html,.htm' : kind === 'video' ? 'video/*' : 'image/*'}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </TabsContent>
            <TabsContent value="paste" className="pt-2">
              {kind === 'code' ? (
                <Textarea
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="<!doctype html>...self-contained HTML/CSS/JS..."
                  className="font-mono text-xs min-h-[140px]"
                />
              ) : (
                <Input
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="https://... or /absolute/path"
                />
              )}
            </TabsContent>
          </Tabs>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Short label" />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Category *</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger>
              <SelectValue placeholder="Choose a category" />
            </SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>{CATEGORY_LABELS[c]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Description</Label>
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Optional description"
            className="min-h-[60px]"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Tags</Label>
          <Input
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="comma, separated, tags"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs text-muted-foreground font-normal">Project (optional, secondary)</Label>
          <Select value={entryProjectId} onValueChange={setEntryProjectId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="None" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_PROJECT_VALUE}>None</SelectItem>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={isSubmitting}>Cancel</Button>
        <Button onClick={handleSubmit} disabled={isSubmitting}>
          {isSubmitting ? 'Adding…' : 'Add entry'}
        </Button>
      </DialogFooter>
    </>
  );
}

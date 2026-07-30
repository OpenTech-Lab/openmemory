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
import { Plus, RefreshCw, Pencil, Trash2, Archive, ArchiveRestore, GraduationCap, ChevronDown } from 'lucide-react';
import { toast } from 'sonner';
import {
  LESSON_CATEGORIES,
  LESSON_SEVERITIES,
  categoryColor,
  severityColor,
  severityRank,
} from '@/lib/lesson-meta';

interface Lesson {
  id: string;
  project_id: string;
  title: string;
  context: string | null;
  rule: string;
  category: string;
  severity: string;
  status: string;
  tags: string[];
  occurrences: number;
  created_by: string | null;
  last_seen_at: string;
  created_at: string;
  updated_at: string;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface LessonsPanelProps {
  projectId: string | null;
  projects?: ProjectOption[];
}

function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function formatDate(iso: string | null) {
  return iso
    ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : '—';
}

const EMPTY_ADD_FORM = {
  title: '',
  rule: '',
  context: '',
  category: LESSON_CATEGORIES[0] as string,
  severity: 'medium' as string,
  tags: '',
  formProjectId: '',
};

export function LessonsPanel({ projectId, projects = [] }: LessonsPanelProps) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'active' | 'archived'>('active');
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());

  // Add dialog
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState(EMPTY_ADD_FORM);

  // Edit dialog
  const [editLesson, setEditLesson] = useState<Lesson | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editRule, setEditRule] = useState('');
  const [editContext, setEditContext] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editSeverity, setEditSeverity] = useState('');
  const [editTags, setEditTags] = useState('');

  // Delete dialog
  const [deleteLesson, setDeleteLesson] = useState<Lesson | null>(null);

  // Debounce the free-text query 300ms before it hits the server.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(searchQuery.trim()), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const fetchLessons = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedQuery) params.set('query', debouncedQuery);
      if (categoryFilter !== 'all') params.set('category', categoryFilter);
      params.set('status', statusFilter);
      params.set('limit', '200');
      const url = projectId
        ? `/api/projects/${projectId}/lessons?${params}`
        : `/api/lessons?${params}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.error) {
        toast.error(data.error);
        return;
      }
      setLessons(data.lessons ?? []);
    } catch {
      toast.error('Failed to connect to server');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, debouncedQuery, categoryFilter, statusFilter]);

  useEffect(() => {
    fetchLessons();
  }, [fetchLessons]);

  const distinctTags = useMemo(
    () => Array.from(new Set(lessons.flatMap((l) => l.tags))).sort(),
    [lessons]
  );

  const toggleTag = (tag: string) => {
    setActiveTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };

  // Server already applies query/category/status. Client-side: tag filter,
  // then sort — the backend's `ORDER BY severity DESC` sorts the raw text
  // column wrong (medium/low/high alphabetically), so re-rank here.
  const sortedLessons = useMemo(() => {
    let result = lessons;
    if (activeTags.size > 0) {
      result = result.filter((l) => l.tags.some((t) => activeTags.has(t)));
    }
    return [...result].sort((a, b) => {
      const rankDiff = severityRank(b.severity) - severityRank(a.severity);
      if (rankDiff !== 0) return rankDiff;
      return new Date(b.last_seen_at).getTime() - new Date(a.last_seen_at).getTime();
    });
  }, [lessons, activeTags]);

  const showProjectColumn = projectId === null;
  const showStatusColumn = statusFilter === 'archived' || lessons.some((l) => l.status === 'archived');

  const projectName = useCallback(
    (pid: string) => projects.find((p) => p.id === pid)?.name ?? `${pid.slice(0, 8)}…`,
    [projects]
  );

  const resetAddForm = () => setAddForm({ ...EMPTY_ADD_FORM, formProjectId: projects[0]?.id ?? '' });

  const openAdd = () => {
    resetAddForm();
    setIsAddOpen(true);
  };

  const handleAdd = async () => {
    const title = addForm.title.trim();
    const rule = addForm.rule.trim();
    if (!title || !rule) return;
    const targetProjectId = projectId ?? addForm.formProjectId;
    if (!targetProjectId) {
      toast.error('Select a project');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(`/api/projects/${targetProjectId}/lessons`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          rule,
          context: addForm.context.trim() || undefined,
          category: addForm.category,
          severity: addForm.severity,
          tags: parseTags(addForm.tags),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to add lesson');
        return;
      }
      if (data.occurrences > 1) {
        toast.info(`"${title}" was already recorded — bumped to ${data.occurrences} occurrences`);
      } else {
        toast.success(`Lesson "${title}" added`);
      }
      setIsAddOpen(false);
      resetAddForm();
      fetchLessons();
    } catch {
      toast.error('Failed to add lesson');
    } finally {
      setIsSaving(false);
    }
  };

  const openEdit = (lesson: Lesson) => {
    setEditLesson(lesson);
    setEditTitle(lesson.title);
    setEditRule(lesson.rule);
    setEditContext(lesson.context ?? '');
    setEditCategory(lesson.category);
    setEditSeverity(lesson.severity);
    setEditTags(lesson.tags.join(', '));
  };

  const handleEdit = async () => {
    if (!editLesson) return;
    setIsSaving(true);
    try {
      const res = await fetch(`/api/projects/${editLesson.project_id}/lessons/${editLesson.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: editTitle.trim(),
          rule: editRule.trim(),
          // Always send `context` explicitly (string | null) — omitting the
          // key leaves the existing value untouched server-side, so this is
          // the only way the field can be cleared.
          context: editContext.trim() || null,
          category: editCategory,
          severity: editSeverity,
          tags: parseTags(editTags),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to update lesson');
        return;
      }
      toast.success(`Lesson "${editTitle.trim()}" updated`);
      setEditLesson(null);
      fetchLessons();
    } catch {
      toast.error('Failed to update lesson');
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleArchive = async (lesson: Lesson) => {
    const nextStatus = lesson.status === 'archived' ? 'active' : 'archived';
    try {
      const res = await fetch(`/api/projects/${lesson.project_id}/lessons/${lesson.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to update lesson');
        return;
      }
      toast.success(nextStatus === 'archived' ? 'Lesson archived' : 'Lesson restored');
      fetchLessons();
    } catch {
      toast.error('Failed to update lesson');
    }
  };

  const handleDelete = async () => {
    if (!deleteLesson) return;
    try {
      const res = await fetch(`/api/projects/${deleteLesson.project_id}/lessons/${deleteLesson.id}`, {
        method: 'DELETE',
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to delete lesson');
        return;
      }
      toast.success(`Lesson "${deleteLesson.title}" deleted`);
      setDeleteLesson(null);
      fetchLessons();
    } catch {
      toast.error('Failed to delete lesson');
    }
  };

  return (
    <div>
      <datalist id="lesson-tag-suggestions">
        {distinctTags.map((tag) => (
          <option key={tag} value={tag} />
        ))}
      </datalist>
      <div className="flex items-center justify-between pb-3 gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">Lessons ({lessons.length})</h2>
          <p className="text-sm text-muted-foreground">
            Corrections and patterns learned from past sessions.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <Input
            placeholder="Search lessons..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 w-[200px]"
          />
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-8 w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {LESSON_CATEGORIES.map((c) => (
                <SelectItem key={c} value={c} className="capitalize">
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as 'active' | 'archived')}>
            <SelectTrigger className="h-8 w-[120px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={fetchLessons} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-4 w-4 mr-2" />
            Add Lesson
          </Button>
        </div>
      </div>
      <div>
        {isLoading && lessons.length === 0 ? (
          <div className="flex items-center justify-center h-[300px]">
            <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : lessons.length === 0 ? (
          <div className="text-center py-16 text-muted-foreground">
            <GraduationCap className="h-10 w-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">No lessons recorded.</p>
            <p className="text-xs mt-1">Record a correction or pattern for AI agents to remember.</p>
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
            {sortedLessons.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground">
                <GraduationCap className="h-10 w-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm">No lessons match your filters.</p>
              </div>
            ) : (
              <div className="rounded-md border overflow-auto max-h-[600px]">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="sticky top-0 z-10 bg-background">Title</TableHead>
                      {showProjectColumn && (
                        <TableHead className="sticky top-0 z-10 bg-background">Project</TableHead>
                      )}
                      <TableHead className="sticky top-0 z-10 bg-background">Category</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background">Severity</TableHead>
                      {showStatusColumn && (
                        <TableHead className="sticky top-0 z-10 bg-background">Status</TableHead>
                      )}
                      <TableHead className="sticky top-0 z-10 bg-background">Tags</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background">Rule</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background">Last seen</TableHead>
                      <TableHead className="sticky top-0 z-10 bg-background text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {sortedLessons.map((lesson) => (
                      <TableRow key={lesson.id}>
                        <TableCell className="font-medium text-sm max-w-[220px] whitespace-normal break-words">
                          {lesson.title}
                          {lesson.occurrences > 1 && (
                            <Badge variant="secondary" className="ml-2 text-xs align-middle">
                              ×{lesson.occurrences}
                            </Badge>
                          )}
                        </TableCell>
                        {showProjectColumn && (
                          <TableCell className="text-xs text-muted-foreground max-w-[140px] truncate" title={lesson.project_id}>
                            {projectName(lesson.project_id)}
                          </TableCell>
                        )}
                        <TableCell>
                          <Badge variant="outline" className={`text-xs capitalize ${categoryColor(lesson.category)}`}>
                            {lesson.category}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`text-xs capitalize ${severityColor(lesson.severity)}`}>
                            {lesson.severity}
                          </Badge>
                        </TableCell>
                        {showStatusColumn && (
                          <TableCell>
                            <Badge variant={lesson.status === 'archived' ? 'secondary' : 'outline'} className="text-xs capitalize">
                              {lesson.status}
                            </Badge>
                          </TableCell>
                        )}
                        <TableCell className="max-w-[180px]">
                          {lesson.tags.length > 0 ? (
                            <div className="flex flex-wrap gap-1" title={lesson.tags.join(', ')}>
                              {lesson.tags.slice(0, 2).map((tag) => (
                                <Badge key={tag} variant="outline" className="text-xs">
                                  {tag}
                                </Badge>
                              ))}
                              {lesson.tags.length > 2 && (
                                <Badge variant="outline" className="text-xs text-muted-foreground">
                                  +{lesson.tags.length - 2}
                                </Badge>
                              )}
                            </div>
                          ) : (
                            <span className="italic opacity-50 text-sm text-muted-foreground">—</span>
                          )}
                        </TableCell>
                        <TableCell
                          className="text-muted-foreground text-sm max-w-[320px] truncate"
                          title={lesson.rule}
                        >
                          {lesson.rule}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDate(lesson.last_seen_at)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title="Edit"
                              onClick={() => openEdit(lesson)}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8"
                              title={lesson.status === 'archived' ? 'Restore' : 'Archive'}
                              onClick={() => handleToggleArchive(lesson)}
                            >
                              {lesson.status === 'archived' ? (
                                <ArchiveRestore className="h-4 w-4" />
                              ) : (
                                <Archive className="h-4 w-4" />
                              )}
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-8 w-8 text-destructive hover:text-destructive"
                              title="Delete"
                              onClick={() => setDeleteLesson(lesson)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </div>

      {/* Add Dialog */}
      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Lesson</DialogTitle>
            <DialogDescription>
              Record a correction or pattern for AI agents to remember.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {projectId === null && (
              <div className="space-y-1.5 min-w-0">
                <Label>Project</Label>
                <Select
                  value={addForm.formProjectId}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, formProjectId: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select a project" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="add-title">Title <span className="text-destructive">*</span></Label>
              <Input
                id="add-title"
                placeholder="e.g. Always confirm before deleting"
                value={addForm.title}
                onChange={(e) => setAddForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="add-rule">Rule <span className="text-destructive">*</span></Label>
              <Textarea
                id="add-rule"
                placeholder="The rule to follow going forward"
                value={addForm.rule}
                onChange={(e) => setAddForm((f) => ({ ...f, rule: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="add-context">Context</Label>
              <Textarea
                id="add-context"
                placeholder="Optional context — what happened, why it matters"
                value={addForm.context}
                onChange={(e) => setAddForm((f) => ({ ...f, context: e.target.value }))}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 min-w-0">
                <Label>Category</Label>
                <Select
                  value={addForm.category}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, category: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LESSON_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c} className="capitalize">
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label>Severity</Label>
                <Select
                  value={addForm.severity}
                  onValueChange={(v) => setAddForm((f) => ({ ...f, severity: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LESSON_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="add-tags">Tags</Label>
              <Input
                id="add-tags"
                placeholder="comma, separated, tags"
                value={addForm.tags}
                onChange={(e) => setAddForm((f) => ({ ...f, tags: e.target.value }))}
                list="lesson-tag-suggestions"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAdd}
              disabled={
                isSaving ||
                !addForm.title.trim() ||
                !addForm.rule.trim() ||
                (projectId === null && !addForm.formProjectId)
              }
            >
              {isSaving ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editLesson} onOpenChange={() => setEditLesson(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Lesson</DialogTitle>
            <DialogDescription>
              Update <code className="font-mono text-sm">{editLesson?.title}</code>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="edit-title">Title</Label>
              <Input id="edit-title" value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="edit-rule">Rule</Label>
              <Textarea id="edit-rule" value={editRule} onChange={(e) => setEditRule(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="edit-context">Context</Label>
              <Textarea
                id="edit-context"
                value={editContext}
                onChange={(e) => setEditContext(e.target.value)}
                rows={2}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5 min-w-0">
                <Label>Category</Label>
                <Select value={editCategory} onValueChange={setEditCategory}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LESSON_CATEGORIES.map((c) => (
                      <SelectItem key={c} value={c} className="capitalize">
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5 min-w-0">
                <Label>Severity</Label>
                <Select value={editSeverity} onValueChange={setEditSeverity}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LESSON_SEVERITIES.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5 min-w-0">
              <Label htmlFor="edit-tags">Tags</Label>
              <Input
                id="edit-tags"
                placeholder="comma, separated, tags"
                value={editTags}
                onChange={(e) => setEditTags(e.target.value)}
                list="lesson-tag-suggestions"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditLesson(null)}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={isSaving || !editTitle.trim() || !editRule.trim()}>
              {isSaving ? 'Saving…' : 'Update'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteLesson} onOpenChange={() => setDeleteLesson(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Lesson</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <code className="font-mono">{deleteLesson?.title}</code>? This cannot be undone.
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

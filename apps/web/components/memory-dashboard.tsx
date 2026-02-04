'use client';

import { useState, useEffect, useMemo } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Slider } from '@/components/ui/slider';
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
import { DataTable } from '@/components/ui/data-table';
import { createMemoryColumns, type Memory } from '@/components/memory-columns';
import { Search, Database, RefreshCw, Plus, AlertCircle } from 'lucide-react';

export function MemoryDashboard() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [allMemories, setAllMemories] = useState<Memory[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [isSearching, setIsSearching] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState('browse');
  const [error, setError] = useState<string | null>(null);

  // Dialog states
  const [viewMemory, setViewMemory] = useState<Memory | null>(null);
  const [editMemory, setEditMemory] = useState<Memory | null>(null);
  const [deleteMemory, setDeleteMemory] = useState<Memory | null>(null);
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  // Form states
  const [formContent, setFormContent] = useState('');
  const [formSummary, setFormSummary] = useState('');
  const [formTags, setFormTags] = useState('');
  const [formImportance, setFormImportance] = useState(0.5);

  const columns = useMemo(
    () =>
      createMemoryColumns({
        onView: (memory) => setViewMemory(memory),
        onEdit: (memory) => {
          setEditMemory(memory);
          setFormContent(memory.content);
          setFormSummary(memory.summary || '');
          setFormTags(memory.tags.join(', '));
          setFormImportance(memory.importance_score);
        },
        onDelete: (memory) => setDeleteMemory(memory),
      }),
    []
  );

  const fetchAllMemories = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'memory.list',
          limit: 100,
        }),
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      if (data.type === 'memory.list.result' || data.memories) {
        setAllMemories(data.memories || data.results || []);
      }
    } catch (err) {
      console.error('Failed to fetch memories:', err);
      setError('Failed to connect to the server. Make sure the backend is running.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;

    setIsSearching(true);
    setError(null);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'memory.search',
          query: searchQuery,
          limit: 50,
        }),
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }
      if (data.type === 'memory.search.result') {
        setMemories(data.results);
      }
    } catch (err) {
      console.error('Search failed:', err);
      setError('Failed to connect to the server. Make sure the backend is running.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleAdd = async () => {
    if (!formContent.trim()) return;

    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'memory.save',
          content: formContent,
          summary: formSummary || undefined,
          tags: formTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          importance: formImportance,
        }),
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }

      setIsAddDialogOpen(false);
      resetForm();
      fetchAllMemories();
    } catch (err) {
      console.error('Failed to add memory:', err);
      setError('Failed to save memory.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpdate = async () => {
    if (!editMemory) return;

    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'memory.update',
          id: editMemory.id,
          content: formContent,
          summary: formSummary || undefined,
          tags: formTags
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
          importance: formImportance,
        }),
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }

      setEditMemory(null);
      resetForm();
      fetchAllMemories();
    } catch (err) {
      console.error('Failed to update memory:', err);
      setError('Failed to update memory.');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteMemory) return;

    setIsSaving(true);
    setError(null);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'memory.delete',
          id: deleteMemory.id,
        }),
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
        return;
      }

      setDeleteMemory(null);
      fetchAllMemories();
      // Also update search results if in search tab
      if (activeTab === 'search') {
        setMemories((prev) => prev.filter((m) => m.id !== deleteMemory.id));
      }
    } catch (err) {
      console.error('Failed to delete memory:', err);
      setError('Failed to delete memory.');
    } finally {
      setIsSaving(false);
    }
  };

  const resetForm = () => {
    setFormContent('');
    setFormSummary('');
    setFormTags('');
    setFormImportance(0.5);
  };

  const openAddDialog = () => {
    resetForm();
    setIsAddDialogOpen(true);
  };

  useEffect(() => {
    if (activeTab === 'browse') {
      fetchAllMemories();
    }
  }, [activeTab]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center justify-between px-4">
          <div className="flex items-center gap-3">
            <Database className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold">Memory</h1>
            <Badge variant="secondary" className="text-xs">
              {activeTab === 'browse' ? allMemories.length : memories.length} records
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={fetchAllMemories} disabled={isLoading}>
              <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button size="sm" onClick={openAddDialog}>
              <Plus className="h-4 w-4 mr-2" />
              Add record
            </Button>
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="px-4 pt-4">
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-auto p-4">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-full flex flex-col">
          <TabsList className="grid w-[300px] grid-cols-2">
            <TabsTrigger value="browse">Browse</TabsTrigger>
            <TabsTrigger value="search">Search</TabsTrigger>
          </TabsList>

          <TabsContent value="browse" className="flex-1 mt-4">
            <Card className="h-full">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">All Memories</CardTitle>
                <CardDescription>Browse and manage all stored memories</CardDescription>
              </CardHeader>
              <CardContent>
                {isLoading ? (
                  <div className="flex items-center justify-center h-[400px]">
                    <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <DataTable
                    columns={columns}
                    data={allMemories}
                    searchKey="content"
                    searchPlaceholder="Filter by content..."
                  />
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="search" className="flex-1 mt-4">
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Semantic Search</CardTitle>
                  <CardDescription>Search memories using natural language queries</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex gap-2">
                    <Input
                      placeholder="Search for memories..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                      className="flex-1"
                    />
                    <Button onClick={handleSearch} disabled={isSearching}>
                      <Search className="h-4 w-4 mr-2" />
                      {isSearching ? 'Searching...' : 'Search'}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {memories.length > 0 && (
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Search Results</CardTitle>
                    <CardDescription>
                      Found {memories.length} matching {memories.length === 1 ? 'memory' : 'memories'}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    <DataTable
                      columns={columns}
                      data={memories}
                      searchKey="content"
                      searchPlaceholder="Filter results..."
                    />
                  </CardContent>
                </Card>
              )}

              {memories.length === 0 && searchQuery && !isSearching && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    No memories found for &quot;{searchQuery}&quot;
                  </CardContent>
                </Card>
              )}

              {!searchQuery && (
                <Card>
                  <CardContent className="py-8 text-center text-muted-foreground">
                    Enter a search query to find memories
                  </CardContent>
                </Card>
              )}
            </div>
          </TabsContent>
        </Tabs>
      </div>

      {/* View Details Dialog */}
      <Dialog open={!!viewMemory} onOpenChange={() => setViewMemory(null)}>
        <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Memory Details</DialogTitle>
            <DialogDescription>View the full memory content and metadata</DialogDescription>
          </DialogHeader>
          {viewMemory && (
            <div className="space-y-4 py-4">
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="text-right text-muted-foreground">ID</Label>
                <p className="col-span-3 font-mono text-sm break-all">{viewMemory.id}</p>
              </div>
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="text-right text-muted-foreground">Content</Label>
                <p className="col-span-3 whitespace-pre-wrap">{viewMemory.content}</p>
              </div>
              {viewMemory.summary && (
                <div className="grid grid-cols-4 items-start gap-4">
                  <Label className="text-right text-muted-foreground">Summary</Label>
                  <p className="col-span-3 text-muted-foreground">{viewMemory.summary}</p>
                </div>
              )}
              <div className="grid grid-cols-4 items-start gap-4">
                <Label className="text-right text-muted-foreground">Tags</Label>
                <div className="col-span-3 flex flex-wrap gap-1">
                  {viewMemory.tags.length > 0 ? (
                    viewMemory.tags.map((tag) => (
                      <Badge key={tag} variant="secondary">
                        {tag}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-muted-foreground">No tags</span>
                  )}
                </div>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right text-muted-foreground">Importance</Label>
                <div className="col-span-3 flex items-center gap-2">
                  <div className="h-2 w-24 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-primary"
                      style={{ width: `${viewMemory.importance_score * 100}%` }}
                    />
                  </div>
                  <span className="text-sm">{viewMemory.importance_score.toFixed(2)}</span>
                </div>
              </div>
              <div className="grid grid-cols-4 items-center gap-4">
                <Label className="text-right text-muted-foreground">Created</Label>
                <p className="col-span-3 text-sm">{new Date(viewMemory.created_at).toLocaleString()}</p>
              </div>
              {viewMemory.score !== undefined && (
                <div className="grid grid-cols-4 items-center gap-4">
                  <Label className="text-right text-muted-foreground">Relevance</Label>
                  <p className="col-span-3">
                    <Badge variant="outline">{viewMemory.score.toFixed(3)}</Badge>
                  </p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setViewMemory(null)}>
              Close
            </Button>
            <Button
              onClick={() => {
                if (viewMemory) {
                  setEditMemory(viewMemory);
                  setFormContent(viewMemory.content);
                  setFormSummary(viewMemory.summary || '');
                  setFormTags(viewMemory.tags.join(', '));
                  setFormImportance(viewMemory.importance_score);
                  setViewMemory(null);
                }
              }}
            >
              Edit
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Memory Dialog */}
      <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Memory</DialogTitle>
            <DialogDescription>Create a new memory record</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="content">Content *</Label>
              <Textarea
                id="content"
                placeholder="Enter the memory content..."
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                rows={4}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="summary">Summary</Label>
              <Input
                id="summary"
                placeholder="Brief summary (optional)"
                value={formSummary}
                onChange={(e) => setFormSummary(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tags">Tags</Label>
              <Input
                id="tags"
                placeholder="Comma-separated tags (e.g., preference, coding)"
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Importance: {formImportance.toFixed(1)}</Label>
              <Slider
                value={[formImportance]}
                onValueChange={([v]) => setFormImportance(v)}
                min={0}
                max={1}
                step={0.1}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={!formContent.trim() || isSaving}>
              {isSaving ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Memory Dialog */}
      <Dialog open={!!editMemory} onOpenChange={() => setEditMemory(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Memory</DialogTitle>
            <DialogDescription>Update the memory record</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="edit-content">Content *</Label>
              <Textarea
                id="edit-content"
                placeholder="Enter the memory content..."
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                rows={4}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-summary">Summary</Label>
              <Input
                id="edit-summary"
                placeholder="Brief summary (optional)"
                value={formSummary}
                onChange={(e) => setFormSummary(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="edit-tags">Tags</Label>
              <Input
                id="edit-tags"
                placeholder="Comma-separated tags"
                value={formTags}
                onChange={(e) => setFormTags(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Importance: {formImportance.toFixed(1)}</Label>
              <Slider
                value={[formImportance]}
                onValueChange={([v]) => setFormImportance(v)}
                min={0}
                max={1}
                step={0.1}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditMemory(null)}>
              Cancel
            </Button>
            <Button onClick={handleUpdate} disabled={!formContent.trim() || isSaving}>
              {isSaving ? 'Updating...' : 'Update'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteMemory} onOpenChange={() => setDeleteMemory(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Memory</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this memory? This action cannot be undone.
              {deleteMemory && (
                <span className="block mt-2 font-mono text-xs">ID: {deleteMemory.id}</span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSaving ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

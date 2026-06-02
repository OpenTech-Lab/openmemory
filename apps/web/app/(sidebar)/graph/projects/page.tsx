'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
import { ColumnDef } from '@tanstack/react-table';
import { Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

interface ProjectGraph {
  id: string;
  name: string;
  path: string;
  description: string | null;
  node_count: number;
  edge_count: number;
  graph_hash: string | null;
  imported_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CreateForm {
  name: string;
  path: string;
  description: string;
}

export default function ProjectGraphsPage() {
  const [projects, setProjects] = useState<ProjectGraph[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState<CreateForm>({ name: '', path: '', description: '' });
  const [isCreating, setIsCreating] = useState(false);
  const [rebuildingId, setRebuildingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const fetchProjects = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/project-graphs');
      const data = await res.json();
      setProjects(data.projects ?? []);
    } catch {
      toast.error('Failed to load projects');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchProjects();
  }, [fetchProjects]);

  const handleCreate = async () => {
    if (!createForm.name.trim()) {
      toast.error('Name is required');
      return;
    }
    if (!createForm.path.trim()) {
      toast.error('Folder path is required');
      return;
    }
    setIsCreating(true);
    try {
      const res = await fetch('/api/project-graphs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: createForm.name,
          path: createForm.path,
          description: createForm.description,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast.error(body.error ?? 'Failed to register project');
        return;
      }
      setShowCreateDialog(false);
      setCreateForm({ name: '', path: '', description: '' });
      fetchProjects();
      toast.success('Project registered successfully');
    } catch {
      toast.error('Failed to register project');
    } finally {
      setIsCreating(false);
    }
  };

  const handleRebuild = async (id: string) => {
    setRebuildingId(id);
    try {
      const res = await fetch(`/api/project-graphs/${id}/rebuild`, { method: 'POST' });
      await fetchProjects();
      if (res.ok) {
        toast.success('Graph rebuilt successfully');
      } else {
        toast.error('Failed to rebuild graph');
      }
    } catch {
      toast.error('Failed to rebuild graph');
    } finally {
      setRebuildingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    setDeletingId(id);
    try {
      const res = await fetch(`/api/project-graphs/${id}`, { method: 'DELETE' });
      if (res.ok) {
        await fetchProjects();
        toast.success('Project deleted');
      } else {
        toast.error('Failed to delete project');
      }
    } catch {
      toast.error('Failed to delete project');
    } finally {
      setDeletingId(null);
      setConfirmDeleteId(null);
    }
  };

  const columns: ColumnDef<ProjectGraph>[] = [
    {
      accessorKey: 'name',
      header: 'Name',
      cell: ({ row }) => (
        <Link
          href={`/graph/projects/${row.original.id}`}
          className="text-primary hover:underline font-medium"
        >
          {row.original.name}
        </Link>
      ),
    },
    {
      accessorKey: 'path',
      header: 'Path',
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground font-mono truncate max-w-[200px] block">
          {row.original.path}
        </span>
      ),
    },
    {
      accessorKey: 'node_count',
      header: 'Nodes',
      cell: ({ row }) => (
        <Badge variant="secondary">{row.original.node_count.toLocaleString()}</Badge>
      ),
    },
    {
      accessorKey: 'edge_count',
      header: 'Edges',
      cell: ({ row }) => (
        <Badge variant="outline">{row.original.edge_count.toLocaleString()}</Badge>
      ),
    },
    {
      accessorKey: 'imported_at',
      header: 'Imported',
      cell: ({ row }) =>
        row.original.imported_at ? (
          new Date(row.original.imported_at).toLocaleDateString()
        ) : (
          <span className="text-muted-foreground text-xs">Never</span>
        ),
    },
    {
      id: 'actions',
      header: () => <div className="text-right">Actions</div>,
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleRebuild(row.original.id)}
            disabled={rebuildingId === row.original.id}
          >
            {rebuildingId === row.original.id ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              'Rebuild'
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive"
            onClick={() => setConfirmDeleteId(row.original.id)}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b">
        <div>
          <h1 className="text-2xl font-semibold">Project Knowledge Graphs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Register folders to query their code and docs as a knowledge graph
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Register Project
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 p-6">
        {isLoading ? (
          <div className="flex items-center justify-center h-32">
            <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : projects.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
            <p>No projects registered yet.</p>
            <p className="text-sm mt-1">
              Run <code className="bg-muted px-1 rounded">/graphify &lt;path&gt;</code> in Claude
              Code first, then register the path here.
            </p>
          </div>
        ) : (
          <DataTable columns={columns} data={projects} />
        )}
      </div>

      {/* Create Dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Register Project</DialogTitle>
            <DialogDescription>
              Point to a folder that already has a{' '}
              <code>graphify-out/graph.json</code> file. Run{' '}
              <code>/graphify &lt;path&gt;</code> in Claude Code first to generate it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Name</Label>
              <Input
                value={createForm.name}
                onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="my-project"
              />
            </div>
            <div>
              <Label>Folder Path</Label>
              <Input
                value={createForm.path}
                onChange={(e) => setCreateForm((f) => ({ ...f, path: e.target.value }))}
                placeholder="/home/user/my-project"
                className="font-mono text-sm"
              />
            </div>
            <div>
              <Label>Description (optional)</Label>
              <Textarea
                value={createForm.description}
                onChange={(e) => setCreateForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What this project is about"
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={isCreating}>
              {isCreating ? <RefreshCw className="h-4 w-4 animate-spin mr-2" /> : null}
              Register
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <AlertDialog
        open={!!confirmDeleteId}
        onOpenChange={(open) => !open && setConfirmDeleteId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete project graph?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the stored knowledge graph from the database. Original files on disk are
              not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => confirmDeleteId && handleDelete(confirmDeleteId)}
              disabled={!!deletingId}
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

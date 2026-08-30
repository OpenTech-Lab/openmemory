'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ChevronRight,
  FileCode2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Home,
  MoreHorizontal,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { TablePagination } from '@/components/ui/table-pagination';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Project, ProjectFolder } from '@/lib/project-types';

const VERSION_STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  maintenance: 'Maintenance',
  archived: 'Archived',
  deprecated: 'Deprecated',
};

const VERSION_STATUS_COLORS: Record<string, string> = {
  active: 'border-green-500 text-green-600 dark:text-green-400',
  maintenance: 'border-blue-400 text-blue-600 dark:text-blue-400',
  archived: 'border-border text-muted-foreground',
  deprecated: 'border-destructive text-destructive',
};

const EFFECTIVE_STATUS_LABELS: Record<string, string> = {
  bug_detected: 'Bug Detected',
  feature_updating: 'Feature Updating',
};

const EFFECTIVE_STATUS_COLORS: Record<string, string> = {
  bug_detected: 'border-red-500 text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30',
  feature_updating: 'border-blue-500 text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950/30',
};

type FolderSelection = 'all' | 'unfiled' | string;

export interface ProjectTreeViewProps {
  projects: Project[];
  folders: ProjectFolder[];
  selectedFolderId: FolderSelection;
  onSelectedFolderChange: (folderId: FolderSelection) => void;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onCreateProject: (folderId: string | null) => void;
  onCreateFolder: (parentId: string | null) => void;
  onEditFolder: (folder: ProjectFolder) => void;
  onDeleteFolder: (folder: ProjectFolder) => void;
  onEditProject: (project: Project) => void;
  onMoveProject: (project: Project) => void;
  onDeleteProject: (project: Project) => void;
  onRebuildProject: (project: Project) => void;
  onVersionStatusChange: (projectId: string, status: string) => void;
  rebuildingId: string | null;
  bulkRebuildActive: boolean;
  updatingStatusId: string | null;
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function folderPath(folderId: string | null, foldersById: Map<string, ProjectFolder>): string {
  if (!folderId) return 'Unfiled';
  const names: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = foldersById.get(currentId);
    if (!folder) break;
    names.unshift(folder.name);
    currentId = folder.parent_id;
  }
  return names.join(' / ') || 'Unfiled';
}

function FolderNode({
  folder,
  depth,
  childrenByParent,
  expandedFolderIds,
  selectedFolderId,
  projectCountByFolder,
  onToggle,
  onSelect,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
}: {
  folder: ProjectFolder;
  depth: number;
  childrenByParent: Map<string | null, ProjectFolder[]>;
  expandedFolderIds: Set<string>;
  selectedFolderId: FolderSelection;
  projectCountByFolder: Map<string, number>;
  onToggle: (folderId: string) => void;
  onSelect: (folderId: string) => void;
  onCreateFolder: (parentId: string) => void;
  onEditFolder: (folder: ProjectFolder) => void;
  onDeleteFolder: (folder: ProjectFolder) => void;
}) {
  const children = childrenByParent.get(folder.id) ?? [];
  const isExpanded = expandedFolderIds.has(folder.id);
  const isSelected = selectedFolderId === folder.id;

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-md py-1.5 pr-1 text-sm transition-colors ${
          isSelected ? 'bg-primary/10 text-primary' : 'hover:bg-muted/70'
        }`}
        style={{ paddingLeft: `${depth * 16 + 6}px` }}
      >
        <button
          type="button"
          className="flex size-5 shrink-0 items-center justify-center rounded hover:bg-background/80"
          onClick={() => onToggle(folder.id)}
          aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${folder.name}`}
        >
          <ChevronRight className={`size-3.5 transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
        </button>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => onSelect(folder.id)}
        >
          {isExpanded ? <FolderOpen className="size-4 shrink-0 text-amber-500" /> : <Folder className="size-4 shrink-0 text-amber-500" />}
          <span className="min-w-0 flex-1 truncate font-medium">{folder.name}</span>
          <span className="mr-1 text-[11px] tabular-nums text-muted-foreground">{projectCountByFolder.get(folder.id) ?? 0}</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              aria-label={`Manage ${folder.name}`}
            >
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-44">
            <DropdownMenuItem onClick={() => onCreateFolder(folder.id)}>
              <FolderPlus className="size-4" /> New subfolder
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => onEditFolder(folder)}>
              <Pencil className="size-4" /> Rename / move
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => onDeleteFolder(folder)}>
              <Trash2 className="size-4" /> Delete folder
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {isExpanded && children.map((child) => (
        <FolderNode
          key={child.id}
          folder={child}
          depth={depth + 1}
          childrenByParent={childrenByParent}
          expandedFolderIds={expandedFolderIds}
          selectedFolderId={selectedFolderId}
          projectCountByFolder={projectCountByFolder}
          onToggle={onToggle}
          onSelect={onSelect}
          onCreateFolder={onCreateFolder}
          onEditFolder={onEditFolder}
          onDeleteFolder={onDeleteFolder}
        />
      ))}
    </div>
  );
}

export function ProjectTreeView({
  projects,
  folders,
  selectedFolderId,
  onSelectedFolderChange,
  searchQuery,
  onSearchQueryChange,
  onCreateProject,
  onCreateFolder,
  onEditFolder,
  onDeleteFolder,
  onEditProject,
  onMoveProject,
  onDeleteProject,
  onRebuildProject,
  onVersionStatusChange,
  rebuildingId,
  bulkRebuildActive,
  updatingStatusId,
}: ProjectTreeViewProps) {
  const isMobile = useIsMobile();
  const [expandedFolderIds, setExpandedFolderIds] = useState<Set<string> | null>(null);
  const [projectPage, setProjectPage] = useState(0);
  const [projectPageSize, setProjectPageSize] = useState(10);

  const foldersById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const childrenByParent = useMemo(() => {
    const result = new Map<string | null, ProjectFolder[]>();
    for (const folder of folders) {
      const siblings = result.get(folder.parent_id) ?? [];
      siblings.push(folder);
      siblings.sort((a, b) => a.name.localeCompare(b.name));
      result.set(folder.parent_id, siblings);
    }
    return result;
  }, [folders]);
  const projectCountByFolder = useMemo(() => {
    const result = new Map<string, number>();
    for (const project of projects) {
      if (project.folder_id) result.set(project.folder_id, (result.get(project.folder_id) ?? 0) + 1);
    }
    return result;
  }, [projects]);

  const visibleExpandedFolderIds = useMemo(() => {
    if (expandedFolderIds === null) {
      return new Set((childrenByParent.get(null) ?? []).map((folder) => folder.id));
    }
    return new Set([...expandedFolderIds].filter((id) => foldersById.has(id)));
  }, [childrenByParent, expandedFolderIds, foldersById]);

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => [
      project.name,
      project.path ?? '',
      project.description ?? '',
      VERSION_STATUS_LABELS[project.version_status] ?? project.version_status,
      folderPath(project.folder_id, foldersById),
    ].some((value) => value.toLowerCase().includes(query)));
  }, [foldersById, projects, searchQuery]);

  const displayedProjects = useMemo(() => {
    if (selectedFolderId === 'all') return filteredProjects;
    if (selectedFolderId === 'unfiled') return filteredProjects.filter((project) => !project.folder_id);
    return filteredProjects.filter((project) => project.folder_id === selectedFolderId);
  }, [filteredProjects, selectedFolderId]);

  // Start at the first page whenever the active view changes, and keep the
  // current page valid when a project is removed or a filter reduces the list.
  useEffect(() => {
    setProjectPage(0);
  }, [searchQuery, selectedFolderId]);

  useEffect(() => {
    const lastPage = Math.max(0, Math.ceil(displayedProjects.length / projectPageSize) - 1);
    setProjectPage((page) => Math.min(page, lastPage));
  }, [displayedProjects.length, projectPageSize]);

  const pagedProjects = useMemo(
    () => displayedProjects.slice(projectPage * projectPageSize, (projectPage + 1) * projectPageSize),
    [displayedProjects, projectPage, projectPageSize],
  );

  const selectedFolder = selectedFolderId !== 'all' && selectedFolderId !== 'unfiled'
    ? foldersById.get(selectedFolderId)
    : undefined;
  const selectedFolderProjectId = selectedFolder ? selectedFolder.id : selectedFolderId === 'unfiled' ? null : null;
  const rootFolders = childrenByParent.get(null) ?? [];

  const selectFolder = (folderId: string) => {
    onSelectedFolderChange(folderId);
    setExpandedFolderIds((previous) => new Set(previous ?? visibleExpandedFolderIds).add(folderId));
  };

  const selectedTitle = selectedFolder?.name ?? (selectedFolderId === 'unfiled' ? 'Unfiled projects' : 'All projects');
  const selectedDescription = selectedFolder
    ? `${projectCountByFolder.get(selectedFolder.id) ?? 0} direct project${projectCountByFolder.get(selectedFolder.id) === 1 ? '' : 's'}`
    : selectedFolderId === 'unfiled'
      ? 'Projects that are not assigned to a folder'
      : 'Browse every project across your workspace';

  const sidebar = (
    <aside className="flex max-h-[300px] min-h-0 flex-col overflow-hidden border-b md:h-full md:max-h-none md:border-b-0 md:border-r">
        <div className="flex items-center justify-between border-b px-3 py-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">Explorer</p>
            <p className="mt-0.5 text-sm font-medium">Project groups</p>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="size-8 bg-background"
            onClick={() => onCreateFolder(null)}
            title="New folder"
            aria-label="New folder"
          >
            <FolderPlus className="size-4" />
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          <button
            type="button"
            className={`flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${selectedFolderId === 'all' ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted/70'}`}
            onClick={() => onSelectedFolderChange('all')}
          >
            <Home className="size-4 shrink-0" />
            <span className="flex-1">All projects</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{projects.length}</span>
          </button>
          <button
            type="button"
            className={`mt-0.5 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm transition-colors ${selectedFolderId === 'unfiled' ? 'bg-primary/10 font-medium text-primary' : 'hover:bg-muted/70'}`}
            onClick={() => onSelectedFolderChange('unfiled')}
          >
            <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">Unfiled</span>
            <span className="text-[11px] tabular-nums text-muted-foreground">{projects.filter((project) => !project.folder_id).length}</span>
          </button>
          {rootFolders.length > 0 && <div className="my-2 border-t" />}
          {rootFolders.map((folder) => (
            <FolderNode
              key={folder.id}
              folder={folder}
              depth={0}
              childrenByParent={childrenByParent}
              expandedFolderIds={visibleExpandedFolderIds}
              selectedFolderId={selectedFolderId}
              projectCountByFolder={projectCountByFolder}
              onToggle={(folderId) => setExpandedFolderIds((previous) => {
                const next = new Set(previous ?? visibleExpandedFolderIds);
                if (next.has(folderId)) next.delete(folderId); else next.add(folderId);
                return next;
              })}
              onSelect={selectFolder}
              onCreateFolder={(parentId) => {
                setExpandedFolderIds((previous) => new Set(previous ?? visibleExpandedFolderIds).add(parentId));
                onCreateFolder(parentId);
              }}
              onEditFolder={onEditFolder}
              onDeleteFolder={onDeleteFolder}
            />
          ))}
          {folders.length === 0 && (
            <div className="px-3 py-6 text-center text-xs leading-5 text-muted-foreground">
              Create a folder to start grouping related projects.
            </div>
          )}
        </div>
    </aside>
  );

  const projectList = (
      <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <div className="shrink-0 border-b px-4 py-4 sm:px-5">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {selectedFolder ? <FolderOpen className="size-5 shrink-0 text-amber-500" /> : <Home className="size-5 shrink-0 text-primary" />}
                <h2 className="truncate text-lg font-semibold tracking-tight">{selectedTitle}</h2>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{selectedDescription}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[220px] flex-1 sm:flex-none">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={searchQuery}
                  onChange={(event) => onSearchQueryChange(event.target.value)}
                  placeholder="Search projects..."
                  aria-label="Search projects"
                  className="h-8 pl-8 text-sm sm:w-[250px]"
                />
              </div>
              <Button variant="outline" size="sm" className="h-8" onClick={() => onCreateFolder(selectedFolder?.id ?? null)}>
                <FolderPlus className="mr-1.5 size-3.5" /> Folder
              </Button>
              <Button size="sm" className="h-8" onClick={() => onCreateProject(selectedFolderProjectId)}>
                <Plus className="mr-1.5 size-3.5" /> Project
              </Button>
            </div>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/30 hover:bg-muted/30">
                <TableHead className="min-w-[230px]">Project</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="min-w-[190px]">Location</TableHead>
                <TableHead>Graph</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="w-[120px] text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pagedProjects.length > 0 ? pagedProjects.map((project) => {
                const effectiveStatus = project.effective_version_status ?? project.version_status ?? 'active';
                const isComputed = effectiveStatus === 'bug_detected' || effectiveStatus === 'feature_updating';
                const isRebuilding = rebuildingId === project.id;
                return (
                  <TableRow key={project.id} className="group">
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                          <GitBranch className="size-4" />
                        </span>
                        <div className="min-w-0">
                          <Link href={`/projects/${project.id}`} className="block truncate font-medium hover:text-primary hover:underline">
                            {project.name}
                          </Link>
                          {project.description && <p className="mt-0.5 max-w-[320px] truncate text-xs text-muted-foreground">{project.description}</p>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {isComputed ? (
                        <span
                          className={`inline-flex h-7 items-center rounded-md border px-2 text-xs font-medium ${EFFECTIVE_STATUS_COLORS[effectiveStatus]}`}
                          title={`Automatic — manual status is still ${VERSION_STATUS_LABELS[project.version_status] ?? project.version_status}.`}
                        >
                          {EFFECTIVE_STATUS_LABELS[effectiveStatus]}
                        </span>
                      ) : (
                        <Select
                          value={project.version_status ?? 'active'}
                          onValueChange={(value) => onVersionStatusChange(project.id, value)}
                          disabled={updatingStatusId === project.id}
                        >
                          <SelectTrigger className={`h-7 w-[126px] text-xs ${VERSION_STATUS_COLORS[project.version_status] ?? ''}`}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {Object.entries(VERSION_STATUS_LABELS).map(([value, label]) => (
                              <SelectItem key={value} value={value}>{label}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="max-w-[230px]">
                        <p className="truncate text-xs font-medium text-muted-foreground" title={folderPath(project.folder_id, foldersById)}>
                          {folderPath(project.folder_id, foldersById)}
                        </p>
                        {project.path ? (
                          <p className="truncate font-mono text-[11px] text-muted-foreground/75" title={project.path}>{project.path}</p>
                        ) : (
                          <p className="text-[11px] italic text-muted-foreground/60">No filesystem path</p>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 text-xs tabular-nums text-muted-foreground">
                        <Badge variant="secondary" className="font-normal">{project.node_count.toLocaleString()} nodes</Badge>
                        <span className="hidden text-muted-foreground/60 2xl:inline">{project.edge_count.toLocaleString()} edges</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground" title={new Date(project.updated_at).toLocaleString()}>
                        {timeAgo(project.updated_at)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-0.5">
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              className="size-7"
                              title="Project actions"
                              aria-label={`Actions for ${project.name}`}
                            >
                              <MoreHorizontal className="size-4" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem onClick={() => onEditProject(project)}>
                              <Pencil className="size-4" /> Edit project
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => onMoveProject(project)}>
                              <FolderInput className="size-4" /> Move project
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onClick={() => onDeleteProject(project)}>
                              <Trash2 className="size-4" /> Delete project
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        {project.path && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className={`size-7 ${isRebuilding ? 'bg-primary/10 text-primary' : ''}`}
                            title={isRebuilding ? 'Rebuilding graph…' : 'Rebuild graph'}
                            onClick={() => onRebuildProject(project)}
                            disabled={isRebuilding || bulkRebuildActive}
                          >
                            <RefreshCw className={`size-3.5 ${isRebuilding ? 'animate-spin' : ''}`} />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              }) : (
                <TableRow>
                  <TableCell colSpan={6} className="h-44 text-center">
                    <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
                      <span className="flex size-10 items-center justify-center rounded-full bg-muted">
                        {searchQuery ? <Search className="size-4" /> : <FolderOpen className="size-4" />}
                      </span>
                      <p className="text-sm font-medium">{searchQuery ? 'No matching projects' : 'No projects in this view'}</p>
                      <p className="max-w-xs text-xs">
                        {searchQuery ? 'Try a different name, path, or folder.' : 'Create a project here or select another folder from the explorer.'}
                      </p>
                    </div>
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <div className="shrink-0 border-t bg-background px-4 py-2.5 sm:px-5">
          <TablePagination
            page={projectPage}
            pageSize={projectPageSize}
            totalRows={displayedProjects.length}
            onPageChange={setProjectPage}
            onPageSizeChange={setProjectPageSize}
          />
        </div>
        <div className="flex shrink-0 items-center justify-between border-t bg-muted/10 px-4 py-2.5 text-xs text-muted-foreground sm:px-5">
          <span>{displayedProjects.length} project{displayedProjects.length === 1 ? '' : 's'} shown{searchQuery ? ` · ${projects.length} total` : ''}</span>
          {selectedFolder && <span className="hidden sm:inline">Nested folders keep your workspace tidy.</span>}
        </div>
      </section>
  );

  return (
    <div className="flex h-full min-h-[560px] min-w-0 overflow-hidden bg-background">
      {isMobile ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {sidebar}
          {projectList}
        </div>
      ) : (
        <ResizablePanelGroup
          direction="horizontal"
          autoSaveId="openmemory-projects-layout-v1"
          keyboardResizeBy={2}
          className="min-h-0 flex-1"
        >
          <ResizablePanel defaultSize={24} minSize={16} maxSize={40} className="min-w-56">
            {sidebar}
          </ResizablePanel>
          <ResizableHandle
            withHandle
            className="mx-1.5 w-1.5 rounded-full bg-transparent transition-colors after:w-3 hover:bg-border/40 focus-visible:bg-border/40 [&>div]:border-border/80 [&>div]:bg-background [&>div]:shadow-sm"
          />
          <ResizablePanel minSize={60} className="min-w-0">
            {projectList}
          </ResizablePanel>
        </ResizablePanelGroup>
      )}
    </div>
  );
}

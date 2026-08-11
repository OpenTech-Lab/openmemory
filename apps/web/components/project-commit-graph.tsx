'use client';

import { useEffect, useMemo, useState, useCallback } from 'react';
import { FileText, GitBranch, Minus, Plus, RefreshCw, Sparkles, Tag, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';

interface CommitNode {
  hash: string;
  short_hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string[];
}

interface ChangedFile {
  path: string;
  status: string;
  index_status: string;
  worktree_status: string;
  additions: number;
  deletions: number;
  is_untracked: boolean;
}

interface WorkingTreeChanges {
  branch: string;
  files: ChangedFile[];
  ahead: number;
  behind: number;
}

interface LaidOutCommit {
  commit: CommitNode;
  row: number;
  lane: number;
}

const LANE_COLORS = [
  '#3b82f6', '#ef4444', '#22c55e', '#f59e0b', '#a855f7', '#06b6d4', '#ec4899', '#84cc16',
];

const ROW_HEIGHT = 34;
const LANE_WIDTH = 18;
const LEFT_PAD = 12;
const DOT_RADIUS = 4.5;

/// Assigns each commit a lane, walking newest-to-oldest and tracking which lane is "waiting"
/// for which parent hash — the same idea `git log --graph` uses. Not a perfect minimal-crossing
/// layout, but stable and simple enough for a read-only MVP viewer.
function layoutCommits(commits: CommitNode[]): { laidOut: LaidOutCommit[]; laneCount: number } {
  const lanes: (string | null)[] = [];
  const laidOut: LaidOutCommit[] = [];

  commits.forEach((commit, row) => {
    let lane = lanes.findIndex(h => h === commit.hash);
    if (lane === -1) {
      lane = lanes.findIndex(h => h === null);
      if (lane === -1) {
        lane = lanes.length;
        lanes.push(null);
      }
    }
    // Other lanes waiting on the same hash converge here — free them.
    for (let i = 0; i < lanes.length; i++) {
      if (i !== lane && lanes[i] === commit.hash) lanes[i] = null;
    }
    lanes[lane] = commit.parents[0] ?? null;
    for (let p = 1; p < commit.parents.length; p++) {
      const parentHash = commit.parents[p];
      if (lanes.includes(parentHash)) continue;
      const free = lanes.findIndex(h => h === null);
      if (free === -1) lanes.push(parentHash);
      else lanes[free] = parentHash;
    }
    laidOut.push({ commit, row, lane });
  });

  const laneCount = laidOut.reduce((max, c) => Math.max(max, c.lane + 1), 1);
  return { laidOut, laneCount };
}

function fileStatus(file: ChangedFile): { label: string; className: string } {
  if (file.is_untracked) return { label: 'U', className: 'border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-300' };
  if (file.status.includes('D')) return { label: 'D', className: 'border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-300' };
  if (file.status.includes('A')) return { label: 'A', className: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300' };
  if (file.status.includes('R')) return { label: 'R', className: 'border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-300' };
  return { label: 'M', className: 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-300' };
}

function formatChangeCount(file: ChangedFile): string | null {
  if (file.additions === 0 && file.deletions === 0) return null;
  return `+${file.additions} −${file.deletions}`;
}

export function ProjectCommitGraph({ projectId }: { projectId: string }) {
  const [commits, setCommits] = useState<CommitNode[] | null>(null);
  const [changes, setChanges] = useState<WorkingTreeChanges | null>(null);
  const [notGitRepo, setNotGitRepo] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState('');
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [isCommitting, setIsCommitting] = useState(false);
  const [excludedFiles, setExcludedFiles] = useState<Set<string>>(new Set());

  const fetchCommits = useCallback(async () => {
    setHistoryError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/commits`);
      const data = await res.json();
      if (res.status === 404 && data.error === 'not_a_git_repo') {
        setNotGitRepo(true);
        return;
      }
      if (!res.ok) {
        setHistoryError(data.error ?? 'Failed to load commit history');
        return;
      }
      setNotGitRepo(false);
      setCommits(data.commits ?? []);
    } catch {
      setHistoryError('Failed to load commit history');
    }
  }, [projectId]);

  const fetchChanges = useCallback(async () => {
    setChangesError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/changes`);
      const data = await res.json();
      if (res.status === 404 && data.error === 'not_a_git_repo') {
        setNotGitRepo(true);
        return;
      }
      if (!res.ok) {
        setChangesError(data.error ?? 'Failed to load working-tree changes');
        return;
      }
      setNotGitRepo(false);
      const files = data.files ?? [];
      setChanges({ branch: data.branch ?? 'unknown branch', files, ahead: data.ahead ?? 0, behind: data.behind ?? 0 });
      setExcludedFiles(current => {
        const currentPaths = new Set(files.map((file: ChangedFile) => file.path));
        const next = new Set([...current].filter(path => currentPaths.has(path)));
        return next.size === current.size ? current : next;
      });
    } catch {
      setChangesError('Failed to load working-tree changes');
    }
  }, [projectId]);

  useEffect(() => {
    setCommits(null);
    setChanges(null);
    setExcludedFiles(new Set());
    void fetchCommits();
    void fetchChanges();
  }, [fetchCommits, fetchChanges]);

  const selectedFiles = useMemo(
    () => changes?.files.filter(file => !excludedFiles.has(file.path)) ?? [],
    [changes, excludedFiles],
  );
  const selectedFilePaths = selectedFiles.map(file => file.path);
  const keptFileCount = (changes?.files.length ?? 0) - selectedFiles.length;

  const toggleFileSelection = (path: string) => {
    setExcludedFiles(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const suggestCommitMessage = async () => {
    if (!selectedFiles.length) return;
    setIsSuggesting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/commit-message`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok || data.error) {
        toast.error(data.error ?? 'Failed to suggest a commit message');
        return;
      }
      setCommitMessage(data.message ?? '');
      toast.success('Commit message suggested');
    } catch {
      toast.error('Failed to get an AI commit message');
    } finally {
      setIsSuggesting(false);
    }
  };

  const runSourceControlAction = async () => {
    const hasUnpushedCommits = Boolean(changes?.ahead);
    const action = selectedFiles.length ? 'commit' : hasUnpushedCommits ? 'push' : null;
    const message = commitMessage.trim();
    if (!action) return;
    if (action === 'commit' && !message) {
      toast.error('Add a commit message before committing');
      return;
    }
    setIsCommitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/commit-push`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          message: action === 'commit' ? message : undefined,
          paths: action === 'commit' ? selectedFilePaths : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? `Failed to ${action}`);
        await Promise.all([fetchChanges(), fetchCommits()]);
        return;
      }
      if (action === 'commit') setCommitMessage('');
      toast.success(`${action === 'commit' ? 'Committed' : 'Pushed'} ${data.commit_hash?.slice(0, 7) ?? 'changes'}`);
      await Promise.all([fetchChanges(), fetchCommits()]);
    } catch {
      toast.error(`Failed to ${action}`);
    } finally {
      setIsCommitting(false);
    }
  };

  const { laidOut, laneCount } = useMemo(() => layoutCommits(commits ?? []), [commits]);
  const hashToLayout = useMemo(() => {
    const m = new Map<string, LaidOutCommit>();
    laidOut.forEach(c => m.set(c.commit.hash, c));
    return m;
  }, [laidOut]);

  const hasUnpushedCommits = Boolean(changes?.ahead);
  const sourceControlAction = selectedFiles.length ? 'commit' : hasUnpushedCommits ? 'push' : null;

  if (notGitRepo) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <GitBranch className="h-8 w-8" />
        <p>Not a git repository.</p>
        <p className="text-sm">This project&apos;s folder has no <code>.git</code> directory.</p>
      </div>
    );
  }

  const graphWidth = LEFT_PAD * 2 + laneCount * LANE_WIDTH;
  const graphHeight = (commits?.length ?? 0) * ROW_HEIGHT;
  const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
  const laneX = (lane: number) => LEFT_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
  const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

  return (
    <div className="flex h-full min-h-0 overflow-hidden bg-background">
      <aside className="flex w-[min(22rem,32vw)] min-w-[17rem] shrink-0 flex-col border-r bg-muted/10">
        <div className="shrink-0 border-b px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/10 text-primary">
              <GitBranch className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold tracking-tight">Source Control</p>
              <p className="truncate font-mono text-[11px] text-muted-foreground">{changes?.branch ?? 'loading branch…'}</p>
            </div>
            <Badge variant="secondary" className="shrink-0 font-mono text-[10px]">
              {changes ? `${selectedFiles.length}/${changes.files.length}` : 0}
            </Badge>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              aria-label="Refresh source control"
              title="Refresh source control"
              onClick={() => { void fetchChanges(); void fetchCommits(); }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="mt-3 flex items-center justify-between text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
            <span>Changes</span>
            <span className="flex items-center gap-2">
              {changes?.files.length ? <span>{selectedFiles.length} selected</span> : null}
              {keptFileCount > 0 ? <span className="text-muted-foreground/70">{keptFileCount} kept</span> : null}
              {changes?.ahead ? <span className="text-amber-600 dark:text-amber-400">{changes.ahead} ahead</span> : null}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-2">
          {changesError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
              {changesError}
            </div>
          ) : changes === null ? (
            <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
              <RefreshCw className="h-3.5 w-3.5 animate-spin" />
              Reading working tree…
            </div>
          ) : changes.files.length === 0 ? (
            <div className="rounded-md border border-dashed p-5 text-center">
              <p className="text-sm font-medium">Working tree clean</p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">There are no uncommitted files on this branch.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {selectedFiles.length === 0 ? (
                <div className="rounded-md border border-dashed border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-muted-foreground">
                  All files are kept out of this commit. Use <Plus className="mx-0.5 inline h-3 w-3" /> to add one back.
                </div>
              ) : null}
              {changes.files.map(file => {
                const status = fileStatus(file);
                const selected = !excludedFiles.has(file.path);
                return (
                  <div
                    key={`${file.status}:${file.path}`}
                    className={`group flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-2 text-left transition-colors hover:border-border hover:bg-accent/60 ${selected ? '' : 'bg-muted/20 opacity-65'}`}
                    title={`${file.status} ${file.path}`}
                  >
                    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border font-mono text-[10px] font-semibold ${status.className}`}>
                      {status.label}
                    </span>
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className={`min-w-0 flex-1 truncate font-mono text-xs ${selected ? '' : 'line-through decoration-muted-foreground/50'}`}>{file.path}</span>
                    {formatChangeCount(file) && (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground">{formatChangeCount(file)}</span>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className={`h-6 w-6 shrink-0 ${selected ? 'text-muted-foreground hover:text-amber-600 dark:hover:text-amber-400' : 'text-emerald-600 hover:text-emerald-700 dark:text-emerald-400 dark:hover:text-emerald-300'}`}
                      aria-label={selected ? `Keep ${file.path} out of the next commit` : `Add ${file.path} to the next commit`}
                      aria-pressed={selected}
                      title={selected ? 'Keep this file out of the next commit' : 'Add this file to the next commit'}
                      onClick={() => toggleFileSelection(file.path)}
                      disabled={isCommitting}
                    >
                      {selected ? <Minus className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t bg-background/85 p-3 backdrop-blur">
          <div className="mb-2 flex items-center justify-between gap-2">
            <Label htmlFor="commit-message" className="text-xs font-semibold">Commit message</Label>
            <span className="font-mono text-[10px] uppercase tracking-[0.1em] text-muted-foreground">suggestion only</span>
          </div>
          <Textarea
            id="commit-message"
            rows={3}
            value={commitMessage}
            onChange={event => setCommitMessage(event.target.value)}
            placeholder="Describe the changes…"
            className="resize-none font-mono text-xs leading-5"
            disabled={!selectedFiles.length || isCommitting}
          />
          <Button
            type="button"
            variant="secondary"
            className="mt-2 w-full gap-2"
            onClick={suggestCommitMessage}
            disabled={!selectedFiles.length || isSuggesting || isCommitting}
          >
            {isSuggesting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
            {isSuggesting ? 'Analyzing changes…' : 'Suggest with AI'}
          </Button>
          <Button
            type="button"
            className="mt-2 w-full gap-2"
            onClick={runSourceControlAction}
            disabled={!sourceControlAction || (sourceControlAction === 'commit' && !commitMessage.trim()) || isSuggesting || isCommitting}
          >
            {isCommitting ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
            {isCommitting ? `${sourceControlAction === 'commit' ? 'Committing' : 'Pushing'}…` : sourceControlAction === 'push' ? 'Push' : 'Commit'}
          </Button>
          <p className="mt-2 text-[10px] leading-4 text-muted-foreground">
            {sourceControlAction === 'commit'
              ? `Commits ${selectedFiles.length} selected file${selectedFiles.length === 1 ? '' : 's'}; kept files stay uncommitted.`
              : sourceControlAction === 'push'
                ? 'Pushes local commits on the current branch.'
                : changes?.files.length
                  ? 'Use + to add files to the next commit.'
                  : 'No file changes or unpushed commits.'}
          </p>
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-4 border-b px-5 py-3">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Repository timeline</p>
            <h2 className="text-sm font-semibold">Commit history</h2>
          </div>
          {changes?.branch && <Badge variant="outline" className="shrink-0 font-mono text-[10px]">{changes.branch}</Badge>}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
          {historyError ? (
            <p className="p-3 text-sm text-destructive">{historyError}</p>
          ) : commits === null ? (
            <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
              <RefreshCw className="h-5 w-5 animate-spin" />
              Loading history…
            </div>
          ) : commits.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No commits found.</p>
          ) : (
            <div className="relative min-w-[34rem]" style={{ minWidth: graphWidth + 500 }}>
              <svg width={graphWidth} height={graphHeight} className="absolute left-0 top-0">
                {laidOut.map(({ commit, row, lane }) => (
                  <g key={commit.hash}>
                    {commit.parents.map(parentHash => {
                      const parent = hashToLayout.get(parentHash);
                      if (!parent) return null;
                      const x1 = laneX(lane);
                      const y1 = rowY(row);
                      const x2 = laneX(parent.lane);
                      const y2 = rowY(parent.row);
                      return (
                        <path
                          key={parentHash}
                          d={x1 === x2 ? `M ${x1} ${y1} L ${x2} ${y2}` : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`}
                          fill="none"
                          stroke={laneColor(lane)}
                          strokeWidth={1.5}
                          opacity={0.6}
                        />
                      );
                    })}
                  </g>
                ))}
                {laidOut.map(({ commit, row, lane }) => (
                  <circle
                    key={commit.hash}
                    cx={laneX(lane)}
                    cy={rowY(row)}
                    r={DOT_RADIUS}
                    fill={laneColor(lane)}
                    stroke="var(--background)"
                    strokeWidth={1.5}
                  />
                ))}
              </svg>
              <div style={{ marginLeft: graphWidth }}>
                {laidOut.map(({ commit }) => (
                  <div
                    key={commit.hash}
                    className="flex items-center gap-2 border-b border-border/50 px-3 text-sm"
                    style={{ height: ROW_HEIGHT }}
                  >
                    {commit.refs.map(ref => (
                      <Badge key={ref} variant="outline" className="shrink-0 gap-1 text-[10px]">
                        <Tag className="h-2.5 w-2.5" />
                        {ref}
                      </Badge>
                    ))}
                    <span className="flex-1 truncate">{commit.subject}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{commit.author}</span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{commit.short_hash}</span>
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">
                      {new Date(commit.date).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

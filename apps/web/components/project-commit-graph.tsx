'use client';

import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, GitBranch, Tag } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface CommitNode {
  hash: string;
  short_hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string[];
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

export function ProjectCommitGraph({ projectId }: { projectId: string }) {
  const [commits, setCommits] = useState<CommitNode[] | null>(null);
  const [notGitRepo, setNotGitRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/projects/${projectId}/commits`);
        const data = await res.json();
        if (cancelled) return;
        if (res.status === 404 && data.error === 'not_a_git_repo') {
          setNotGitRepo(true);
          return;
        }
        if (!res.ok) {
          setError(data.error ?? 'Failed to load commit history');
          return;
        }
        setCommits(data.commits ?? []);
      } catch {
        if (!cancelled) setError('Failed to load commit history');
      }
    })();
    return () => { cancelled = true; };
  }, [projectId]);

  const { laidOut, laneCount } = useMemo(() => layoutCommits(commits ?? []), [commits]);
  const hashToLayout = useMemo(() => {
    const m = new Map<string, LaidOutCommit>();
    laidOut.forEach(c => m.set(c.commit.hash, c));
    return m;
  }, [laidOut]);

  if (notGitRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <GitBranch className="h-8 w-8" />
        <p>Not a git repository.</p>
        <p className="text-sm">This project&apos;s folder has no <code>.git</code> directory.</p>
      </div>
    );
  }

  if (error) {
    return <p className="p-6 text-sm text-destructive">{error}</p>;
  }

  if (commits === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (commits.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No commits found.</p>;
  }

  const graphWidth = LEFT_PAD * 2 + laneCount * LANE_WIDTH;
  const graphHeight = commits.length * ROW_HEIGHT;

  const laneColor = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
  const laneX = (lane: number) => LEFT_PAD + lane * LANE_WIDTH + LANE_WIDTH / 2;
  const rowY = (row: number) => row * ROW_HEIGHT + ROW_HEIGHT / 2;

  return (
    <div className="h-full overflow-auto">
      <div className="relative" style={{ minWidth: graphWidth + 500 }}>
        <svg width={graphWidth} height={graphHeight} className="absolute top-0 left-0">
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
              className="flex items-center gap-2 px-3 border-b border-border/50 text-sm"
              style={{ height: ROW_HEIGHT }}
            >
              {commit.refs.map(ref => (
                <Badge key={ref} variant="outline" className="text-[10px] gap-1 shrink-0">
                  <Tag className="h-2.5 w-2.5" />
                  {ref}
                </Badge>
              ))}
              <span className="truncate flex-1">{commit.subject}</span>
              <span className="text-xs text-muted-foreground shrink-0">{commit.author}</span>
              <span className="text-xs font-mono text-muted-foreground shrink-0">{commit.short_hash}</span>
              <span className="text-xs text-muted-foreground shrink-0 w-20 text-right">
                {new Date(commit.date).toLocaleDateString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

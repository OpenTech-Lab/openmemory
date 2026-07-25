'use client';

import { useEffect, useState, useCallback } from 'react';
import { Folder, FileText, RefreshCw, ChevronRight, GitBranch } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

interface LastCommit {
  hash: string;
  author: string;
  date: string;
  subject: string;
}

interface FileEntry {
  name: string;
  is_dir: boolean;
  last_commit: LastCommit | null;
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

export function ProjectFilesBrowser({ projectId }: { projectId: string }) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [notGitRepo, setNotGitRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEntries = useCallback(async (nextPath: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/files?path=${encodeURIComponent(nextPath)}`);
      const data = await res.json();
      if (res.status === 404 && data.error === 'not_a_git_repo') {
        setNotGitRepo(true);
        setEntries([]);
        return;
      }
      if (!res.ok) {
        setError(data.error ?? 'Failed to load files');
        setEntries([]);
        return;
      }
      setNotGitRepo(false);
      setEntries(data.entries ?? []);
    } catch {
      setError('Failed to load files');
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchEntries(path); }, [path, fetchEntries]);

  const breadcrumbs = path.split('/').filter(Boolean);

  if (notGitRepo) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <GitBranch className="h-8 w-8" />
        <p>Not a git repository.</p>
        <p className="text-sm">This project&apos;s folder has no <code>.git</code> directory.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-1 px-6 py-3 border-b shrink-0 text-sm">
        <button className="text-muted-foreground hover:text-foreground" onClick={() => setPath('')}>
          root
        </button>
        {breadcrumbs.map((segment, i) => (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setPath(breadcrumbs.slice(0, i + 1).join('/'))}
            >
              {segment}
            </button>
          </span>
        ))}
        {isLoading && <RefreshCw className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-2" />}
      </div>
      <div className="flex-1 overflow-auto p-6">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : entries.length === 0 && !isLoading ? (
          <p className="text-sm text-muted-foreground">Empty directory.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Last commit</TableHead>
                <TableHead className="text-right">Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map(entry => (
                <TableRow
                  key={entry.name}
                  className={entry.is_dir ? 'cursor-pointer' : ''}
                  onClick={() => entry.is_dir && setPath(path ? `${path}/${entry.name}` : entry.name)}
                >
                  <TableCell className="flex items-center gap-2">
                    {entry.is_dir ? (
                      <Folder className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="font-mono text-sm">{entry.name}</span>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground truncate max-w-[400px]">
                    {entry.last_commit?.subject ?? '—'}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {entry.last_commit ? timeAgo(entry.last_commit.date) : '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

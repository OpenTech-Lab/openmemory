'use client';

import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { RefreshCw, FolderOpen, GitBranch, MessageSquare } from 'lucide-react';
import { I18nText } from '@/lib/i18n';

interface Session {
  id: string;
  project_name: string | null;
  git_branch: string | null;
  cwd: string | null;
  started_at: string | null;
  last_event_at: string | null;
  message_count: number;
  created_at: string;
}

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const fetchSessions = async () => {
    setIsLoading(true);
    try {
      const res = await fetch('/api/sessions?limit=100');
      const data = await res.json();
      setSessions(Array.isArray(data) ? data : (data.sessions ?? []));
    } catch {
      setSessions([]);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSessions();
  }, []);

  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-2"><I18nText id="page.sessions" /></h1>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />

      <div>
        <div className="flex items-center justify-between pb-3">
          <p className="text-sm text-muted-foreground">
            {sessions.length} session{sessions.length !== 1 ? 's' : ''} captured by the watcher
          </p>
          <Button variant="outline" size="sm" onClick={fetchSessions} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        <div>
          {isLoading ? (
            <div className="flex items-center justify-center h-[400px]">
              <RefreshCw className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              No sessions recorded yet. Start the watcher with{' '}
              <code className="text-xs bg-muted px-1 py-0.5 rounded">
                docker compose --profile watcher up -d
              </code>
            </div>
          ) : (
            <div className="overflow-auto max-h-[600px]">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-background border-b">
                  <tr className="text-left text-muted-foreground">
                    <th className="pb-2 pr-4 font-medium">Project</th>
                    <th className="pb-2 pr-4 font-medium">Branch</th>
                    <th className="pb-2 pr-4 font-medium">Messages</th>
                    <th className="pb-2 pr-4 font-medium">Last Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {sessions.map((s) => (
                    <tr key={s.id} className="hover:bg-muted/50 transition-colors">
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1.5">
                          <FolderOpen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                          <span className="font-mono text-xs truncate max-w-[200px]" title={s.project_name ?? s.id}>
                            {s.project_name ?? s.id.slice(0, 8)}
                          </span>
                        </div>
                      </td>
                      <td className="py-2 pr-4">
                        {s.git_branch ? (
                          <div className="flex items-center gap-1 text-muted-foreground">
                            <GitBranch className="h-3 w-3 shrink-0" />
                            <span className="font-mono text-xs truncate max-w-[120px]">{s.git_branch}</span>
                          </div>
                        ) : (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <div className="flex items-center gap-1 text-muted-foreground">
                          <MessageSquare className="h-3 w-3 shrink-0" />
                          <span>{s.message_count}</span>
                        </div>
                      </td>
                      <td className="py-2 pr-4 text-muted-foreground text-xs">
                        {s.last_event_at ? new Date(s.last_event_at).toLocaleString() : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

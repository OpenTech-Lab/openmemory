'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Bot, CornerDownLeft, MessageSquareText, RefreshCw, Send, UserRound } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface TaskNote {
  id: string;
  task_id: string;
  content: string;
  author: string;
  created_at: string;
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function authorLabel(author: string): string {
  return author === 'agent' ? 'AI agent' : 'Human';
}

function isAgent(author: string): boolean {
  return author === 'agent';
}

export function TaskNotesPanel({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [draft, setDraft] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const loadNotes = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/tasks/${taskId}/notes`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load implementation notes');
      setNotes(Array.isArray(data.notes) ? data.notes : []);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load implementation notes');
    } finally {
      setIsLoading(false);
    }
  }, [projectId, taskId]);

  useEffect(() => {
    setNotes([]);
    setDraft('');
    void loadNotes();
  }, [loadNotes]);

  useEffect(() => {
    const thread = threadRef.current;
    if (!thread) return;
    thread.scrollTo({ top: thread.scrollHeight, behavior: 'smooth' });
  }, [notes.length, isLoading]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isSaving) return;

    setIsSaving(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/tasks/${taskId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, author: 'human' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to add implementation note');
      setNotes(previous => [...previous, data]);
      setDraft('');
      toast.success('Implementation note added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add implementation note');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <section className="flex flex-col overflow-hidden" aria-labelledby="task-notes-heading">
      <header className="flex items-center justify-between gap-3 border-b px-0 py-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <MessageSquareText className="size-4" />
          </div>
          <div className="min-w-0">
            <h3 id="task-notes-heading" className="truncate text-sm font-semibold">Implementation thread</h3>
            <p className="truncate text-[11px] text-muted-foreground">A shared handoff between people and AI agents</p>
          </div>
        </div>
        <Badge variant="outline" className="shrink-0 tabular-nums">
          {notes.length} {notes.length === 1 ? 'note' : 'notes'}
        </Badge>
      </header>

      <div
        ref={threadRef}
        className="max-h-[22rem] min-h-28 space-y-4 overflow-y-auto px-0 py-4"
        aria-live="polite"
      >
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <RefreshCw className="size-3.5 animate-spin" />
            Loading conversation...
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <p className="max-w-[18rem] text-xs text-destructive">{loadError}</p>
            <Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void loadNotes()}>
              Retry
            </Button>
          </div>
        ) : notes.length > 0 ? (
          notes.map(note => {
            const agent = isAgent(note.author);
            return (
              <article key={note.id} className={cn('flex items-end gap-2', !agent && 'justify-end')}>
                {agent && (
                  <div className="grid size-7 shrink-0 place-items-center rounded-full border bg-background text-muted-foreground shadow-sm">
                    <Bot className="size-3.5" />
                  </div>
                )}
                <div className={cn('flex max-w-[86%] flex-col gap-1', !agent && 'items-end')}>
                  <div
                    className={cn(
                      'rounded-2xl px-3 py-2.5 shadow-xs',
                      agent
                        ? 'rounded-bl-sm border bg-background text-foreground'
                        : 'rounded-br-sm bg-primary text-primary-foreground',
                    )}
                  >
                    <div className={cn('mb-1 flex items-center gap-2 text-[10px]', agent ? 'text-muted-foreground' : 'text-primary-foreground/70')}>
                      <span className="font-semibold">{authorLabel(note.author)}</span>
                      <time dateTime={note.created_at}>{formatTimestamp(note.created_at)}</time>
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{note.content}</p>
                  </div>
                </div>
                {!agent && (
                  <div className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/15 text-primary">
                    <UserRound className="size-3.5" />
                  </div>
                )}
              </article>
            );
          })
        ) : (
          <div className="flex flex-col items-center justify-center py-7 text-center">
            <div className="mb-2 grid size-9 place-items-center rounded-full border border-dashed bg-background/70 text-muted-foreground">
              <MessageSquareText className="size-4" />
            </div>
            <p className="text-sm font-medium">Start the handoff</p>
            <p className="mt-1 max-w-[15rem] text-xs leading-relaxed text-muted-foreground">
              Capture a decision, finding, or message for the next person or agent.
            </p>
          </div>
        )}
      </div>

      <form onSubmit={handleSubmit} className="border-t py-3">
        <div className="relative">
          <Textarea
            value={draft}
            onChange={event => setDraft(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder="Write an implementation note..."
            maxLength={20000}
            rows={3}
            className="min-h-20 resize-none rounded-xl bg-background pb-9 pr-12 text-sm shadow-inner"
            aria-label="New implementation note"
          />
          <Button
            type="submit"
            size="icon-sm"
            className="absolute bottom-2 right-2 rounded-lg"
            disabled={!draft.trim() || isSaving}
            aria-label="Send implementation note"
            title="Send note"
          >
            {isSaving ? <RefreshCw className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
          </Button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <CornerDownLeft className="size-3" /> Enter to send · Shift+Enter for a new line
          </span>
          <span className="tabular-nums">{draft.length}/20k</span>
        </div>
      </form>
    </section>
  );
}

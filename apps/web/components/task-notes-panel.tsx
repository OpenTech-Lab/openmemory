'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { Bot, CheckCircle2, ChevronDown, CircleHelp, CornerDownLeft, ListChecks, MessageSquareText, Plus, RefreshCw, Send, UserRound, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface TaskDecisionAnswer {
  options: string[];
  reply?: string | null;
  answered_by: string;
  answered_at: string;
}

interface TaskNote {
  id: string;
  task_id: string;
  content: string;
  author: string;
  created_at: string;
  note_type?: 'message' | 'decision';
  decision_options?: string[];
  decision_selection_mode?: 'single' | 'multiple';
  decision_status?: 'open' | 'resolved';
  decision_answers?: TaskDecisionAnswer[];
  decision_resolved_by?: string | null;
  decision_resolved_at?: string | null;
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

export function TaskNotesPanel({
  projectId,
  taskId,
  onOpenDecisionChange,
}: {
  projectId: string;
  taskId: string;
  onOpenDecisionChange?: (taskId: string, hasOpenDecision: boolean) => void;
}) {
  const [notes, setNotes] = useState<TaskNote[]>([]);
  const [draft, setDraft] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [decisionOpen, setDecisionOpen] = useState(false);
  const [decisionMode, setDecisionMode] = useState<'yes_no' | 'options' | 'question'>('yes_no');
  const [decisionSelectionMode, setDecisionSelectionMode] = useState<'single' | 'multiple'>('single');
  const [decisionQuestion, setDecisionQuestion] = useState('');
  const [decisionOptions, setDecisionOptions] = useState(['Yes', 'No']);
  const [isSavingDecision, setIsSavingDecision] = useState(false);
  const [submittingDecisionId, setSubmittingDecisionId] = useState<string | null>(null);
  const [draftSelections, setDraftSelections] = useState<Record<string, string[]>>({});
  const [draftReplies, setDraftReplies] = useState<Record<string, string>>({});
  const [historyOpenIds, setHistoryOpenIds] = useState<Record<string, boolean>>({});
  const threadRef = useRef<HTMLDivElement>(null);

  const loadNotes = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/tasks/${taskId}/notes`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load implementation notes');
      const nextNotes: TaskNote[] = Array.isArray(data.notes) ? data.notes : [];
      setNotes(nextNotes);
      setDraftSelections(previous => {
        const next = { ...previous };
        for (const note of nextNotes) {
          if (note.note_type !== 'decision' || next[note.id]) continue;
          const latestOptions = note.decision_answers?.at(-1)?.options ?? [];
          next[note.id] = note.decision_selection_mode === 'single' ? latestOptions.slice(0, 1) : latestOptions;
        }
        return next;
      });
      setDraftReplies(previous => {
        const next = { ...previous };
        for (const note of nextNotes) {
          if (note.note_type !== 'decision' || next[note.id] !== undefined) continue;
          next[note.id] = note.decision_answers?.at(-1)?.reply ?? '';
        }
        return next;
      });
      onOpenDecisionChange?.(
        taskId,
        nextNotes.some(note => note.note_type === 'decision' && note.decision_status !== 'resolved'),
      );
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : 'Failed to load implementation notes');
    } finally {
      setIsLoading(false);
    }
  }, [onOpenDecisionChange, projectId, taskId]);

  useEffect(() => {
    setNotes([]);
    setDraft('');
    setDraftSelections({});
    setDraftReplies({});
    setHistoryOpenIds({});
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

  const openDecisionComposer = () => {
    setDecisionMode('yes_no');
    setDecisionSelectionMode('single');
    setDecisionQuestion('');
    setDecisionOptions(['Yes', 'No']);
    setDecisionOpen(true);
  };

  const handleCreateDecision = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = decisionQuestion.trim();
    const options = decisionOptions.map(option => option.trim()).filter(Boolean);
    if (!content) {
      toast.error('Add the decision question first');
      return;
    }
    if (options.length > 6) {
      toast.error('Add no more than six choices');
      return;
    }
    if (decisionMode !== 'question' && options.length < 1) {
      toast.error('Add at least one choice, or select Open question');
      return;
    }
    if (new Set(options.map(option => option.toLowerCase())).size !== options.length) {
      toast.error('Choices must be unique');
      return;
    }

    setIsSavingDecision(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/tasks/${taskId}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          author: 'human',
          note_type: 'decision',
          decision_options: options,
          decision_selection_mode: decisionMode === 'question' ? 'single' : decisionSelectionMode,
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to add decision checkpoint');
      setNotes(previous => [...previous, data]);
      setDraftSelections(previous => ({ ...previous, [data.id]: [] }));
      setDraftReplies(previous => ({ ...previous, [data.id]: '' }));
      onOpenDecisionChange?.(taskId, true);
      setDecisionOpen(false);
      toast.success('Decision checkpoint added');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to add decision checkpoint');
    } finally {
      setIsSavingDecision(false);
    }
  };

  const handleSubmitDecisionAnswer = async (note: TaskNote, options: string[], reply: string) => {
    const trimmedReply = reply.trim();
    if ((options.length === 0 && !trimmedReply) || submittingDecisionId) return;
    setSubmittingDecisionId(note.id);
    try {
      const response = await fetch(`/api/projects/${projectId}/tasks/${taskId}/notes/${note.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ options, reply: trimmedReply || undefined, author: 'human' }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to record decision');
      setNotes(previous => previous.map(current => current.id === note.id ? data : current));
      const returnedOptions = data.decision_answers?.at(-1)?.options ?? options;
      setDraftSelections(previous => ({
        ...previous,
        [note.id]: note.decision_selection_mode === 'single' ? returnedOptions.slice(0, 1) : returnedOptions,
      }));
      setDraftReplies(previous => ({ ...previous, [note.id]: data.decision_answers?.at(-1)?.reply ?? trimmedReply }));
      onOpenDecisionChange?.(
        taskId,
        notes.some(current => current.id !== note.id && current.note_type === 'decision' && current.decision_status !== 'resolved'),
      );
      toast.success(`Answer recorded: ${[...options, ...(trimmedReply ? [trimmedReply] : [])].join(' · ')}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to record decision');
    } finally {
      setSubmittingDecisionId(null);
    }
  };

  const toggleDraftOption = (noteId: string, option: string) => {
    setDraftSelections(previous => {
      const current = previous[noteId] ?? [];
      const next = current.includes(option) ? current.filter(value => value !== option) : [...current, option];
      return { ...previous, [noteId]: next };
    });
  };

  const selectDraftOption = (noteId: string, option: string) => {
    setDraftSelections(previous => ({ ...previous, [noteId]: [option] }));
  };

  const decisionChoices = (note: TaskNote) => Array.isArray(note.decision_options) ? note.decision_options : [];
  const isSingleSelection = (note: TaskNote) => note.decision_selection_mode === 'single';
  const decisionAnswers = (note: TaskNote) => Array.isArray(note.decision_answers) ? note.decision_answers : [];
  const pendingDecisions = notes.filter(note => note.note_type === 'decision' && note.decision_status !== 'resolved').length;

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
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge variant="outline" className="tabular-nums">
            {notes.length} {notes.length === 1 ? 'note' : 'notes'}
          </Badge>
          {pendingDecisions > 0 && (
            <Badge variant="outline" className="gap-1 border-amber-300/80 text-amber-700 dark:border-amber-700/70 dark:text-amber-300">
              <CircleHelp className="size-3" /> {pendingDecisions} pending
            </Badge>
          )}
        </div>
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
            const isDecision = note.note_type === 'decision';
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
                      isDecision
                        ? 'rounded-bl-sm border border-amber-300/80 bg-amber-50/80 text-foreground dark:border-amber-800/70 dark:bg-amber-950/25'
                        : agent
                        ? 'rounded-bl-sm border bg-background text-foreground'
                        : 'rounded-br-sm bg-primary text-primary-foreground',
                    )}
                  >
                    <div className={cn('mb-1 flex items-center gap-2 text-[10px]', isDecision || agent ? 'text-muted-foreground' : 'text-primary-foreground/70')}>
                      <span className="font-semibold">{authorLabel(note.author)}</span>
                      <time dateTime={note.created_at}>{formatTimestamp(note.created_at)}</time>
                      {isDecision && (
                        <Badge variant="outline" className="h-5 gap-1 border-amber-300/80 px-1.5 text-[10px] text-amber-700 dark:border-amber-700/70 dark:text-amber-300">
                          <CircleHelp className="size-3" /> Decision
                        </Badge>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{note.content}</p>
                    {isDecision && (() => {
                      const answers = decisionAnswers(note);
                      const latest = answers.at(-1);
                      const draft = draftSelections[note.id] ?? [];
                      const reply = draftReplies[note.id] ?? '';
                      const isSubmitting = submittingDecisionId === note.id;
                      const historyOpen = historyOpenIds[note.id] ?? false;
                      return (
                        <div className="mt-3 border-t border-amber-300/60 pt-2.5 dark:border-amber-800/60">
                          {latest && (
                            <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
                              <CheckCircle2 className="size-3.5" />
                              Current: {latest.options.length > 0 ? latest.options.join(', ') : 'Custom reply'}
                              {latest.reply && <span className="min-w-0 break-words font-normal text-foreground">{latest.reply}</span>}
                              <span className="font-normal text-muted-foreground">
                                · {authorLabel(latest.answered_by)} · {formatTimestamp(latest.answered_at)}
                              </span>
                            </div>
                          )}
                          {decisionChoices(note).length > 0 ? (
                            isSingleSelection(note) ? (
                              <RadioGroup
                                value={draft[0] ?? ''}
                                onValueChange={option => selectDraftOption(note.id, option)}
                                disabled={isSubmitting}
                                className="gap-1.5"
                                aria-label="Select one decision choice"
                              >
                                {decisionChoices(note).map(option => {
                                  const inputId = `decision-${note.id}-${option}`;
                                  return (
                                    <label
                                      key={option}
                                      htmlFor={inputId}
                                      className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-foreground"
                                    >
                                      <RadioGroupItem value={option} id={inputId} />
                                      <span className="min-w-0 break-words">{option}</span>
                                    </label>
                                  );
                                })}
                              </RadioGroup>
                            ) : (
                              <div className="flex flex-col gap-1.5">
                                {decisionChoices(note).map(option => {
                                  const inputId = `decision-${note.id}-${option}`;
                                  return (
                                    <label
                                      key={option}
                                      htmlFor={inputId}
                                      className="flex min-w-0 cursor-pointer items-center gap-2 text-xs text-foreground"
                                    >
                                      <Checkbox
                                        id={inputId}
                                        checked={draft.includes(option)}
                                        onCheckedChange={() => toggleDraftOption(note.id, option)}
                                        disabled={isSubmitting}
                                      />
                                      <span className="min-w-0 break-words">{option}</span>
                                    </label>
                                  );
                                })}
                              </div>
                            )
                          ) : (
                            <p className="text-xs text-muted-foreground">Open question — add a custom reply below.</p>
                          )}
                          {decisionChoices(note).length > 0 && (
                            <p className="mt-1.5 text-[10px] text-muted-foreground">
                              {isSingleSelection(note) ? 'Select one choice.' : 'Select one or more choices.'}
                            </p>
                          )}
                          <Textarea
                            value={reply}
                            onChange={event => setDraftReplies(previous => ({ ...previous, [note.id]: event.target.value }))}
                            placeholder={decisionChoices(note).length > 0 ? 'Optional custom reply...' : 'Write a reply...'}
                            aria-label="Custom decision reply"
                            maxLength={20000}
                            rows={2}
                            className="mt-2 resize-none bg-background/70 text-xs"
                            disabled={isSubmitting}
                          />
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-2.5 h-7 border-amber-300/80 bg-background/70 px-2.5 text-xs hover:border-amber-500 hover:bg-amber-100 dark:border-amber-700/70 dark:hover:bg-amber-950/50"
                            onClick={() => void handleSubmitDecisionAnswer(note, draft, reply)}
                            disabled={(draft.length === 0 && !reply.trim()) || isSubmitting}
                          >
                            {isSubmitting && <RefreshCw className="mr-1 size-3 animate-spin" />}
                            {answers.length > 0 ? 'Update answer' : 'Submit answer'}
                          </Button>
                          {answers.length > 1 && (
                            <details
                              className="mt-2.5"
                              open={historyOpen}
                              onToggle={event => {
                                const isOpen = event.currentTarget.open;
                                setHistoryOpenIds(previous => ({ ...previous, [note.id]: isOpen }));
                              }}
                            >
                              <summary className="flex cursor-pointer list-none items-center gap-1 text-[11px] font-medium text-muted-foreground select-none">
                                <ChevronDown className={cn('size-3 transition-transform', historyOpen && 'rotate-180')} />
                                History ({answers.length})
                              </summary>
                              <ul className="mt-1.5 space-y-1 border-l border-amber-300/60 pl-2.5 dark:border-amber-800/60">
                                {[...answers].reverse().map((answer, index) => (
                                  <li key={`${answer.answered_at}-${index}`} className="break-words text-[11px] text-muted-foreground">
                                    <span>{answer.options.length > 0 ? answer.options.join(', ') : 'Custom reply'}</span>
                                    {answer.reply && <span> · {answer.reply}</span>}
                                    <span> · {authorLabel(answer.answered_by)} · {formatTimestamp(answer.answered_at)}</span>
                                  </li>
                                ))}
                              </ul>
                            </details>
                          )}
                        </div>
                      );
                    })()}
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
        <div className="mb-2 flex items-center justify-between gap-2">
          <Button type="button" variant="outline" size="sm" className="h-7 gap-1.5 text-xs" onClick={openDecisionComposer}>
            <ListChecks className="size-3.5" /> Request a decision
          </Button>
          <span className="text-[10px] text-muted-foreground">Quick review checkpoint</span>
        </div>
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

      <Dialog open={decisionOpen} onOpenChange={setDecisionOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Request a decision</DialogTitle>
            <DialogDescription>
              Add a clear checkpoint so a reviewer or PM can unblock the task with one click.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateDecision} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="decision-question">Question or choice to review</Label>
              <Textarea
                id="decision-question"
                value={decisionQuestion}
                onChange={event => setDecisionQuestion(event.target.value)}
                placeholder="Should we ship this behind a feature flag?"
                rows={3}
                maxLength={20000}
                autoFocus
              />
            </div>
            <div className="space-y-2">
              <Label>Response format</Label>
              <Select value={decisionMode} onValueChange={value => {
                const mode = value as 'yes_no' | 'options' | 'question';
                setDecisionMode(mode);
                setDecisionOptions(mode === 'yes_no' ? ['Yes', 'No'] : mode === 'options' ? ['Option A', 'Option B'] : []);
              }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="yes_no">Yes / No</SelectItem>
                  <SelectItem value="options">Custom options</SelectItem>
                  <SelectItem value="question">Open question / custom reply</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {decisionMode !== 'question' && (
              <div className="space-y-2">
                <Label>Answer selection</Label>
                <Select value={decisionSelectionMode} onValueChange={value => setDecisionSelectionMode(value as 'single' | 'multiple')}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="single">Choose one</SelectItem>
                    <SelectItem value="multiple">Choose multiple</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-[11px] text-muted-foreground">Choose one for Yes/No or A/B/C decisions where only one answer is allowed.</p>
              </div>
            )}
            {decisionMode === 'question' ? (
              <p className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
                The reviewer can answer this question with any custom text.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Choices</Label>
                  {decisionMode === 'options' && decisionOptions.length < 6 && (
                    <Button type="button" variant="ghost" size="sm" className="h-7 gap-1 text-xs" onClick={() => setDecisionOptions(options => [...options, `Option ${String.fromCharCode(65 + options.length)}`])}>
                      <Plus className="size-3.5" /> Add choice
                    </Button>
                  )}
                </div>
                <div className="space-y-2">
                  {decisionOptions.map((option, index) => (
                    <div key={`${index}-${option}`} className="flex items-center gap-2">
                      <Input
                        value={option}
                        onChange={event => setDecisionOptions(options => options.map((current, currentIndex) => currentIndex === index ? event.target.value : current))}
                        disabled={decisionMode === 'yes_no'}
                        aria-label={`Choice ${index + 1}`}
                      />
                      {decisionMode === 'options' && decisionOptions.length > 1 && (
                        <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0" onClick={() => setDecisionOptions(options => options.filter((_, currentIndex) => currentIndex !== index))} aria-label={`Remove choice ${index + 1}`}>
                          <X className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDecisionOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={isSavingDecision || !decisionQuestion.trim()}>
                {isSavingDecision && <RefreshCw className="mr-2 size-4 animate-spin" />}
                Add checkpoint
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

'use client';

import { useCallback, useEffect, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QaPanel } from '@/components/qa-panel';
import { QaPlansPanel } from '@/components/qa-plans-panel';

export function QaSection({ projectId }: { projectId: string }) {
  const [subTab, setSubTab] = useState<'runs' | 'plans'>('runs');
  const [focusPlanId, setFocusPlanId] = useState<string | null>(null);
  const [focusPlanRevisionNum, setFocusPlanRevisionNum] = useState<number | null>(null);
  const [focusRunId, setFocusRunId] = useState<string | null>(null);
  const [runCount, setRunCount] = useState<number | null>(null);
  const [planCount, setPlanCount] = useState<number | null>(null);

  const openPlan = useCallback((planId: string, revisionNum?: number | null) => {
    setFocusPlanId(planId);
    setFocusPlanRevisionNum(revisionNum ?? null);
    setSubTab('plans');
  }, []);

  const openRun = useCallback((runId: string) => {
    setFocusRunId(runId);
    setSubTab('runs');
  }, []);

  const countRuns = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/runs`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.runs)) setRunCount(data.runs.length);
    } catch {
      // See countPlans.
    }
  }, [projectId]);

  const countPlans = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/qa/plans`);
      if (!res.ok) return;
      const data = await res.json();
      if (Array.isArray(data?.plans)) setPlanCount(data.plans.length);
    } catch {
      // The panels surface their own load errors; a stale badge is not worth a second toast.
    }
  }, [projectId]);

  // Only the active sub-tab is mounted, so the inactive one cannot report its own count.
  // Seed both here; each panel then keeps its own number live while it is on screen.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (!cancelled) await countRuns();
      if (!cancelled) await countPlans();
    })();

    return () => {
      cancelled = true;
    };
  }, [countRuns, countPlans]);

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as 'runs' | 'plans')} className="shrink-0 gap-0 pb-3">
        <TabsList>
          <TabsTrigger value="runs">
            Runs
            {runCount !== null && (
              <span className="ml-1 text-xs bg-muted rounded-full px-1.5 py-0.5">{runCount}</span>
            )}
          </TabsTrigger>
          <TabsTrigger value="plans">
            Plans
            {planCount !== null && (
              <span className="ml-1 text-xs bg-muted rounded-full px-1.5 py-0.5">{planCount}</span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex min-h-0 flex-1 flex-col">
        {subTab === 'runs'
          ? (
            <QaPanel
              projectId={projectId}
              onOpenPlan={openPlan}
              focusRunId={focusRunId}
              onCountChange={setRunCount}
              // Duplicating a test creates a plan from the Runs tab, where QaPlansPanel is
              // unmounted and so cannot report the new total itself.
              onPlanCreated={countPlans}
            />
          )
          : (
            <QaPlansPanel
              projectId={projectId}
              focusPlanId={focusPlanId}
              focusPlanRevisionNum={focusPlanRevisionNum}
              onCountChange={setPlanCount}
              onOpenRun={openRun}
              // Running a plan creates a run from the Plans tab, where QaPanel is
              // unmounted and so cannot report the new total itself. Mirror of
              // onPlanCreated above.
              onRunCreated={countRuns}
            />
          )}
      </div>
    </div>
  );
}

'use client';

import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { QaPanel } from '@/components/qa-panel';
import { QaPlansPanel } from '@/components/qa-plans-panel';

export function QaSection({ projectId }: { projectId: string }) {
  const [subTab, setSubTab] = useState<'runs' | 'plans'>('runs');

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <Tabs value={subTab} onValueChange={(v) => setSubTab(v as 'runs' | 'plans')} className="shrink-0 gap-0 pb-3">
        <TabsList>
          <TabsTrigger value="runs">Runs</TabsTrigger>
          <TabsTrigger value="plans">Plans</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex min-h-0 flex-1 flex-col">
        {subTab === 'runs' ? <QaPanel projectId={projectId} /> : <QaPlansPanel projectId={projectId} />}
      </div>
    </div>
  );
}

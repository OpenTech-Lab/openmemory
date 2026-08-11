'use client';

import dynamic from 'next/dynamic';

const SubagentOffice = dynamic(
  () => import('@/components/subagent-office').then((module) => module.SubagentOffice),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center bg-[#0b111a] text-sm text-slate-400">
        Loading subagent floor…
      </div>
    ),
  },
);

export default function SubagentOfficePage() {
  return <SubagentOffice />;
}

import Link from 'next/link';
import { ArrowUpRight, Database } from 'lucide-react';
import { NAV_GROUPS } from '@/lib/navigation';

export function AppDashboard() {
  const appCount = NAV_GROUPS.reduce((count, group) => count + group.items.length, 0);

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-[#f4f6f8] dark:bg-[#0b111a]">
      <div className="mx-auto min-h-full max-w-7xl px-5 py-8 sm:px-8 sm:py-10 lg:px-12">
        <section className="relative overflow-hidden rounded-2xl border border-slate-200/80 bg-white px-6 py-7 shadow-[0_12px_36px_rgba(15,23,42,0.07)] dark:border-slate-800 dark:bg-[#111a26] dark:shadow-[0_18px_50px_rgba(0,0,0,0.18)] sm:px-9 sm:py-9">
          <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-[#ff9900]/10 blur-3xl" />
          <div className="relative flex flex-col gap-7 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[#b56b00] dark:text-[#ffb84d]">
                Workspace / App launcher
              </p>
              <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-[-0.04em] text-slate-950 dark:text-white sm:text-4xl">
                <span className="grid size-10 place-items-center rounded-xl bg-[#ff9900] text-[#0b111a] shadow-[inset_0_-3px_0_rgba(0,0,0,0.12)]">
                  <Database className="size-5" strokeWidth={2.3} />
                </span>
                OpenMemory
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-slate-500 dark:text-slate-400">
                Your memory operations workspace. Choose an app to browse context, coordinate agents, and shape project knowledge.
              </p>
            </div>
            <div className="relative flex shrink-0 items-center gap-3 text-xs text-slate-500 dark:text-slate-400">
              <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
              <span><span className="font-semibold text-slate-800 dark:text-slate-200">{appCount}</span> apps available</span>
            </div>
          </div>
        </section>

        <div className="mt-9 space-y-9">
          {NAV_GROUPS.map((group) => (
            <section key={group.label} aria-labelledby={`dashboard-group-${group.label.toLowerCase()}`}>
              <div className="mb-4 flex items-center gap-3">
                <h2 id={`dashboard-group-${group.label.toLowerCase()}`} className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">
                  {group.label}
                </h2>
                <span className="h-px flex-1 bg-slate-200 dark:bg-slate-800" />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="group relative flex min-h-36 flex-col items-center justify-center rounded-xl border border-slate-200/90 bg-white px-3 py-5 text-center shadow-[0_2px_8px_rgba(15,23,42,0.035)] outline-none transition-[transform,box-shadow,border-color,background-color] duration-200 hover:-translate-y-1 hover:border-[#ff9900]/60 hover:bg-[#fffaf2] hover:shadow-[0_14px_26px_rgba(15,23,42,0.1)] focus-visible:ring-2 focus-visible:ring-[#ff9900] dark:border-slate-800 dark:bg-[#111a26] dark:hover:border-[#ff9900]/70 dark:hover:bg-[#172332]"
                  >
                    <span className="absolute right-3 top-3 text-slate-300 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 dark:text-slate-600">
                      <ArrowUpRight className="size-4" />
                    </span>
                    <span className="mb-4 grid size-14 place-items-center rounded-2xl bg-slate-100 text-slate-600 transition-colors group-hover:bg-[#ff9900]/15 group-hover:text-[#b56b00] dark:bg-slate-800 dark:text-slate-300 dark:group-hover:bg-[#ff9900]/15 dark:group-hover:text-[#ffb84d]">
                      <item.icon className="size-6" strokeWidth={1.8} />
                    </span>
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{item.label}</span>
                    <span className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-slate-400 dark:text-slate-500">{item.description}</span>
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

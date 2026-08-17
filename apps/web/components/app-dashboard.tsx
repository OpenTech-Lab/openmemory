'use client';

import Link from 'next/link';
import { ArrowUpRight, Database } from 'lucide-react';
import { NAV_GROUPS } from '@/lib/navigation';
import { useI18n } from '@/lib/i18n';

export function AppDashboard() {
  const appCount = NAV_GROUPS.reduce((count, group) => count + group.items.length, 0);
  const { t } = useI18n();

  return (
    <div className="min-h-0 flex-1 overflow-auto bg-background">
      <div className="mx-auto min-h-full max-w-7xl px-5 py-8 sm:px-8 sm:py-10 lg:px-12">
        <section className="relative overflow-hidden rounded-2xl border border-border bg-card px-6 py-7 shadow-sm sm:px-9 sm:py-9">
          <div className="pointer-events-none absolute -right-20 -top-24 size-72 rounded-full bg-[#ff9900]/10 blur-3xl" />
          <div className="relative flex flex-col gap-7 sm:flex-row sm:items-end sm:justify-between">
            <div className="max-w-2xl">
              <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.22em] text-[#b56b00] dark:text-[#ffb84d]">
                {t('dashboard.eyebrow')}
              </p>
              <h1 className="flex items-center gap-3 text-3xl font-semibold tracking-[-0.04em] text-card-foreground sm:text-4xl">
                <span className="grid size-10 place-items-center rounded-xl bg-[#ff9900] text-[#0b111a] shadow-[inset_0_-3px_0_rgba(0,0,0,0.12)]">
                  <Database className="size-5" strokeWidth={2.3} />
                </span>
                OpenMemory
              </h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                {t('dashboard.description')}
              </p>
            </div>
            <div className="relative flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span className="size-2 rounded-full bg-emerald-500 shadow-[0_0_0_4px_rgba(16,185,129,0.12)]" />
              <span>{t('dashboard.appsAvailable', { count: appCount })}</span>
            </div>
          </div>
        </section>

        <div className="mt-9 space-y-9">
          {NAV_GROUPS.map((group) => (
            <section key={group.label} aria-labelledby={`dashboard-group-${group.label.toLowerCase()}`}>
              <div className="mb-4 flex items-center gap-3">
                <h2 id={`dashboard-group-${group.label.toLowerCase()}`} className="text-[11px] font-bold uppercase tracking-[0.2em] text-muted-foreground">
                  {t(group.labelKey)}
                </h2>
                <span className="h-px flex-1 bg-border" />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-label={`${t(item.labelKey)}: ${t(item.descriptionKey)}`}
                    className="group relative z-0 flex min-h-28 flex-col items-center justify-center rounded-lg px-2 py-4 text-center outline-none transition-transform duration-200 hover:z-20 hover:-translate-y-1 focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-[#ff9900]"
                  >
                    <span className="absolute right-2 top-2 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                      <ArrowUpRight className="size-3.5" />
                    </span>
                    <span className="mb-2.5 grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground transition-colors group-hover:bg-[#ff9900]/15 group-hover:text-[#b56b00] dark:group-hover:text-[#ffb84d]">
                      <item.icon className="size-5" strokeWidth={1.8} />
                    </span>
                    <span className="text-xs font-semibold text-card-foreground sm:text-sm">{t(item.labelKey)}</span>
                    <span className="pointer-events-none absolute left-1/2 top-[calc(100%-0.5rem)] z-30 w-44 -translate-x-1/2 translate-y-1 rounded-md border border-border bg-foreground px-2.5 py-1.5 text-[10px] leading-3.5 text-background opacity-0 shadow-lg transition-[opacity,transform] duration-150 group-hover:translate-y-0 group-hover:opacity-100 group-focus-visible:translate-y-0 group-focus-visible:opacity-100">
                      {t(item.descriptionKey)}
                    </span>
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

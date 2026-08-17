'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  ChevronDown,
  Database,
  Grip,
  Globe2,
  Moon,
  Sun,
} from 'lucide-react';
import { NAV_GROUPS, isNavItemActive } from '@/lib/navigation';
import { useI18n } from '@/lib/i18n';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export function AppHeader() {
  const pathname = usePathname();
  const { resolvedTheme, theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useI18n();
  const activeItem = NAV_GROUPS
    .flatMap((group) => group.items.map((item) => ({ ...item, groupLabelKey: group.labelKey })))
    .find((item) => isNavItemActive(pathname, item.href));

  return (
    <header className="relative z-40 flex h-11 shrink-0 items-center bg-[#0b111a] text-slate-100 shadow-[0_1px_0_rgba(255,255,255,0.07),0_4px_14px_rgba(3,10,20,0.2)]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t('header.openNavigation')}
            className="group grid size-11 shrink-0 place-items-center bg-[#070c12] outline-none transition-colors hover:bg-[#172231] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff9900] data-[state=open]:bg-[#1c2938]"
          >
            <Grip className="size-5 transition-transform duration-200 group-data-[state=open]:rotate-45" strokeWidth={2.2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          className="ml-2 w-[calc(100vw-1rem)] max-w-[760px] rounded-sm border-border bg-background p-0 shadow-[0_18px_48px_rgba(3,10,20,0.28)]"
        >
          <div className="flex items-center justify-between border-b bg-muted/35 px-5 py-3.5">
            <div>
              <p className="text-sm font-semibold">{t('header.services')}</p>
              <p className="text-xs text-muted-foreground">{t('header.chooseWorkspace')}</p>
            </div>
            <span className="rounded-sm border bg-background px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              {t('header.navigation')}
            </span>
          </div>
          <div className="grid max-h-[min(72vh,640px)] grid-cols-1 gap-x-7 gap-y-5 overflow-y-auto p-4 sm:grid-cols-2">
            {NAV_GROUPS.map((group) => (
              <DropdownMenuGroup key={group.label}>
                <DropdownMenuLabel className="mb-1 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                  {t(group.labelKey)}
                </DropdownMenuLabel>
                <div className="space-y-0.5">
                  {group.items.map((item) => {
                    const isActive = isNavItemActive(pathname, item.href);
                    return (
                      <DropdownMenuItem key={item.href} asChild className="p-0 focus:bg-transparent">
                        <Link
                          href={item.href}
                          aria-current={isActive ? 'page' : undefined}
                          className={`group/item grid grid-cols-[2.25rem_1fr] gap-x-2 rounded-sm border-l-2 px-2 py-2 outline-none transition-colors ${
                            isActive
                              ? 'border-[#ff9900] bg-[#ff9900]/10'
                              : 'border-transparent hover:border-slate-300 hover:bg-muted/70 dark:hover:border-slate-600'
                          }`}
                        >
                          <span className={`row-span-2 grid size-8 place-items-center rounded-sm ${isActive ? 'bg-[#ff9900] text-[#182536]' : 'bg-muted text-muted-foreground group-hover/item:text-foreground'}`}>
                            <item.icon className="size-4" />
                          </span>
                          <span className="self-end text-sm font-semibold leading-tight">{t(item.labelKey)}</span>
                          <span className="text-[11px] leading-tight text-muted-foreground">{t(item.descriptionKey)}</span>
                        </Link>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              </DropdownMenuGroup>
            ))}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <Link href="/dashboard" className="flex h-full shrink-0 items-center gap-2.5 px-3.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff9900]">
        <span className="grid size-6 place-items-center rounded-sm bg-[#ff9900] text-[#0b111a] shadow-[inset_0_-2px_0_rgba(0,0,0,0.16)]">
          <Database className="size-3.5" strokeWidth={2.4} />
        </span>
        <span className="text-sm font-bold tracking-tight">OpenMemory</span>
      </Link>

      <div className="mx-1 hidden h-5 w-px bg-white/15 sm:block" />
      <div className="hidden min-w-0 items-center gap-1.5 px-3 text-xs sm:flex">
        <span className="text-slate-400">{activeItem ? t(activeItem.groupLabelKey) : t('header.console')}</span>
        <ChevronDown className="size-3 -rotate-90 text-slate-500" />
        <span className="truncate font-semibold text-slate-100">{activeItem ? t(activeItem.labelKey) : t('header.overview')}</span>
      </div>

      <div className="ml-auto flex h-full items-center border-l border-white/10">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={t('header.preferences')}
              className="flex h-full items-center gap-1.5 px-3 text-slate-300 outline-none transition-colors hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff9900] data-[state=open]:bg-white/10 data-[state=open]:text-white"
            >
              {resolvedTheme === 'dark' ? <Moon className="size-4" /> : <Sun className="size-4" />}
              <span className="hidden text-[11px] font-semibold uppercase tracking-[0.14em] sm:inline">{language}</span>
              <ChevronDown className="size-3 opacity-70" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={8} className="w-64 p-2">
            <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              {t('settings.appearance')}
            </DropdownMenuLabel>
            <div className="flex items-center gap-2 px-2 pb-1 text-sm font-medium">
              {resolvedTheme === 'dark' ? <Moon className="size-4 text-muted-foreground" /> : <Sun className="size-4 text-muted-foreground" />}
              {t('settings.theme')}
            </div>
            <DropdownMenuRadioGroup value={theme ?? 'system'} onValueChange={setTheme}>
              <DropdownMenuRadioItem value="light">{t('settings.theme.light')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">{t('settings.theme.dark')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">{t('settings.theme.system')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="px-2 pb-1 pt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
              {t('settings.language')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={language}
              onValueChange={(value) => {
                if (value === 'en' || value === 'ja') setLanguage(value);
              }}
            >
              <DropdownMenuRadioItem value="en"><Globe2 className="size-4" />{t('language.english')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="ja"><Globe2 className="size-4" />{t('language.japanese')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

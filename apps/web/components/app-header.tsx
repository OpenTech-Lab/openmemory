'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import {
  Bot,
  Boxes,
  ChevronDown,
  Columns3,
  Database,
  FolderOpen,
  GanttChartSquare,
  Gauge,
  GraduationCap,
  Grip,
  History,
  Image,
  LayoutList,
  Moon,
  Network,
  Search,
  Settings2,
  SlidersHorizontal,
  Sun,
  TrendingUp,
  Workflow,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const NAV_GROUPS = [
  {
    label: 'Memory',
    items: [
      { href: '/memory', label: 'Browse', description: 'View saved memories', icon: FolderOpen },
      { href: '/memory/search', label: 'Search', description: 'Find stored context', icon: Search },
      { href: '/memory/graph-memories', label: 'Graph', description: 'Explore connections', icon: Network },
    ],
  },
  {
    label: 'Projects',
    items: [
      { href: '/projects', label: 'List', description: 'Browse projects', icon: LayoutList },
      { href: '/projects/board', label: 'Board', description: 'Track work by status', icon: Columns3 },
      { href: '/projects/roadmap', label: 'Roadmap', description: 'Plan on a timeline', icon: GanttChartSquare },
      { href: '/lessons', label: 'Lessons', description: 'Review learned patterns', icon: GraduationCap },
      { href: '/library', label: 'Library', description: 'Browse visual assets', icon: Image },
    ],
  },
  {
    label: 'Agents',
    items: [
      { href: '/agents', label: 'Agents', description: 'Configure agents', icon: Bot },
      { href: '/agents/sessions', label: 'Sessions', description: 'Review activity', icon: History },
      { href: '/agents/usage', label: 'Usage', description: 'Inspect consumption', icon: Gauge },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings', label: 'LLM', description: 'Model configuration', icon: SlidersHorizontal },
      { href: '/settings/forecasts', label: 'Forecasts', description: 'Usage projections', icon: TrendingUp },
      { href: '/settings/environment', label: 'Environment', description: 'Runtime variables', icon: Settings2 },
      { href: '/settings/resources', label: 'Resources', description: 'Connected resources', icon: Boxes },
      { href: '/settings/workflows', label: 'Workflows', description: 'Automated routines', icon: Workflow },
    ],
  },
] as const;

const PROJECT_LIST_EXCLUDED_ROUTES = new Set(['/projects/board', '/projects/roadmap']);
const AGENT_LIST_EXCLUDED_ROUTES = new Set(['/agents/sessions', '/agents/usage']);

function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/memory' || href === '/settings') {
    return pathname === href;
  }

  if (href === '/projects') {
    const segments = pathname.split('/').filter(Boolean);
    return pathname === href
      || (segments.length === 2
        && segments[0] === 'projects'
        && !PROJECT_LIST_EXCLUDED_ROUTES.has(pathname));
  }

  if (href === '/agents') {
    const segments = pathname.split('/').filter(Boolean);
    return pathname === href
      || (segments.length === 2
        && segments[0] === 'agents'
        && !AGENT_LIST_EXCLUDED_ROUTES.has(pathname));
  }

  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AppHeader() {
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const activeItem = NAV_GROUPS
    .flatMap((group) => group.items.map((item) => ({ ...item, group: group.label })))
    .find((item) => isNavItemActive(pathname, item.href));

  return (
    <header className="relative z-40 flex h-11 shrink-0 items-center bg-[#0b111a] text-slate-100 shadow-[0_1px_0_rgba(255,255,255,0.07),0_4px_14px_rgba(3,10,20,0.2)]">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open navigation menu"
            className="group grid size-11 shrink-0 place-items-center border-r border-white/10 bg-[#070c12] outline-none transition-colors hover:bg-[#172231] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff9900] data-[state=open]:bg-[#1c2938]"
          >
            <Grip className="size-5 transition-transform duration-200 group-data-[state=open]:rotate-45" strokeWidth={2.2} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={8}
          className="ml-2 w-[calc(100vw-1rem)] max-w-[760px] rounded-sm border-slate-300/80 bg-background p-0 shadow-[0_18px_48px_rgba(3,10,20,0.28)] dark:border-slate-700"
        >
          <div className="flex items-center justify-between border-b bg-muted/35 px-5 py-3.5">
            <div>
              <p className="text-sm font-semibold">OpenMemory services</p>
              <p className="text-xs text-muted-foreground">Choose a workspace to continue</p>
            </div>
            <span className="rounded-sm border bg-background px-2 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Navigation
            </span>
          </div>
          <div className="grid max-h-[min(72vh,640px)] grid-cols-1 gap-x-7 gap-y-5 overflow-y-auto p-4 sm:grid-cols-2">
            {NAV_GROUPS.map((group) => (
              <DropdownMenuGroup key={group.label}>
                <DropdownMenuLabel className="mb-1 px-2 py-1 text-[11px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                  {group.label}
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
                          <span className="self-end text-sm font-semibold leading-tight">{item.label}</span>
                          <span className="text-[11px] leading-tight text-muted-foreground">{item.description}</span>
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

      <Link href="/memory" className="flex h-full shrink-0 items-center gap-2.5 px-3.5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff9900]">
        <span className="grid size-6 place-items-center rounded-sm bg-[#ff9900] text-[#0b111a] shadow-[inset_0_-2px_0_rgba(0,0,0,0.16)]">
          <Database className="size-3.5" strokeWidth={2.4} />
        </span>
        <span className="text-sm font-bold tracking-tight">OpenMemory</span>
      </Link>

      <div className="mx-1 hidden h-5 w-px bg-white/15 sm:block" />
      <div className="hidden min-w-0 items-center gap-1.5 px-3 text-xs sm:flex">
        <span className="text-slate-400">{activeItem?.group ?? 'Console'}</span>
        <ChevronDown className="size-3 -rotate-90 text-slate-500" />
        <span className="truncate font-semibold text-slate-100">{activeItem?.label ?? 'Overview'}</span>
      </div>

      <div className="ml-auto flex h-full items-center border-l border-white/10">
        <button
          type="button"
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          className="grid h-full w-11 place-items-center text-slate-300 outline-none transition-colors hover:bg-white/8 hover:text-white focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#ff9900]"
        >
          {resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </button>
      </div>
    </header>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTheme } from 'next-themes';
import { Database, FolderOpen, Search, Network, Bot, History, SlidersHorizontal, Settings2, Boxes, ChevronRight, MoreHorizontal, Sun, Moon, LayoutList, Columns3, GanttChartSquare, GraduationCap, Workflow } from 'lucide-react';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

const NAV_GROUPS = [
  {
    label: 'Memory',
    items: [
      { href: '/memory', label: 'Browse', icon: FolderOpen },
      { href: '/memory/search', label: 'Search', icon: Search },
      { href: '/memory/graph-memories', label: 'Graph', icon: Network },
    ],
  },
  {
    label: 'Projects',
    items: [
      { href: '/projects', label: 'List', icon: LayoutList },
      { href: '/projects/board', label: 'Board', icon: Columns3 },
      { href: '/projects/roadmap', label: 'Roadmap', icon: GanttChartSquare },
      { href: '/lessons', label: 'Lessons', icon: GraduationCap },
    ],
  },
  {
    label: 'Agents',
    items: [
      { href: '/agents', label: 'Agents', icon: Bot },
      { href: '/agents/sessions', label: 'Sessions', icon: History },
    ],
  },
  {
    label: 'Settings',
    items: [
      { href: '/settings', label: 'LLM', icon: SlidersHorizontal },
      { href: '/settings/environment', label: 'Environment', icon: Settings2 },
      { href: '/settings/resources', label: 'Resources', icon: Boxes },
      { href: '/settings/workflows', label: 'Workflows', icon: Workflow },
    ],
  },
] as const;

export function AppSidebar() {
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center justify-between px-2 py-2 group-data-[collapsible=icon]:justify-center">
          <div className="flex items-center gap-2 min-w-0 group-data-[collapsible=icon]:hidden">
            <Database className="h-5 w-5 text-primary shrink-0" />
            <span className="font-semibold truncate">OpenMemory</span>
          </div>
          <SidebarTrigger />
        </div>
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="space-y-0.5">
                {group.items.map((item) => {
                  // '/projects' also covers /projects/[id] detail pages, but not the
                  // separate /projects/board route (which has its own sidebar entry).
                  const isActive = item.href === '/projects'
                    ? pathname === '/projects' || (pathname.startsWith('/projects/') && !pathname.startsWith('/projects/board'))
                    : pathname === item.href || pathname.startsWith(`${item.href}/`);
                  return (
                    <SidebarMenuItem key={item.href}>
                      <SidebarMenuButton
                        asChild
                        isActive={isActive}
                        tooltip={item.label}
                        className="h-auto py-2 gap-3 px-3 text-sm font-medium"
                      >
                        <Link href={item.href}>
                          <item.icon className="shrink-0" />
                          <span className="flex-1">{item.label}</span>
                          {isActive && <ChevronRight className="size-3 shrink-0 text-muted-foreground" />}
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton tooltip="Menu" className="h-auto py-2 gap-3 px-3 text-sm font-medium">
                  <MoreHorizontal className="shrink-0" />
                  <span>Menu</span>
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="start" className="w-48">
                <DropdownMenuItem onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
                  {theme === 'dark'
                    ? <Sun className="h-4 w-4" />
                    : <Moon className="h-4 w-4" />}
                  {theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

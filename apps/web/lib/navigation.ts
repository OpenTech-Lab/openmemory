import {
  Bot,
  Boxes,
  Columns3,
  FolderOpen,
  GanttChartSquare,
  Gauge,
  GraduationCap,
  History,
  Image,
  LayoutList,
  Network,
  Search,
  Settings2,
  SlidersHorizontal,
  TrendingUp,
  Workflow,
  Database,
} from 'lucide-react';

export const NAV_GROUPS = [
  {
    label: 'Workspace',
    items: [
      { href: '/dashboard', label: 'Dashboard', description: 'Open the app launcher', icon: Database },
    ],
  },
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

export function isNavItemActive(pathname: string, href: string): boolean {
  if (href === '/memory' || href === '/settings' || href === '/dashboard') {
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

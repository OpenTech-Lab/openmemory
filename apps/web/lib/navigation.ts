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
    labelKey: 'nav.workspace',
    items: [
      { href: '/dashboard', label: 'Dashboard', labelKey: 'nav.dashboard', description: 'Open the app launcher', descriptionKey: 'nav.dashboard.description', icon: Database },
    ],
  },
  {
    label: 'Memory',
    labelKey: 'nav.memory',
    items: [
      { href: '/memory', label: 'Browse', labelKey: 'nav.memory.browse', description: 'View saved memories', descriptionKey: 'nav.memory.browse.description', icon: FolderOpen },
      { href: '/memory/search', label: 'Search', labelKey: 'nav.memory.search', description: 'Find stored context', descriptionKey: 'nav.memory.search.description', icon: Search },
      { href: '/memory/graph-memories', label: 'Graph', labelKey: 'nav.memory.graph', description: 'Explore connections', descriptionKey: 'nav.memory.graph.description', icon: Network },
    ],
  },
  {
    label: 'Projects',
    labelKey: 'nav.projects',
    items: [
      { href: '/projects', label: 'List', labelKey: 'nav.projects.list', description: 'Browse projects', descriptionKey: 'nav.projects.list.description', icon: LayoutList },
      { href: '/projects/board', label: 'Board', labelKey: 'nav.projects.board', description: 'Track work by status', descriptionKey: 'nav.projects.board.description', icon: Columns3 },
      { href: '/projects/roadmap', label: 'Roadmap', labelKey: 'nav.projects.roadmap', description: 'Plan on a timeline', descriptionKey: 'nav.projects.roadmap.description', icon: GanttChartSquare },
      { href: '/lessons', label: 'Lessons', labelKey: 'nav.projects.lessons', description: 'Review learned patterns', descriptionKey: 'nav.projects.lessons.description', icon: GraduationCap },
      { href: '/library', label: 'Library', labelKey: 'nav.projects.library', description: 'Browse visual assets', descriptionKey: 'nav.projects.library.description', icon: Image },
    ],
  },
  {
    label: 'Agents',
    labelKey: 'nav.agents',
    items: [
      { href: '/agents', label: 'Agents', labelKey: 'nav.agents.agents', description: 'Configure agents', descriptionKey: 'nav.agents.agents.description', icon: Bot },
      { href: '/agents/sessions', label: 'Sessions', labelKey: 'nav.agents.sessions', description: 'Review activity', descriptionKey: 'nav.agents.sessions.description', icon: History },
      { href: '/agents/usage', label: 'Usage', labelKey: 'nav.agents.usage', description: 'Inspect consumption', descriptionKey: 'nav.agents.usage.description', icon: Gauge },
    ],
  },
  {
    label: 'Settings',
    labelKey: 'nav.settings',
    items: [
      { href: '/settings', label: 'LLM', labelKey: 'nav.settings.llm', description: 'Model configuration', descriptionKey: 'nav.settings.llm.description', icon: SlidersHorizontal },
      { href: '/settings/forecasts', label: 'Forecasts', labelKey: 'nav.settings.forecasts', description: 'Usage projections', descriptionKey: 'nav.settings.forecasts.description', icon: TrendingUp },
      { href: '/settings/environment', label: 'Environment', labelKey: 'nav.settings.environment', description: 'Runtime variables', descriptionKey: 'nav.settings.environment.description', icon: Settings2 },
      { href: '/settings/resources', label: 'Resources', labelKey: 'nav.settings.resources', description: 'Connected resources', descriptionKey: 'nav.settings.resources.description', icon: Boxes },
      { href: '/settings/workflows', label: 'Workflows', labelKey: 'nav.settings.workflows', description: 'Automated routines', descriptionKey: 'nav.settings.workflows.description', icon: Workflow },
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

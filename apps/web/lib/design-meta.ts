import {
  LayoutGrid,
  Boxes,
  Workflow,
  Database,
  ArrowRightLeft,
  Rocket,
  Users,
  BookOpen,
  History,
  Globe,
  Swords,
  Cloud,
  type LucideIcon,
} from 'lucide-react';

export const DESIGN_KIND_GROUPS = {
  software: ['ui', 'structure', 'workflow', 'schema', 'sequence', 'deployment'],
  narrative: ['characters', 'plot', 'timeline', 'world', 'factions'],
  infrastructure: ['aws'],
} as const;

export const DESIGN_KINDS = [
  ...DESIGN_KIND_GROUPS.software,
  ...DESIGN_KIND_GROUPS.narrative,
  ...DESIGN_KIND_GROUPS.infrastructure,
] as const;

export type DesignKind = (typeof DESIGN_KINDS)[number];

interface DesignKindMeta {
  label: string;
  icon: LucideIcon;
  color: string;
  group: 'software' | 'narrative' | 'infrastructure';
}

export const DESIGN_KIND_META: Record<DesignKind, DesignKindMeta> = {
  ui: { label: 'UI', icon: LayoutGrid, color: 'border-blue-400 text-blue-600 dark:text-blue-400', group: 'software' },
  structure: { label: 'Structure', icon: Boxes, color: 'border-purple-400 text-purple-600 dark:text-purple-400', group: 'software' },
  workflow: { label: 'Workflow', icon: Workflow, color: 'border-yellow-400 text-yellow-600 dark:text-yellow-400', group: 'software' },
  schema: { label: 'DB Schema', icon: Database, color: 'border-green-400 text-green-600 dark:text-green-400', group: 'software' },
  sequence: { label: 'Sequence', icon: ArrowRightLeft, color: 'border-cyan-400 text-cyan-600 dark:text-cyan-400', group: 'software' },
  deployment: { label: 'Deployment', icon: Rocket, color: 'border-orange-400 text-orange-600 dark:text-orange-400', group: 'software' },
  characters: { label: 'Characters', icon: Users, color: 'border-pink-400 text-pink-600 dark:text-pink-400', group: 'narrative' },
  plot: { label: 'Plot', icon: BookOpen, color: 'border-indigo-400 text-indigo-600 dark:text-indigo-400', group: 'narrative' },
  timeline: { label: 'Timeline', icon: History, color: 'border-teal-400 text-teal-600 dark:text-teal-400', group: 'narrative' },
  world: { label: 'World', icon: Globe, color: 'border-emerald-400 text-emerald-600 dark:text-emerald-400', group: 'narrative' },
  factions: { label: 'Factions', icon: Swords, color: 'border-red-400 text-red-600 dark:text-red-400', group: 'narrative' },
  aws: { label: 'AWS', icon: Cloud, color: 'border-amber-400 text-amber-600 dark:text-amber-400', group: 'infrastructure' },
};

export const CUSTOM_DESIGN_KIND_COLOR = 'border-border text-muted-foreground';

// `kind` is an unconstrained TEXT column server-side, so free-text/unknown values are possible —
// fall back gracefully instead of crashing.
export function designKindMeta(kind: string): DesignKindMeta {
  return (
    DESIGN_KIND_META[kind as DesignKind] ?? {
      label: kind || 'Other',
      icon: Boxes,
      color: CUSTOM_DESIGN_KIND_COLOR,
      group: 'software',
    }
  );
}

export function designKindColor(kind: string): string {
  return designKindMeta(kind).color;
}

export const STARTER_TEMPLATES: Record<DesignKind, string> = {
  ui: `flowchart TD
    A[Screen: Home] --> B[Screen: Detail]
    B --> C[Component: Header]
    B --> D[Component: Content]`,
  structure: `flowchart TD
    App --> ModuleA[Module A]
    App --> ModuleB[Module B]
    ModuleA --> Shared[Shared Utils]
    ModuleB --> Shared`,
  workflow: `flowchart TD
    Start([Start]) --> Step1[Step 1]
    Step1 --> Decision{Condition?}
    Decision -->|Yes| Step2[Step 2]
    Decision -->|No| End([End])
    Step2 --> End`,
  schema: `erDiagram
    USER ||--o{ ORDER : places
    ORDER ||--|{ LINE_ITEM : contains
    USER {
        uuid id
        string email
    }
    ORDER {
        uuid id
        uuid user_id
        timestamp created_at
    }`,
  sequence: `sequenceDiagram
    participant Client
    participant Server
    Client->>Server: Request
    Server-->>Client: Response`,
  deployment: `flowchart LR
    Client --> LB[Load Balancer]
    LB --> App1[App Instance 1]
    LB --> App2[App Instance 2]
    App1 --> DB[(Database)]
    App2 --> DB`,
  characters: `graph LR
    Hero[Hero] -->|ally of| Mentor[Mentor]
    Hero -->|rival of| Antagonist[Antagonist]
    Mentor -->|betrayed by| Antagonist`,
  plot: `flowchart TD
    A[Setup] --> B[Inciting Incident]
    B --> C[Rising Action]
    C --> D[Climax]
    D --> E[Falling Action]
    E --> F[Resolution]`,
  timeline: `timeline
    title Story Timeline
    Chapter 1 : Inciting incident
    Chapter 5 : First confrontation
    Chapter 10 : Climax
    Chapter 12 : Resolution`,
  world: `graph TD
    World[World] --> RegionA[Region A]
    World --> RegionB[Region B]
    RegionA --> CityA[Capital City]
    RegionB --> CityB[Port City]`,
  factions: `graph LR
    FactionA[Faction A] -->|at war with| FactionB[Faction B]
    FactionA -->|allied with| FactionC[Faction C]
    FactionB -->|rival of| FactionC`,
  aws: `architecture-beta
    group cloud(logos:aws)["AWS Cloud"]

    service users(logos:aws-cloudfront)["CloudFront"] in cloud
    service api(logos:aws-api-gateway)["API Gateway"] in cloud
    service fn(logos:aws-lambda)["Lambda"] in cloud
    service db(logos:aws-rds)["RDS Postgres"] in cloud
    service files(logos:aws-s3)["S3 Bucket"] in cloud

    users:R --> L:api
    api:R --> L:fn
    fn:R --> L:db
    fn:B --> T:files`,
};

declare module 'd3-force-3d' {
  export interface SimulationNodeDatum3D {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface Simulation<NodeDatum extends SimulationNodeDatum3D> {
    nodes(): NodeDatum[];
    nodes(nodes: NodeDatum[]): this;
    force(name: string, force: unknown): this;
    alpha(): number;
    alpha(alpha: number): this;
    alphaDecay(decay: number): this;
    on(type: string, listener: (() => void) | null): this;
    stop(): this;
    restart(): this;
    tick(): this;
  }

  export function forceSimulation<NodeDatum extends SimulationNodeDatum3D>(
    nodes?: NodeDatum[],
    numDimensions?: number
  ): Simulation<NodeDatum>;

  export interface ForceLink<NodeDatum extends SimulationNodeDatum3D, LinkDatum> {
    (alpha: number): void;
    id(id: (node: NodeDatum, i: number, nodes: NodeDatum[]) => string): this;
    distance(distance: number | ((link: LinkDatum, i: number, links: LinkDatum[]) => number)): this;
    links(): LinkDatum[];
    links(links: LinkDatum[]): this;
  }

  export function forceLink<NodeDatum extends SimulationNodeDatum3D, LinkDatum>(
    links?: LinkDatum[]
  ): ForceLink<NodeDatum, LinkDatum>;

  export interface ForceManyBody {
    (alpha: number): void;
    strength(strength: number | ((node: unknown, i: number, nodes: unknown[]) => number)): this;
  }

  export function forceManyBody(): ForceManyBody;

  export interface ForceCenter {
    (alpha: number): void;
    x(x: number): this;
    y(y: number): this;
    z(z: number): this;
  }

  export function forceCenter(x?: number, y?: number, z?: number): ForceCenter;
}

'use client';

// GPU-instanced 3D force-directed graph renderer, shared by memory-graph-3d.tsx
// and project-graph-3d.tsx. Renders all nodes as one InstancedMesh and all
// edges as one LineSegments buffer (two draw calls total, regardless of graph
// size) instead of one THREE.Mesh/Line per node/edge — the fix for the
// frame-rate cliff a per-object renderer hits at a few thousand nodes.
//
// This component owns rendering, physics (d3-force-3d), and camera controls.
// Domain-specific concerns (node/edge coloring and sizing, detail panels,
// legends) belong to the caller — this only needs {id, color, size} nodes and
// {source, target, color} edges.

import { useEffect, useMemo, useRef, type RefObject } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  type Simulation,
  type SimulationNodeDatum3D,
} from 'd3-force-3d';

export interface ForceGraphNode {
  id: string;
  color: string;
  size: number;
}

export interface ForceGraphEdge {
  source: string;
  target: string;
  color: string;
}

interface Props {
  nodes: ForceGraphNode[];
  edges: ForceGraphEdge[];
  isDark: boolean;
  bgColor: string;
  onNodeClick: (id: string) => void;
  onBackgroundClick: () => void;
}

interface SimNode extends SimulationNodeDatum3D {
  id: string;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  color: string;
}

const NODE_GEOMETRY_ARGS: [number, number, number] = [1, 8, 6];

export function ForceGraph3D({ nodes, edges, isDark, bgColor, onNodeClick, onBackgroundClick }: Props) {
  const simNodes = useMemo<SimNode[]>(() => nodes.map((n) => ({ id: n.id })), [nodes]);
  const simLinks = useMemo<SimLink[]>(
    () => edges.map((e) => ({ source: e.source, target: e.target, color: e.color })),
    [edges]
  );

  // Kept in sync on every render (not just via effect) so child components
  // reading these refs during their first render/useMemo — before the
  // physics effect below has had a chance to run — already see live data
  // instead of an empty array.
  const simNodesRef = useRef<SimNode[]>(simNodes);
  const simLinksRef = useRef<SimLink[]>(simLinks);
  simNodesRef.current = simNodes;
  simLinksRef.current = simLinks;

  const simulationRef = useRef<Simulation<SimNode> | null>(null);

  useEffect(() => {
    const simulation = forceSimulation(simNodes, 3)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(24)
      )
      .force('charge', forceManyBody().strength(-35))
      .force('center', forceCenter());

    simulationRef.current = simulation;

    return () => {
      simulation.stop();
      simulationRef.current = null;
    };
  }, [simNodes, simLinks]);

  return (
    <Canvas dpr={[1, 1.5]} camera={{ position: [0, 0, 300], far: 5000 }} onPointerMissed={onBackgroundClick}>
      <color attach="background" args={[bgColor]} />
      <GraphEdges simLinksRef={simLinksRef} linkCount={simLinks.length} />
      <GraphNodes simNodesRef={simNodesRef} nodes={nodes} onSelect={onNodeClick} />
      <OrbitControls enableDamping dampingFactor={0.1} />
      {isDark && (
        <EffectComposer>
          <Bloom luminanceThreshold={0.15} luminanceSmoothing={0.3} intensity={1.1} mipmapBlur radius={0.5} />
        </EffectComposer>
      )}
    </Canvas>
  );
}

interface GraphNodesProps {
  simNodesRef: RefObject<SimNode[]>;
  nodes: ForceGraphNode[];
  onSelect: (id: string) => void;
}

function GraphNodes({ simNodesRef, nodes, onSelect }: GraphNodesProps) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const tempObject = useMemo(() => new THREE.Object3D(), []);
  const tempColor = useMemo(() => new THREE.Color(), []);

  useEffect(() => {
    const mesh = meshRef.current;
    if (!mesh) return;
    for (let i = 0; i < nodes.length; i++) {
      mesh.setColorAt(i, tempColor.set(nodes[i].color));
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [nodes, tempColor]);

  useEffect(() => {
    return () => {
      document.body.style.cursor = 'auto';
    };
  }, []);

  useFrame(() => {
    const mesh = meshRef.current;
    const simNodes = simNodesRef.current;
    if (!mesh || simNodes.length === 0) return;
    for (let i = 0; i < simNodes.length; i++) {
      const n = simNodes[i];
      tempObject.position.set(n.x ?? 0, n.y ?? 0, n.z ?? 0);
      tempObject.scale.setScalar(nodes[i]?.size ?? 1);
      tempObject.updateMatrix();
      mesh.setMatrixAt(i, tempObject.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });

  if (nodes.length === 0) return null;

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, nodes.length]}
      onClick={(e: ThreeEvent<MouseEvent>) => {
        e.stopPropagation();
        if (e.instanceId === undefined) return;
        const node = nodes[e.instanceId];
        if (!node) return;
        onSelect(node.id);
      }}
      onPointerOver={(e: ThreeEvent<PointerEvent>) => {
        e.stopPropagation();
        document.body.style.cursor = 'pointer';
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto';
      }}
    >
      <sphereGeometry args={NODE_GEOMETRY_ARGS} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

interface GraphEdgesProps {
  simLinksRef: RefObject<SimLink[]>;
  linkCount: number;
}

function GraphEdges({ simLinksRef, linkCount }: GraphEdgesProps) {
  const geometry = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(linkCount * 2 * 3);
    const colorAttr = new Float32Array(linkCount * 2 * 3);
    const links = simLinksRef.current;
    const color = new THREE.Color();
    for (let i = 0; i < linkCount; i++) {
      color.set(links[i]?.color ?? '#94a3b8');
      for (let v = 0; v < 2; v++) {
        const o = (i * 2 + v) * 3;
        colorAttr[o] = color.r;
        colorAttr[o + 1] = color.g;
        colorAttr[o + 2] = color.b;
      }
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(colorAttr, 3));
    return geo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkCount]);

  useEffect(() => {
    return () => geometry.dispose();
  }, [geometry]);

  useFrame(() => {
    const links = simLinksRef.current;
    if (links.length === 0) return;
    const position = geometry.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < links.length; i++) {
      const link = links[i];
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      const o = i * 2;
      position.setXYZ(o, source?.x ?? 0, source?.y ?? 0, source?.z ?? 0);
      position.setXYZ(o + 1, target?.x ?? 0, target?.y ?? 0, target?.z ?? 0);
    }
    position.needsUpdate = true;
  });

  if (linkCount === 0) return null;

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.6} />
    </lineSegments>
  );
}

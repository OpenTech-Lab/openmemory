'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { Billboard, OrbitControls, RoundedBox, Text } from '@react-three/drei';
import * as THREE from 'three';
import {
  Activity,
  ArrowUpRight,
  Bot,
  Boxes,
  Clock3,
  RefreshCw,
  Rotate3D,
  Server,
  Sparkles,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SUBAGENT_REFERENCE, type SubagentReference } from '@/lib/subagent-reference';

type ViewMode = 'isometric' | 'top';

interface WatcherAgent {
  id: string;
  name: string;
  enabled: boolean;
  is_builtin: boolean;
  description: string | null;
}

interface UsageAgent {
  agent_id: string;
  agent_name: string;
  session_count: number;
  message_count: number;
  last_active_at: string | null;
}

interface UsageSummary {
  totals: {
    agent_count: number;
    session_count: number;
    message_count: number;
  };
  agents: UsageAgent[];
}

interface OfficeRole extends SubagentReference {
  color: string;
  position: [number, number, number];
  index: number;
}

const OFFICE_ROLES: OfficeRole[] = [
  { ...SUBAGENT_REFERENCE[0], color: '#f0a36b', position: [-5.2, 0, -3.2], index: 0 },
  { ...SUBAGENT_REFERENCE[1], color: '#78b8e8', position: [0, 0, -3.2], index: 1 },
  { ...SUBAGENT_REFERENCE[2], color: '#c7a0f5', position: [5.2, 0, -3.2], index: 2 },
  { ...SUBAGENT_REFERENCE[3], color: '#5bc9b2', position: [-5.2, 0, 3.2], index: 3 },
  { ...SUBAGENT_REFERENCE[4], color: '#e5c461', position: [0, 0, 3.2], index: 4 },
  { ...SUBAGENT_REFERENCE[5], color: '#ef8194', position: [5.2, 0, 3.2], index: 5 },
];

const ACTIVE_WINDOW_MS = 30 * 60 * 1000;

function relativeTime(iso: string | null): string {
  if (!iso) return 'no heartbeat';
  const diffMinutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const hours = Math.floor(diffMinutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isRecentlyActive(iso: string | null): boolean {
  return !!iso && Date.now() - new Date(iso).getTime() < ACTIVE_WINDOW_MS;
}

export function SubagentOffice() {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === 'dark';
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('isometric');
  const [watcherAgents, setWatcherAgents] = useState<WatcherAgent[]>([]);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const selectedRole = useMemo(
    () => OFFICE_ROLES.find((role) => role.name === selectedName) ?? null,
    [selectedName],
  );

  const loadTelemetry = useCallback(async (background = false) => {
    if (background) setIsRefreshing(true);
    else setIsLoading(true);
    try {
      const [agentsResponse, usageResponse] = await Promise.all([
        fetch('/api/agents'),
        fetch('/api/agents/usage-summary'),
      ]);
      if (agentsResponse.ok) {
        const data = await agentsResponse.json();
        setWatcherAgents(data.agents ?? []);
      }
      if (usageResponse.ok) {
        setUsage(await usageResponse.json());
      }
    } catch {
      // Keep the reference floor usable when the watcher API is temporarily
      // unavailable; the next scheduled refresh will retry telemetry.
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadTelemetry();
    const interval = window.setInterval(() => void loadTelemetry(true), 60_000);
    return () => window.clearInterval(interval);
  }, [loadTelemetry]);

  const connectedCount = watcherAgents.filter((agent) => agent.enabled).length;
  const activeCount = usage?.agents.filter((agent) => isRecentlyActive(agent.last_active_at)).length ?? 0;
  const latestHeartbeat = useMemo(() => {
    const timestamps = (usage?.agents ?? [])
      .map((agent) => agent.last_active_at)
      .filter((timestamp): timestamp is string => !!timestamp)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime());
    return timestamps[0] ?? null;
  }, [usage]);

  const sortedUsageAgents = useMemo(
    () => [...(usage?.agents ?? [])].sort((a, b) => {
      if (isRecentlyActive(a.last_active_at) !== isRecentlyActive(b.last_active_at)) {
        return isRecentlyActive(a.last_active_at) ? -1 : 1;
      }
      return (b.last_active_at ? new Date(b.last_active_at).getTime() : 0)
        - (a.last_active_at ? new Date(a.last_active_at).getTime() : 0);
    }),
    [usage],
  );

  const sceneBackground = isDark ? '#0b111a' : '#e9e5dc';
  const panelBackground = isDark ? 'bg-[#101824]' : 'bg-[#f7f5ef]';
  const panelBorder = isDark ? 'border-white/10' : 'border-[#d8d1c5]';
  const mutedText = isDark ? 'text-slate-400' : 'text-[#716b61]';

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden ${isDark ? 'bg-[#0b111a] text-slate-100' : 'bg-[#e9e5dc] text-[#211f1b]'}`}>
      <header className={`flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-5 py-3 ${panelBorder} ${panelBackground}`}>
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[#5bc9b2]/35 bg-[#5bc9b2]/10 text-[#5bc9b2]">
            <Boxes className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate text-[10px] font-semibold uppercase tracking-[0.24em] text-[#5bc9b2]">OpenMemory / Agents</p>
              <span className={`h-1.5 w-1.5 rounded-full ${activeCount > 0 ? 'bg-[#5bc9b2] shadow-[0_0_10px_#5bc9b2]' : 'bg-[#e5c461]'}`} />
            </div>
            <h1 className="truncate text-lg font-semibold tracking-tight">Subagent office</h1>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`hidden items-center gap-2 rounded-full border px-3 py-1.5 text-xs sm:flex ${panelBorder} ${isDark ? 'bg-white/[0.03]' : 'bg-white/60'} ${mutedText}`}>
            <Activity className={`h-3.5 w-3.5 ${activeCount > 0 ? 'text-[#5bc9b2]' : 'text-[#e5c461]'}`} />
            {activeCount > 0 ? `${activeCount} active heartbeat${activeCount === 1 ? '' : 's'}` : 'quiet floor'}
          </div>
          <Button variant="outline" size="sm" onClick={() => setViewMode((mode) => mode === 'isometric' ? 'top' : 'isometric')} className="gap-1.5">
            <Rotate3D className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">{viewMode === 'isometric' ? 'Top down' : 'Isometric'}</span>
          </Button>
          <Button variant="outline" size="icon" onClick={() => void loadTelemetry(true)} disabled={isRefreshing} aria-label="Refresh office telemetry">
            <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </header>

      <main className="grid min-h-0 flex-1 grid-cols-1 overflow-auto xl:grid-cols-[minmax(0,1fr)_350px] xl:overflow-hidden">
        <section className={`relative min-h-[620px] overflow-hidden border-b xl:min-h-0 xl:border-b-0 xl:border-r ${panelBorder}`}>
          <div className="absolute inset-0">
            <Canvas
              key={`${viewMode}-${isDark ? 'dark' : 'light'}`}
              shadows
              dpr={[1, 1.5]}
              camera={{ position: viewMode === 'top' ? [0, 18, 0.01] : [15, 12, 15], fov: 38, near: 0.1, far: 100 }}
              onPointerMissed={() => setSelectedName(null)}
              gl={{ antialias: true, alpha: false }}
              fallback={<WebGlFallback isDark={isDark} />}
            >
              <color attach="background" args={[sceneBackground]} />
              <fog attach="fog" args={[sceneBackground, 20, 44]} />
              <ambientLight intensity={isDark ? 0.8 : 1.4} color={isDark ? '#b6d3df' : '#fff4dc'} />
              <directionalLight
                castShadow
                position={[7, 15, 8]}
                intensity={isDark ? 1.8 : 2.2}
                color={isDark ? '#b8d9f0' : '#fff0d1'}
                shadow-mapSize-width={2048}
                shadow-mapSize-height={2048}
              />
              <pointLight position={[-8, 5, -4]} intensity={isDark ? 20 : 9} distance={20} color="#5bc9b2" />
              <pointLight position={[8, 4, 5]} intensity={isDark ? 16 : 7} distance={17} color="#f0a36b" />
              <OfficeRoom
                isDark={isDark}
                roles={OFFICE_ROLES}
                selectedName={selectedName}
                onSelect={setSelectedName}
              />
              <OrbitControls
                enableDamping
                dampingFactor={0.08}
                minDistance={10}
                maxDistance={30}
                maxPolarAngle={Math.PI / 2.03}
                minPolarAngle={viewMode === 'top' ? 0.2 : 0.45}
                target={[0, 0.5, 0]}
              />
            </Canvas>
          </div>

          <div className="pointer-events-none absolute left-5 top-5">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] backdrop-blur-md ${panelBorder} ${isDark ? 'bg-[#101824]/85 text-slate-300' : 'bg-[#f7f5ef]/90 text-[#716b61]'}`}>
              <span className="h-1.5 w-1.5 rounded-full bg-[#5bc9b2] shadow-[0_0_9px_#5bc9b2]" />
              Floor 01 / Observatory
            </div>
            <p className={`mt-2 max-w-[280px] text-xs ${mutedText}`}>Six built-in modes, one shared memory plane.</p>
          </div>

          <div className={`pointer-events-none absolute bottom-5 left-5 rounded-xl border px-3 py-2 text-[11px] backdrop-blur-md ${panelBorder} ${isDark ? 'bg-[#101824]/85 text-slate-400' : 'bg-[#f7f5ef]/90 text-[#716b61]'}`}>
            <div className="flex items-center gap-3">
              <span><kbd className="mr-1 rounded border px-1 py-0.5 text-[9px]">drag</kbd> orbit</span>
              <span><kbd className="mr-1 rounded border px-1 py-0.5 text-[9px]">scroll</kbd> zoom</span>
              <span><kbd className="mr-1 rounded border px-1 py-0.5 text-[9px]">click</kbd> inspect</span>
            </div>
          </div>
        </section>

        <aside className={`min-h-0 overflow-y-auto ${panelBackground}`}>
          <div className="space-y-6 p-5">
            <section>
              <div className="mb-3 flex items-start justify-between gap-3">
                <div>
                  <p className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${mutedText}`}>Runtime telemetry</p>
                  <h2 className="mt-1 text-base font-semibold">Floor status</h2>
                </div>
                <span className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide ${panelBorder} ${activeCount > 0 ? 'text-[#5bc9b2]' : 'text-[#a58e48]'}`}>
                  <Wifi className="h-3 w-3" />
                  {activeCount > 0 ? 'live' : 'standby'}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <StatTile icon={<Users className="h-3.5 w-3.5" />} label="Connected tools" value={isLoading ? '—' : String(connectedCount)} color="#5bc9b2" isDark={isDark} />
                <StatTile icon={<Bot className="h-3.5 w-3.5" />} label="Active now" value={isLoading ? '—' : String(activeCount)} color="#f0a36b" isDark={isDark} />
                <StatTile icon={<Activity className="h-3.5 w-3.5" />} label="Sessions" value={isLoading ? '—' : (usage?.totals.session_count ?? 0).toLocaleString()} color="#78b8e8" isDark={isDark} />
                <StatTile icon={<Server className="h-3.5 w-3.5" />} label="Messages" value={isLoading ? '—' : formatCompact(usage?.totals.message_count ?? 0)} color="#c7a0f5" isDark={isDark} />
              </div>
              <p className={`mt-3 flex items-center gap-1.5 text-[11px] ${mutedText}`}>
                <Clock3 className="h-3 w-3" />
                Last heartbeat {relativeTime(latestHeartbeat)}
              </p>
            </section>

            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <p className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${mutedText}`}>Reference roster</p>
                  <h2 className="mt-1 text-base font-semibold">Choose a desk</h2>
                </div>
                <span className={`text-xs ${mutedText}`}>{OFFICE_ROLES.length} modes</span>
              </div>
              <div className="space-y-1.5">
                {OFFICE_ROLES.map((role) => {
                  const isSelected = selectedName === role.name;
                  return (
                    <button
                      key={role.name}
                      type="button"
                      onClick={() => setSelectedName(isSelected ? null : role.name)}
                      className={`group flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${isSelected ? 'border-[#5bc9b2]/60 bg-[#5bc9b2]/10' : `${panelBorder} ${isDark ? 'bg-white/[0.02] hover:bg-white/[0.06]' : 'bg-white/40 hover:bg-white/80'}`}`}
                      aria-pressed={isSelected}
                    >
                      <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: `${role.color}1c`, color: role.color }}>
                        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: role.color, boxShadow: `0 0 9px ${role.color}` }} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{role.name}</span>
                        <span className={`block truncate text-[10px] ${mutedText}`}>{role.mode}</span>
                      </span>
                      <ArrowUpRight className={`h-3.5 w-3.5 shrink-0 transition-opacity ${isSelected ? 'opacity-100 text-[#5bc9b2]' : `opacity-0 group-hover:opacity-60 ${mutedText}`}`} />
                    </button>
                  );
                })}
              </div>
            </section>

            {selectedRole ? (
              <section className={`relative rounded-2xl border p-4 ${panelBorder} ${isDark ? 'bg-white/[0.035]' : 'bg-white/65'}`}>
                <button type="button" onClick={() => setSelectedName(null)} className={`absolute right-3 top-3 rounded-md p-1 ${mutedText} hover:text-current`} aria-label="Close selected desk">
                  <X className="h-3.5 w-3.5" />
                </button>
                <div className="flex items-center gap-2 pr-5">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: selectedRole.color, boxShadow: `0 0 12px ${selectedRole.color}` }} />
                  <p className="text-base font-semibold">{selectedRole.name}</p>
                </div>
                <Badge variant="outline" className="mt-2 text-[10px]" style={{ borderColor: `${selectedRole.color}80`, color: selectedRole.color }}>
                  {selectedRole.mode}
                </Badge>
                <p className={`mt-3 text-xs leading-5 ${mutedText}`}>{selectedRole.purpose}</p>
                <div className={`mt-4 border-t pt-3 text-[11px] ${panelBorder} ${mutedText}`}>
                  <div className="flex items-center justify-between"><span>Floor state</span><span className="font-medium text-[#5bc9b2]">Ready for dispatch</span></div>
                  <div className="mt-1.5 flex items-center justify-between"><span>Data source</span><span>built-in reference</span></div>
                </div>
              </section>
            ) : (
              <section className={`rounded-2xl border border-dashed p-4 ${panelBorder}`}>
                <div className="flex items-center gap-2 text-[#5bc9b2]"><Sparkles className="h-4 w-4" /><span className="text-xs font-semibold">Select a desk</span></div>
                <p className={`mt-2 text-xs leading-5 ${mutedText}`}>Click a worker in the scene or choose a mode above to inspect its permission envelope and purpose.</p>
              </section>
            )}

            <section>
              <div className="mb-3 flex items-end justify-between">
                <div>
                  <p className={`text-[10px] font-semibold uppercase tracking-[0.2em] ${mutedText}`}>Watcher network</p>
                  <h2 className="mt-1 text-base font-semibold">Connected tools</h2>
                </div>
                <Link href="/agents" className="text-[11px] text-[#5bc9b2] hover:underline">Manage <ArrowUpRight className="inline h-3 w-3" /></Link>
              </div>
              <div className="space-y-2">
                {sortedUsageAgents.length === 0 ? (
                  <p className={`text-xs ${mutedText}`}>No watcher telemetry available yet.</p>
                ) : sortedUsageAgents.map((agent) => {
                  const active = isRecentlyActive(agent.last_active_at);
                  return (
                    <div key={agent.agent_id} className={`flex items-center gap-3 rounded-xl border px-3 py-2 ${panelBorder}`}>
                      <span className={`h-2 w-2 shrink-0 rounded-full ${active ? 'bg-[#5bc9b2] shadow-[0_0_8px_#5bc9b2]' : 'bg-slate-500/60'}`} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium">{agent.agent_name}</p>
                        <p className={`text-[10px] ${mutedText}`}>{active ? 'active now' : `last seen ${relativeTime(agent.last_active_at)}`}</p>
                      </div>
                      <span className={`text-[10px] tabular-nums ${mutedText}`}>{agent.session_count.toLocaleString()} sessions</span>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </aside>
      </main>
    </div>
  );
}

function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function WebGlFallback({ isDark }: { isDark: boolean }) {
  return (
    <div className={`flex h-full min-h-[620px] items-center justify-center p-8 text-center ${isDark ? 'bg-[#0b111a] text-slate-300' : 'bg-[#e9e5dc] text-[#4e514c]'}`}>
      <div className="max-w-sm">
        <Boxes className="mx-auto h-8 w-8 text-[#5bc9b2]" />
        <p className="mt-3 text-sm font-semibold">3D rendering is unavailable</p>
        <p className={`mt-2 text-xs leading-5 ${isDark ? 'text-slate-500' : 'text-[#716b61]'}`}>
          Your browser or graphics environment does not expose WebGL. The reference roster and live telemetry remain available in the panel.
        </p>
      </div>
    </div>
  );
}

function StatTile({ icon, label, value, color, isDark }: { icon: React.ReactNode; label: string; value: string; color: string; isDark: boolean }) {
  return (
    <div className={`rounded-xl border p-3 ${isDark ? 'border-white/10 bg-white/[0.025]' : 'border-[#d8d1c5] bg-white/50'}`}>
      <div className="flex items-center gap-1.5 text-[10px]" style={{ color }}>
        {icon}
        <span className="truncate text-[#716b61] dark:text-slate-400">{label}</span>
      </div>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function OfficeRoom({ isDark, roles, selectedName, onSelect }: { isDark: boolean; roles: OfficeRole[]; selectedName: string | null; onSelect: (name: string | null) => void }) {
  const floorColor = isDark ? '#192331' : '#d8d0c2';
  const gridPrimary = isDark ? '#314352' : '#b7ad9d';
  const gridSecondary = isDark ? '#202d3a' : '#c9c0b2';
  const wallColor = isDark ? '#15202d' : '#e2dbcf';
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow onClick={(event) => { event.stopPropagation(); onSelect(null); }}>
        <planeGeometry args={[30, 19]} />
        <meshStandardMaterial color={floorColor} roughness={0.86} metalness={0.08} />
      </mesh>
      <gridHelper args={[30, 30, gridPrimary, gridSecondary]} position={[0, 0.025, 0]} />

      <mesh position={[0, 2.3, -8.6]} receiveShadow>
        <boxGeometry args={[30, 4.6, 0.16]} />
        <meshStandardMaterial color={wallColor} roughness={0.72} metalness={0.12} />
      </mesh>
      <mesh position={[-14.9, 2.3, 0]} receiveShadow>
        <boxGeometry args={[0.16, 4.6, 17.2]} />
        <meshStandardMaterial color={wallColor} roughness={0.72} metalness={0.12} />
      </mesh>
      <mesh position={[14.9, 2.3, 0]} receiveShadow>
        <boxGeometry args={[0.16, 4.6, 17.2]} />
        <meshStandardMaterial color={wallColor} roughness={0.72} metalness={0.12} />
      </mesh>

      <BackWallSign isDark={isDark} />
      <CommandDeck isDark={isDark} />
      {roles.map((role) => (
        <OfficeDesk
          key={role.name}
          role={role}
          isDark={isDark}
          selected={selectedName === role.name}
          onSelect={() => onSelect(role.name)}
        />
      ))}
    </group>
  );
}

function BackWallSign({ isDark }: { isDark: boolean }) {
  return (
    <group position={[0, 3.2, -8.48]}>
      <RoundedBox args={[7.6, 1.35, 0.08]} radius={0.12} smoothness={4}>
        <meshStandardMaterial color={isDark ? '#0d151f' : '#f7f1e7'} roughness={0.55} metalness={0.18} />
      </RoundedBox>
      <Billboard position={[0, 0.22, 0.08]}>
        <Text fontSize={0.34} color="#5bc9b2" anchorX="center" anchorY="middle" letterSpacing={0.08}>OPENMEMORY</Text>
        <Text position={[0, -0.42, 0]} fontSize={0.12} color={isDark ? '#9aaabd' : '#82786b'} anchorX="center" anchorY="middle" letterSpacing={0.12}>PERSISTENT MEMORY / SUBAGENT OPERATIONS</Text>
      </Billboard>
      <mesh position={[-5.15, -0.25, 0.07]}>
        <boxGeometry args={[3.8, 0.025, 0.025]} />
        <meshBasicMaterial color="#5bc9b2" toneMapped={false} />
      </mesh>
      <mesh position={[5.15, -0.25, 0.07]}>
        <boxGeometry args={[3.8, 0.025, 0.025]} />
        <meshBasicMaterial color="#f0a36b" toneMapped={false} />
      </mesh>
    </group>
  );
}

function CommandDeck({ isDark }: { isDark: boolean }) {
  const accent = '#5bc9b2';
  return (
    <group position={[0, 0, 0]}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.04, 0]}>
        <ringGeometry args={[2.15, 2.28, 64]} />
        <meshBasicMaterial color={accent} transparent opacity={isDark ? 0.56 : 0.8} toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.46, 0]} castShadow>
        <cylinderGeometry args={[1.55, 1.7, 0.82, 48]} />
        <meshStandardMaterial color={isDark ? '#20303a' : '#b8a895'} roughness={0.42} metalness={0.46} />
      </mesh>
      <mesh position={[0, 0.91, 0]}>
        <cylinderGeometry args={[1.25, 1.25, 0.045, 48]} />
        <meshStandardMaterial color={isDark ? '#0a131d' : '#302e2a'} roughness={0.26} metalness={0.74} emissive="#5bc9b2" emissiveIntensity={isDark ? 0.25 : 0.08} />
      </mesh>
      <mesh position={[0, 1.02, 0]}>
        <torusGeometry args={[0.72, 0.035, 10, 48]} />
        <meshBasicMaterial color={accent} toneMapped={false} />
      </mesh>
      <Billboard position={[0, 2.15, 0]}>
        <Text fontSize={0.18} color={isDark ? '#cbd5e1' : '#4e514c'} anchorX="center" anchorY="middle" letterSpacing={0.1}>COMMAND DECK</Text>
        <Text position={[0, -0.25, 0]} fontSize={0.1} color="#5bc9b2" anchorX="center" anchorY="middle" letterSpacing={0.1}>MEMORY BUS ONLINE</Text>
      </Billboard>
    </group>
  );
}

function OfficeDesk({ role, isDark, selected, onSelect }: { role: OfficeRole; isDark: boolean; selected: boolean; onSelect: () => void }) {
  const tableColor = isDark ? '#263645' : '#b7a38a';
  const darkMetal = isDark ? '#101a25' : '#4f4a43';
  return (
    <group position={role.position} onClick={(event: ThreeEvent<MouseEvent>) => { event.stopPropagation(); onSelect(); }}>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.035, 0]}>
        <ringGeometry args={[1.93, 2.02, 48]} />
        <meshBasicMaterial color={role.color} transparent opacity={selected ? 0.92 : 0.18} toneMapped={false} />
      </mesh>
      <RoundedBox args={[3.45, 0.18, 1.78]} radius={0.1} smoothness={4} position={[0, 1.34, 0]} castShadow>
        <meshStandardMaterial color={tableColor} roughness={0.54} metalness={0.25} />
      </RoundedBox>
      {[[-1.38, 0.64, -0.66], [1.38, 0.64, -0.66], [-1.38, 0.64, 0.66], [1.38, 0.64, 0.66]].map(([x, y, z]) => (
        <mesh key={`${x}-${z}`} position={[x, y, z]} castShadow>
          <boxGeometry args={[0.12, 1.2, 0.12]} />
          <meshStandardMaterial color={darkMetal} roughness={0.45} metalness={0.66} />
        </mesh>
      ))}
      <mesh position={[0, 0.56, 0.92]} castShadow>
        <boxGeometry args={[1.25, 0.12, 0.95]} />
        <meshStandardMaterial color={darkMetal} roughness={0.7} metalness={0.08} />
      </mesh>
      <mesh position={[0, 1.02, 0.82]} castShadow>
        <boxGeometry args={[1.1, 0.9, 0.12]} />
        <meshStandardMaterial color={darkMetal} roughness={0.35} metalness={0.8} />
      </mesh>
      <mesh position={[0, 1.02, 0.75]}>
        <boxGeometry args={[0.92, 0.68, 0.025]} />
        <meshStandardMaterial color={isDark ? '#09151a' : '#213638'} emissive={role.color} emissiveIntensity={selected ? 0.85 : 0.34} roughness={0.32} metalness={0.25} />
      </mesh>
      <mesh position={[-0.44, 1.48, 0.64]}>
        <boxGeometry args={[0.62, 0.025, 0.28]} />
        <meshStandardMaterial color={isDark ? '#bdd2db' : '#e4ded3'} roughness={0.68} />
      </mesh>
      <mesh position={[0.74, 1.49, 0.61]}>
        <cylinderGeometry args={[0.09, 0.09, 0.18, 12]} />
        <meshStandardMaterial color={role.color} emissive={role.color} emissiveIntensity={0.5} />
      </mesh>
      <OfficeChair position={[0, 0.66, 1.54]} color={role.color} />
      <SubagentAvatar position={[-0.68, 1.43, 0.22]} color={role.color} selected={selected} phase={role.index * 0.9} />
      <mesh position={[1.34, 1.51, -0.67]}>
        <sphereGeometry args={[0.055, 12, 8]} />
        <meshBasicMaterial color={role.color} toneMapped={false} />
      </mesh>
      <Billboard position={[0, 3.03, 0]}>
        <Text fontSize={0.27} color={isDark ? '#e6edf4' : '#2c322e'} anchorX="center" anchorY="middle" outlineWidth={0.012} outlineColor={isDark ? '#0b111a' : '#e9e5dc'}>{role.name.toUpperCase()}</Text>
        <Text position={[0, -0.3, 0]} fontSize={0.115} color={role.color} anchorX="center" anchorY="middle" letterSpacing={0.06}>READY / {role.mode.split(' ')[0].toUpperCase()}</Text>
      </Billboard>
    </group>
  );
}

function OfficeChair({ position, color }: { position: [number, number, number]; color: string }) {
  return (
    <group position={position} rotation={[0, Math.PI, 0]}>
      <mesh position={[0, 0.06, 0]}>
        <cylinderGeometry args={[0.48, 0.48, 0.1, 20]} />
        <meshStandardMaterial color="#1c2733" roughness={0.58} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.5, 0.15]}>
        <boxGeometry args={[0.76, 0.88, 0.12]} />
        <meshStandardMaterial color="#1c2733" roughness={0.58} metalness={0.3} />
      </mesh>
      <mesh position={[0, 0.92, 0.1]}>
        <boxGeometry args={[0.25, 0.04, 0.28]} />
        <meshBasicMaterial color={color} toneMapped={false} />
      </mesh>
    </group>
  );
}

function SubagentAvatar({ position, color, selected, phase }: { position: [number, number, number]; color: string; selected: boolean; phase: number }) {
  const groupRef = useRef<THREE.Group>(null);
  useFrame(({ clock }) => {
    if (!groupRef.current) return;
    const amount = selected ? 0.06 : 0.025;
    groupRef.current.position.y = position[1] + Math.sin(clock.elapsedTime * 1.7 + phase) * amount;
  });
  return (
    <group ref={groupRef} position={position}>
      <mesh position={[0, 0.42, 0]} castShadow>
        <cylinderGeometry args={[0.23, 0.3, 0.62, 12]} />
        <meshStandardMaterial color={color} roughness={0.72} metalness={0.04} />
      </mesh>
      <mesh position={[0, 0.88, 0]} castShadow>
        <sphereGeometry args={[0.25, 16, 12]} />
        <meshStandardMaterial color="#f0cdb9" roughness={0.76} />
      </mesh>
      <mesh position={[0, 1.07, -0.015]}>
        <sphereGeometry args={[0.255, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.52]} />
        <meshStandardMaterial color="#1a2430" roughness={0.62} />
      </mesh>
      <mesh position={[-0.08, 0.43, 0.23]} rotation={[0, 0, -0.22]}>
        <boxGeometry args={[0.08, 0.44, 0.08]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0.08, 0.43, 0.23]} rotation={[0, 0, 0.22]}>
        <boxGeometry args={[0.08, 0.44, 0.08]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[-0.08, 0.04, 0]} rotation={[0, 0, -0.08]}>
        <boxGeometry args={[0.09, 0.36, 0.09]} />
        <meshStandardMaterial color="#273544" roughness={0.72} />
      </mesh>
      <mesh position={[0.08, 0.04, 0]} rotation={[0, 0, 0.08]}>
        <boxGeometry args={[0.09, 0.36, 0.09]} />
        <meshStandardMaterial color="#273544" roughness={0.72} />
      </mesh>
      <mesh position={[0, 0.88, 0.232]}>
        <sphereGeometry args={[0.028, 8, 8]} />
        <meshBasicMaterial color="#24313a" />
      </mesh>
    </group>
  );
}

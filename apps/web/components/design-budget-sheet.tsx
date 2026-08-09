'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calculator, ChevronDown, ChevronLeft, ChevronUp, DollarSign, Pencil, Plus, RefreshCw, Sparkles, Trash2, TrendingUp } from 'lucide-react';
import { CartesianGrid, Line, LineChart, Treemap, XAxis, YAxis } from 'recharts';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type { ForecastProfile } from '@/lib/forecast-types';

interface BudgetLineItem {
  service: string;
  usage: string;
  monthly_cost_cents: number;
  notes?: string | null;
}

interface DesignBudgetForecast {
  id: string;
  design_id: string;
  forecast_profile_id: string | null;
  name: string;
  conditions: string | null;
  currency: string;
  monthly_total_cents: number;
  line_items: BudgetLineItem[];
  confidence: 'low' | 'medium' | 'high';
  pricing_basis: string | null;
  created_by: 'human' | 'agent';
  updated_at: string;
}

interface BudgetDraftItem { service: string; usage: string; monthlyCost: string; notes: string }

interface DesignBudgetSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  design: { id: string; title: string; kind: string; source: string } | null;
}

const emptyItem = (): BudgetDraftItem => ({ service: '', usage: '', monthlyCost: '', notes: '' });
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
const usdCompact = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100);
const PROJECTION_MONTHS = 36;

export function DesignBudgetSheet({ open, onOpenChange, projectId, design }: DesignBudgetSheetProps) {
  const [forecasts, setForecasts] = useState<DesignBudgetForecast[]>([]);
  const [profiles, setProfiles] = useState<ForecastProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<'list' | 'form'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [profileId, setProfileId] = useState('custom');
  const [conditions, setConditions] = useState('');
  const [items, setItems] = useState<BudgetDraftItem[]>([emptyItem()]);
  const [confidence, setConfidence] = useState<'low' | 'medium' | 'high'>('low');
  const [pricingBasis, setPricingBasis] = useState('');
  const [estimating, setEstimating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => setExpandedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const load = useCallback(async () => {
    if (!design) return;
    setLoading(true);
    try {
      const [budgetsResponse, profilesResponse] = await Promise.all([
        fetch(`/api/projects/${projectId}/designs/${design.id}/budgets`),
        fetch('/api/forecast-profiles'),
      ]);
      const budgetsData = await budgetsResponse.json();
      const profilesData = await profilesResponse.json();
      if (!budgetsResponse.ok) throw new Error(budgetsData.error ?? 'Failed to load budgets');
      setForecasts(budgetsData.forecasts ?? []);
      setProfiles(profilesData.profiles ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load budgets');
    } finally { setLoading(false); }
  }, [design, projectId]);

  useEffect(() => {
    if (open) { setMode('list'); setExpandedIds(new Set()); load(); }
  }, [open, load]);

  const profileMap = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const draftTotalCents = items.reduce((sum, item) => sum + Math.max(0, Math.round((Number(item.monthlyCost) || 0) * 100)), 0);

  // Cumulative 3-year spend per scenario, compounding each scenario's own
  // forecast-profile annual growth rate monthly. A scenario with no linked
  // profile (custom conditions) projects flat (0% growth).
  const projection = useMemo(() => {
    const withCost = forecasts.filter((forecast) => forecast.monthly_total_cents > 0);
    if (withCost.length === 0) return null;

    const series = withCost.map((forecast, index) => {
      const profile = forecast.forecast_profile_id ? profileMap.get(forecast.forecast_profile_id) : undefined;
      const annualGrowthPercent = profile?.annual_growth_percent ?? 0;
      const monthlyMultiplier = Math.pow(1 + annualGrowthPercent / 100, 1 / 12);
      const color = `var(--chart-${(index % 5) + 1})`;
      return { id: forecast.id, name: forecast.name, baseCents: forecast.monthly_total_cents, monthlyMultiplier, color };
    });

    const running = Object.fromEntries(series.map((s) => [s.id, 0])) as Record<string, number>;
    const points = Array.from({ length: PROJECTION_MONTHS }, (_, i) => {
      const point: Record<string, number> = { month: i + 1 };
      for (const s of series) {
        running[s.id] += s.baseCents * Math.pow(s.monthlyMultiplier, i);
        point[s.id] = Math.round(running[s.id]);
      }
      return point;
    });

    const totals = Object.fromEntries(series.map((s) => [s.id, points[points.length - 1][s.id]])) as Record<string, number>;
    const config: ChartConfig = Object.fromEntries(series.map((s) => [s.id, { label: s.name, color: s.color }]));

    return { series, points, totals, config };
  }, [forecasts, profileMap]);

  const startNew = () => {
    setEditingId(null); setName(`${design?.title ?? 'Design'} budget`); setProfileId(profiles[0]?.id ?? 'custom');
    setConditions(''); setItems([emptyItem()]); setConfidence('low'); setPricingBasis(''); setMode('form');
  };

  const startEdit = (forecast: DesignBudgetForecast) => {
    setEditingId(forecast.id); setName(forecast.name); setProfileId(forecast.forecast_profile_id ?? 'custom');
    setConditions(forecast.conditions ?? ''); setConfidence(forecast.confidence); setPricingBasis(forecast.pricing_basis ?? '');
    setItems(forecast.line_items.map((item) => ({ service: item.service, usage: item.usage, monthlyCost: (item.monthly_cost_cents / 100).toFixed(2), notes: item.notes ?? '' })));
    setMode('form');
  };

  const estimate = async () => {
    if (!design) return;
    if (profileId === 'custom' && !conditions.trim()) { toast.error('Describe the workload or choose a saved forecast'); return; }
    setEstimating(true);
    try {
      const response = await fetch('/api/memory', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'ai.budget_forecast', design_id: design.id,
          ...(profileId !== 'custom' ? { forecast_profile_id: profileId } : {}),
          ...(conditions.trim() ? { conditions: conditions.trim() } : {}) }),
      });
      const data = await response.json();
      if (!response.ok || data.error) throw new Error(data.error ?? 'Estimate failed');
      const estimateData = data.estimate;
      setItems((estimateData.line_items ?? []).map((item: BudgetLineItem) => ({
        service: item.service, usage: item.usage, monthlyCost: (item.monthly_cost_cents / 100).toFixed(2), notes: item.notes ?? '',
      })));
      setConfidence(estimateData.confidence ?? 'low'); setPricingBasis(estimateData.pricing_basis ?? '');
      toast.success('Estimate ready — review the assumptions and costs');
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Estimate failed'); }
    finally { setEstimating(false); }
  };

  const save = async () => {
    if (!design || !name.trim()) { toast.error('Name this forecast'); return; }
    const lineItems = items.filter((item) => item.service.trim()).map((item) => ({
      service: item.service.trim(), usage: item.usage.trim(), monthly_cost_cents: Math.max(0, Math.round((Number(item.monthlyCost) || 0) * 100)), notes: item.notes.trim() || null,
    }));
    if (!lineItems.length) { toast.error('Add at least one service cost'); return; }
    setSaving(true);
    try {
      const url = `/api/projects/${projectId}/designs/${design.id}/budgets${editingId ? `/${editingId}` : ''}`;
      const response = await fetch(url, { method: editingId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        name: name.trim(), forecast_profile_id: profileId === 'custom' ? null : profileId,
        conditions: conditions.trim() || null, currency: 'USD', line_items: lineItems,
        confidence, pricing_basis: pricingBasis.trim() || null,
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to save budget');
      toast.success(editingId ? 'Budget forecast updated' : 'Budget forecast saved');
      setMode('list'); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to save budget'); }
    finally { setSaving(false); }
  };

  const remove = async (forecast: DesignBudgetForecast) => {
    if (!design || !window.confirm(`Delete “${forecast.name}”?`)) return;
    const response = await fetch(`/api/projects/${projectId}/designs/${design.id}/budgets/${forecast.id}`, { method: 'DELETE' });
    if (response.ok) { toast.success('Budget forecast deleted'); await load(); }
    else toast.error('Failed to delete budget forecast');
  };

  return <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent side="right" className="w-full overflow-hidden p-0 sm:max-w-xl">
      <SheetHeader className="border-b bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_48%)] p-5 pr-12">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary"><Calculator className="h-4 w-4" /> Cost envelope</div>
        <SheetTitle className="text-xl">{design?.title}</SheetTitle>
        <SheetDescription>Compare monthly infrastructure scenarios for this design.</SheetDescription>
      </SheetHeader>

      {mode === 'list' ? <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <p className="text-sm text-muted-foreground">{forecasts.length} saved scenario{forecasts.length === 1 ? '' : 's'}</p>
          <div className="flex gap-1"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={load}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button><Button size="sm" onClick={startNew}><Plus className="mr-1 h-4 w-4" /> Add forecast</Button></div>
        </div>
        <div className="flex-1 space-y-3 overflow-y-auto p-5">
          {!loading && forecasts.length === 0 && <div className="rounded-xl border border-dashed px-5 py-12 text-center"><DollarSign className="mx-auto h-8 w-8 text-muted-foreground/40" /><p className="mt-3 font-medium">No cost scenarios yet</p><p className="mt-1 text-sm text-muted-foreground">Use a saved usage profile or describe custom conditions.</p><Button variant="outline" className="mt-4" onClick={startNew}>Create first forecast</Button></div>}
          {projection && <div className="border-b pb-4">
            <div className="flex items-center gap-2 text-sm font-semibold"><TrendingUp className="h-4 w-4 text-primary" /> 3-year cost projection</div>
            <ChartContainer config={projection.config} className="mt-3 h-[220px] w-full">
              <LineChart data={projection.points} margin={{ left: 4, right: 8, top: 8, bottom: 0 }}>
                <CartesianGrid vertical={false} />
                <XAxis dataKey="month" type="number" domain={[1, PROJECTION_MONTHS]} ticks={[12, 24, 36]} tickFormatter={(month) => `Yr ${month / 12}`} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(value) => usdCompact(value)} tickLine={false} axisLine={false} width={52} />
                <ChartTooltip content={<ChartTooltipContent labelFormatter={(_, payload) => `Month ${payload?.[0]?.payload?.month ?? ''}`} formatter={(value, name) => <div className="flex flex-1 items-center justify-between gap-3"><span className="text-muted-foreground">{projection.config[name as string]?.label ?? name}</span><span className="font-mono font-medium tabular-nums text-foreground">{usd(Number(value))}</span></div>} />} />
                {projection.series.map((s) => <Line key={s.id} dataKey={s.id} type="monotone" stroke={s.color} strokeWidth={2} dot={false} />)}
              </LineChart>
            </ChartContainer>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
              {projection.series.map((s) => <div key={s.id} className="flex items-center gap-1.5 text-xs"><span className="h-2 w-2 shrink-0 rounded-[2px]" style={{ backgroundColor: s.color }} /><span className="text-muted-foreground">{s.name}</span><span className="font-semibold tabular-nums">{usd(projection.totals[s.id])}</span></div>)}
            </div>
          </div>}
          {forecasts.map((forecast) => {
            const profile = forecast.forecast_profile_id ? profileMap.get(forecast.forecast_profile_id) : undefined;
            const budgetCents = (profile?.monthly_budget_usd ?? 0) * 100;
            const ratio = budgetCents ? forecast.monthly_total_cents / budgetCents : 0;
            const isExpanded = expandedIds.has(forecast.id);
            const itemCount = forecast.line_items.length;
            const hasDetails = itemCount > 0 || forecast.conditions || forecast.pricing_basis;
            return <article key={forecast.id} className="overflow-hidden rounded-xl border bg-card">
              <div className="p-4"><div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold">{forecast.name}</h3><Badge variant="outline" className="capitalize">{forecast.confidence} confidence</Badge>{forecast.created_by === 'agent' && <Badge variant="secondary">Agent</Badge>}</div><div className="mt-2 text-3xl font-semibold tracking-tight">{usd(forecast.monthly_total_cents)}<span className="ml-1 text-sm font-normal text-muted-foreground">/ month</span></div></div><div className="flex"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(forecast)}><Pencil className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-8 w-8 hover:text-destructive" onClick={() => remove(forecast)}><Trash2 className="h-3.5 w-3.5" /></Button></div></div>
                {profile && <div className="mt-3"><div className="mb-1 flex justify-between text-xs"><span>{profile.name}</span><span className={ratio > 1 ? 'text-destructive' : 'text-emerald-600'}>{ratio > 1 ? `${Math.round((ratio - 1) * 100)}% over budget` : `${Math.round((1 - ratio) * 100)}% headroom`}</span></div><Progress value={Math.min(100, ratio * 100)} className={ratio > 1 ? '[&_[data-slot=progress-indicator]]:bg-destructive' : '[&_[data-slot=progress-indicator]]:bg-emerald-500'} /></div>}
                {hasDetails && <button type="button" onClick={() => toggleExpanded(forecast.id)} className="mt-3 flex w-full items-center justify-between text-xs font-medium text-muted-foreground transition-colors hover:text-foreground">
                  <span>{isExpanded ? 'Hide details' : `Show details · ${itemCount} service${itemCount === 1 ? '' : 's'}`}</span>
                  {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>}
              </div>
              {isExpanded && <>
              {forecast.monthly_total_cents > 0 && <div className="border-t p-4">
                <p className="mb-2 text-xs font-medium text-muted-foreground">Share of monthly total</p>
                <ChartContainer config={{}} className="h-[170px] w-full">
                  <Treemap
                    data={forecast.line_items.map((item, index) => ({
                      name: item.service,
                      value: item.monthly_cost_cents,
                      pct: Math.round((item.monthly_cost_cents / forecast.monthly_total_cents) * 100),
                      fill: `var(--chart-${(index % 5) + 1})`,
                    }))}
                    dataKey="value"
                    isAnimationActive={false}
                    content={<BudgetTreemapCell />}
                  />
                </ChartContainer>
              </div>}
              <div className="divide-y border-t">{forecast.line_items.map((item, index) => <div key={`${item.service}-${index}`} className="grid grid-cols-[1fr_auto] gap-3 px-4 py-3"><div><p className="text-sm font-medium">{item.service}</p><p className="text-xs text-muted-foreground">{item.usage}</p></div><span className="text-sm tabular-nums">{usd(item.monthly_cost_cents)}</span></div>)}</div>
              {(forecast.conditions || forecast.pricing_basis) && <div className="border-t bg-muted/30 px-4 py-3 text-xs leading-5 text-muted-foreground">{forecast.conditions && <p>{forecast.conditions}</p>}{forecast.pricing_basis && <p className="mt-1"><span className="font-medium text-foreground">Basis:</span> {forecast.pricing_basis}</p>}</div>}</>}
            </article>;
          })}
        </div>
        <div className="border-t bg-amber-50 px-5 py-3 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-300"><AlertTriangle className="mr-1 inline h-3.5 w-3.5" />Planning estimates only. Verify AWS costs with the official calculator before committing spend.</div>
      </div> : <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center justify-between border-b px-5 py-3"><Button variant="ghost" size="sm" onClick={() => setMode('list')}><ChevronLeft className="mr-1 h-4 w-4" />Scenarios</Button><span className="text-xs text-muted-foreground">{editingId ? 'Editing forecast' : 'New forecast'}</span></div>
        <div className="flex-1 space-y-5 overflow-y-auto p-5">
          <div className="grid gap-4 sm:grid-cols-2"><Field label="Scenario name"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field><Field label="Usage forecast"><Select value={profileId} onValueChange={setProfileId}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="custom">Custom conditions</SelectItem>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.user_count.toLocaleString()} MAU</SelectItem>)}</SelectContent></Select></Field></div>
          <Field label="Conditions and assumptions"><Textarea value={conditions} onChange={(event) => setConditions(event.target.value)} rows={4} placeholder="Region, traffic volume, storage, availability target, reserved pricing, data transfer…" /></Field>
          <Button variant="outline" className="w-full border-primary/30" onClick={estimate} disabled={estimating}><Sparkles className="mr-2 h-4 w-4 text-primary" />{estimating ? 'Estimating AWS services…' : 'Estimate from design with AI'}</Button>
          <div><div className="mb-2 flex items-center justify-between"><div><Label>Monthly service costs</Label><p className="text-xs text-muted-foreground">AI results remain editable.</p></div><Button variant="ghost" size="sm" onClick={() => setItems([...items, emptyItem()])}><Plus className="mr-1 h-3.5 w-3.5" />Service</Button></div>
            <div className="space-y-2">{items.map((item, index) => <div key={index} className="rounded-lg border p-3"><div className="grid grid-cols-[1fr_110px_auto] gap-2"><Input value={item.service} onChange={(event) => setItems(items.map((value, i) => i === index ? { ...value, service: event.target.value } : value))} placeholder="AWS service" /><Input type="number" min={0} step="0.01" value={item.monthlyCost} onChange={(event) => setItems(items.map((value, i) => i === index ? { ...value, monthlyCost: event.target.value } : value))} placeholder="USD/mo" /><Button variant="ghost" size="icon" onClick={() => setItems(items.filter((_, i) => i !== index))}><Trash2 className="h-4 w-4" /></Button></div><Input className="mt-2" value={item.usage} onChange={(event) => setItems(items.map((value, i) => i === index ? { ...value, usage: event.target.value } : value))} placeholder="Usage assumption" /></div>)}</div>
          </div>
          {pricingBasis && <div className="rounded-lg bg-muted/50 p-3 text-xs leading-5 text-muted-foreground"><span className="font-medium text-foreground">Pricing basis:</span> {pricingBasis}</div>}
        </div>
        <div className="border-t bg-card p-5"><div className="mb-3 flex items-end justify-between"><span className="text-sm text-muted-foreground">Estimated monthly total</span><span className="text-2xl font-semibold tabular-nums">{usd(draftTotalCents)}</span></div><Button className="w-full" onClick={save} disabled={saving}>{saving ? 'Saving…' : editingId ? 'Save changes' : 'Save budget forecast'}</Button></div>
      </div>}
    </SheetContent>
  </Sheet>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="space-y-1.5"><Label>{label}</Label>{children}</div>;
}

interface TreemapCellProps { x?: number; y?: number; width?: number; height?: number; name?: string; pct?: number; fill?: string }

function BudgetTreemapCell({ x = 0, y = 0, width = 0, height = 0, name = '', pct = 0, fill }: TreemapCellProps) {
  const showLabel = width > 44 && height > 26;
  const maxChars = Math.max(3, Math.floor((width - 10) / 6.2));
  const label = name.length > maxChars ? `${name.slice(0, maxChars - 1)}…` : name;
  return (
    <g>
      <title>{`${name}: ${pct}%`}</title>
      <rect x={x} y={y} width={width} height={height} fill={fill} stroke="var(--card)" strokeWidth={2} rx={2} />
      {showLabel && <text x={x + 6} y={y + 16} fontSize={11} fontWeight={600} fill="#fff" className="pointer-events-none">{label}</text>}
      {showLabel && height > 40 && <text x={x + 6} y={y + 31} fontSize={11} fill="#fff" fillOpacity={0.85} className="pointer-events-none">{pct}%</text>}
    </g>
  );
}

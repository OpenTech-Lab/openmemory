'use client';

import { useCallback, useEffect, useState } from 'react';
import { Activity, BrainCircuit, DollarSign, Percent, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  APPLICATION_LABELS, EMPTY_FORECAST, USAGE_PATTERN_LABELS, type ApplicationType, type ForecastDraft,
  type ForecastProfile, type StressTolerance, type UsagePattern,
} from '@/lib/forecast-types';

const QUICK_STARTS: Array<{ label: string; hint: string; draft: ForecastDraft }> = [
  { label: 'Lean launch', hint: 'Validate cheaply with room to learn', draft: { ...EMPTY_FORECAST, name: 'Lean launch', description: 'Early product validation with cost control.', user_count: 1000, monthly_budget_usd: 300, stress_tolerance: 'aggressive', engagement_percent: 40, planning_horizon_months: 6, annual_growth_percent: 100 } },
  { label: 'Growth SaaS', hint: 'Balanced scale and reliability', draft: { ...EMPTY_FORECAST, name: 'Growth SaaS', description: 'Growing customer-facing SaaS workload.', user_count: 25000, monthly_budget_usd: 5000, stress_tolerance: 'balanced', usage_pattern: 'bursty', engagement_percent: 60, planning_horizon_months: 18, annual_growth_percent: 80 } },
  { label: 'Critical service', hint: 'Headroom before efficiency', draft: { ...EMPTY_FORECAST, name: 'Critical service', description: 'Business-critical workload with conservative capacity.', user_count: 250000, monthly_budget_usd: 30000, stress_tolerance: 'conservative', usage_pattern: 'bursty', engagement_percent: 80, planning_horizon_months: 36, annual_growth_percent: 35 } },
];

const stressLabel: Record<StressTolerance, string> = { conservative: 'Low stress', balanced: 'Balanced', aggressive: 'Cost-first' };

export function ForecastSettings() {
  const [profiles, setProfiles] = useState<ForecastProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ForecastProfile | null>(null);
  const [draft, setDraft] = useState<ForecastDraft>(EMPTY_FORECAST);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/forecast-profiles');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to load forecasts');
      setProfiles(data.profiles ?? []);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load forecasts');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const startCreate = (preset: ForecastDraft = EMPTY_FORECAST) => {
    setEditing(null); setDraft({ ...preset }); setOpen(true);
  };
  const startEdit = (profile: ForecastProfile) => {
    setEditing(profile);
    setDraft({
      name: profile.name, description: profile.description, application_type: profile.application_type,
      user_count: profile.user_count, monthly_budget_usd: profile.monthly_budget_usd,
      stress_tolerance: profile.stress_tolerance, usage_pattern: profile.usage_pattern,
      engagement_percent: profile.engagement_percent,
      planning_horizon_months: profile.planning_horizon_months,
      annual_growth_percent: profile.annual_growth_percent, notes: profile.notes,
    });
    setOpen(true);
  };

  const save = async () => {
    if (!draft.name.trim()) { toast.error('Give this forecast a name'); return; }
    setSaving(true);
    try {
      const response = await fetch(editing ? `/api/forecast-profiles/${editing.id}` : '/api/forecast-profiles', {
        method: editing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? 'Failed to save forecast');
      toast.success(editing ? 'Forecast updated' : 'Forecast created');
      setOpen(false); await load();
    } catch (error) { toast.error(error instanceof Error ? error.message : 'Failed to save forecast'); }
    finally { setSaving(false); }
  };

  const remove = async (profile: ForecastProfile) => {
    if (!window.confirm(`Delete “${profile.name}”?`)) return;
    const response = await fetch(`/api/forecast-profiles/${profile.id}`, { method: 'DELETE' });
    if (response.ok) { toast.success('Forecast deleted'); await load(); }
    else { const data = await response.json(); toast.error(data.error ?? 'Failed to delete forecast'); }
  };

  return (
    <div className="space-y-7">
      <section className="relative overflow-hidden rounded-xl border bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_42%)] p-5">
        <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.18em] text-primary"><Activity className="h-4 w-4" /> Planning assumptions</div>
            <h2 className="text-2xl font-semibold tracking-tight">Design for the load you expect</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">Set your expected Monthly Active Users (MAU), budget, and growth once, then reuse these capacity envelopes when agents plan architecture, cost, and future updates across projects.</p>
          </div>
          <Button onClick={() => startCreate()} className="gap-2"><Plus className="h-4 w-4" /> New forecast</Button>
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Quick starts</h3><p className="text-xs text-muted-foreground">A useful baseline you can tune.</p></div></div>
        <div className="grid gap-3 md:grid-cols-3">
          {QUICK_STARTS.map((preset) => <button key={preset.label} onClick={() => startCreate(preset.draft)} className="group rounded-lg border bg-card p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-sm">
            <div className="flex items-center justify-between"><span className="font-medium">{preset.label}</span><Plus className="h-4 w-4 text-muted-foreground transition group-hover:text-primary" /></div>
            <p className="mt-1 text-xs text-muted-foreground">{preset.hint}</p>
            <div className="mt-3 flex gap-2 text-[11px] text-muted-foreground"><span>{preset.draft.user_count.toLocaleString()} MAU</span><span>·</span><span>${preset.draft.monthly_budget_usd.toLocaleString()}/mo</span></div>
          </button>)}
        </div>
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between"><div><h3 className="text-sm font-semibold">Saved forecasts</h3><p className="text-xs text-muted-foreground">Available to users, agents, and project design generation.</p></div><Button variant="ghost" size="sm" onClick={load} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /></Button></div>
        {profiles.length === 0 && !loading ? <div className="rounded-lg border border-dashed py-12 text-center"><BrainCircuit className="mx-auto h-7 w-7 text-muted-foreground/50" /><p className="mt-2 text-sm font-medium">No saved forecasts yet</p><p className="text-xs text-muted-foreground">Start from a template above or create your own.</p></div> :
          <div className="grid gap-3 xl:grid-cols-2">{profiles.map((profile) => <article key={profile.id} className="rounded-lg border bg-card p-4">
            <div className="flex items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2"><h4 className="font-semibold">{profile.name}</h4><Badge variant="secondary">{APPLICATION_LABELS[profile.application_type]}</Badge><Badge variant="outline">{stressLabel[profile.stress_tolerance]}</Badge></div>{profile.description && <p className="mt-1 text-sm text-muted-foreground">{profile.description}</p>}</div><div className="flex shrink-0"><Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => startEdit(profile)}><Pencil className="h-3.5 w-3.5" /></Button><Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-destructive" onClick={() => remove(profile)}><Trash2 className="h-3.5 w-3.5" /></Button></div></div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Metric icon={Users} label="MAU" value={profile.user_count.toLocaleString()} />
              <Metric icon={DollarSign} label="Budget / mo" value={`$${profile.monthly_budget_usd.toLocaleString()}`} />
              <Metric icon={Activity} label="Usage" value={USAGE_PATTERN_LABELS[profile.usage_pattern].label} title={USAGE_PATTERN_LABELS[profile.usage_pattern].hint} />
              <Metric icon={Percent} label="Engagement" value={`${profile.engagement_percent}%`} title="Share of MAU active on a typical day" />
              <Metric icon={ShieldCheck} label="Horizon" value={`${profile.planning_horizon_months} months`} />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">Plan for {profile.annual_growth_percent}% annual growth{profile.notes ? ` · ${profile.notes}` : ''}</p>
          </article>)}</div>}
      </section>

      <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>{editing ? 'Edit forecast' : 'New usage forecast'}</DialogTitle><DialogDescription>Capture the constraints that should shape future designs and tradeoffs.</DialogDescription></DialogHeader>
        <div className="grid gap-4 py-2 sm:grid-cols-2">
          <Field label="Name"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Growth SaaS" /></Field>
          <Field label="Application type"><Select value={draft.application_type} onValueChange={(v) => setDraft({ ...draft, application_type: v as ApplicationType })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(APPLICATION_LABELS).map(([value, label]) => <SelectItem key={value} value={value}>{label}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Monthly Active Users (MAU)"><Input type="number" min={1} value={draft.user_count} onChange={(e) => setDraft({ ...draft, user_count: Number(e.target.value) })} /></Field>
          <Field label="Monthly budget (USD)"><Input type="number" min={0} value={draft.monthly_budget_usd} onChange={(e) => setDraft({ ...draft, monthly_budget_usd: Number(e.target.value) })} /></Field>
          <Field label="Stress tolerance"><Select value={draft.stress_tolerance} onValueChange={(v) => setDraft({ ...draft, stress_tolerance: v as StressTolerance })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="conservative">Low — favor headroom</SelectItem><SelectItem value="balanced">Balanced tradeoffs</SelectItem><SelectItem value="aggressive">High — favor cost</SelectItem></SelectContent></Select></Field>
          <Field label="Usage pattern" hint="How traffic is shaped over time"><Select value={draft.usage_pattern} onValueChange={(v) => setDraft({ ...draft, usage_pattern: v as UsagePattern })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{Object.entries(USAGE_PATTERN_LABELS).map(([value, { label, hint }]) => <SelectItem key={value} value={value}>{label} — {hint}</SelectItem>)}</SelectContent></Select></Field>
          <Field label="Engagement (% MAU active/day)" hint="e.g. active 15 of 30 days/month = 50"><Input type="number" min={1} max={100} value={draft.engagement_percent} onChange={(e) => setDraft({ ...draft, engagement_percent: Number(e.target.value) })} /></Field>
          <Field label="Planning horizon (months)"><Input type="number" min={1} max={120} value={draft.planning_horizon_months} onChange={(e) => setDraft({ ...draft, planning_horizon_months: Number(e.target.value) })} /></Field>
          <Field label="Annual growth (%)"><Input type="number" min={0} max={1000} value={draft.annual_growth_percent} onChange={(e) => setDraft({ ...draft, annual_growth_percent: Number(e.target.value) })} /></Field>
          <div className="sm:col-span-2"><Field label="Description"><Input value={draft.description ?? ''} onChange={(e) => setDraft({ ...draft, description: e.target.value || null })} placeholder="When should a project use this forecast?" /></Field></div>
          <div className="sm:col-span-2"><Field label="Extra constraints"><Textarea rows={3} value={draft.notes ?? ''} onChange={(e) => setDraft({ ...draft, notes: e.target.value || null })} placeholder="Region, compliance, latency, launch date, or other assumptions" /></Field></div>
        </div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : editing ? 'Save changes' : 'Create forecast'}</Button></DialogFooter>
      </DialogContent></Dialog>
    </div>
  );
}

function Metric({ icon: Icon, label, value, title }: { icon: typeof Users; label: string; value: string; title?: string }) { return <div className="rounded-md bg-muted/50 px-3 py-2" title={title}><div className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground"><Icon className="h-3 w-3" />{label}</div><div className="mt-1 truncate text-sm font-medium capitalize">{value}</div></div>; }
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) { return <div className="space-y-1.5"><Label>{label}</Label>{hint && <p className="text-xs text-muted-foreground">{hint}</p>}{children}</div>; }

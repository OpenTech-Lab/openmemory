// Reference directory of Claude Code's built-in subagent modes, keyed by the
// permission mode each one runs under. This is informational only — it does
// not reflect what's installed on any particular machine, unlike skills
// (which vary per user/plugin and are surfaced from real usage data instead).
export interface SubagentReference {
  name: string;
  mode: string;
  purpose: string;
}

export const SUBAGENT_REFERENCE: SubagentReference[] = [
  {
    name: 'reviewer',
    mode: 'default (manual — every action confirmed)',
    purpose: 'High-stakes or irreversible work: secrets, credential rotation, destructive ops, anything touching prod or shared infra.',
  },
  {
    name: 'refactorer',
    mode: 'acceptEdits (edits auto-approved, else asks)',
    purpose: 'Mechanical, many-file changes with no judgment left: renames, formatting, applying an already-decided pattern.',
  },
  {
    name: 'planner',
    mode: 'plan (no write tools at all)',
    purpose: 'Investigating a codebase and producing an implementation plan before any code is written.',
  },
  {
    name: 'operator',
    mode: 'auto (classifier auto-approves low-risk calls)',
    purpose: 'Semi-autonomous investigate-and-fix work: routine maintenance, config cleanup, "go fix whatever’s wrong."',
  },
  {
    name: 'runner',
    mode: 'dontAsk (no prompts, no classifier — allow/deny rules only)',
    purpose: 'Narrow, repetitive, pre-vetted loops: test/build/lint verification, health checks — never open-ended work.',
  },
  {
    name: 'implementer',
    mode: 'bypassPermissions (all checks skipped)',
    purpose: 'Executing a decided plan: code, tests, verification.',
  },
];

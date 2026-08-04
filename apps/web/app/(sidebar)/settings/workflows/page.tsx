import { WorkflowsPanel } from '@/components/workflows-panel';

export default function WorkflowsSettingsPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-2">Workflows</h1>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />
      <WorkflowsPanel />
    </div>
  );
}

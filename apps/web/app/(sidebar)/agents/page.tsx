import { AgentSettings } from '@/components/agent-settings';

export default function AgentsPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-2">Agents</h1>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />
      <AgentSettings />
    </div>
  );
}

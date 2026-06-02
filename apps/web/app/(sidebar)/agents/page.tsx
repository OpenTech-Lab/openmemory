import { AgentSettings } from '@/components/agent-settings';

export default function AgentsPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-4">Agents</h1>
      <AgentSettings />
    </div>
  );
}

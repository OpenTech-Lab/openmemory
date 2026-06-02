import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { GraphLlmSettings } from '@/components/graph-llm-settings';

export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-4">Settings</h1>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">LLM Settings</CardTitle>
          <CardDescription>Configure the language model used for knowledge graph extraction</CardDescription>
        </CardHeader>
        <CardContent>
          <GraphLlmSettings />
        </CardContent>
      </Card>
    </div>
  );
}

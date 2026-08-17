import { GraphLlmSettings } from '@/components/graph-llm-settings';
import { I18nText } from '@/lib/i18n';

export default function SettingsPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-2"><I18nText id="page.settings" /></h1>
      <div className="h-px bg-gradient-to-r from-border via-border/40 to-transparent mb-4" />
      <GraphLlmSettings />
    </div>
  );
}

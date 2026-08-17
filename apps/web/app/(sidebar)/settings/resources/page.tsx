import { ResourcesPanel } from '@/components/resources-panel';
import { I18nText } from '@/lib/i18n';

export default function ResourcesPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="flex min-h-0 flex-1 flex-col gap-3">
        <h1 className="text-lg font-semibold"><I18nText id="page.resources" /></h1>
        <ResourcesPanel />
      </div>
    </div>
  );
}

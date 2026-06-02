import { EnvParamsPanel } from '@/components/env-params-panel';

export default function EnvironmentPage() {
  return (
    <div className="flex-1 overflow-auto p-4">
      <h1 className="text-lg font-semibold mb-4">Environment</h1>
      <EnvParamsPanel />
    </div>
  );
}

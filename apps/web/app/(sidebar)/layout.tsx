import { AppHeader } from '@/components/app-header';

export default function ConsoleLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-svh min-w-0 flex-col overflow-hidden">
      <AppHeader />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}

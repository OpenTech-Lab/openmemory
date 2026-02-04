import { MemoryDashboard } from '@/components/memory-dashboard';

export default function Home() {
  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto py-8">
        <div className="mb-8">
          <h1 className="text-4xl font-bold tracking-tight">OpenMemory Dashboard</h1>
          <p className="text-muted-foreground mt-2">View and search AI memories</p>
        </div>
        <MemoryDashboard />
      </main>
    </div>
  );
}

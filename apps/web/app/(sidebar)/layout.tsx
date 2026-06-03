import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar';
import { AppSidebar } from '@/components/app-sidebar';

export default function SidebarLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-svh overflow-hidden">
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          {children}
        </SidebarInset>
      </SidebarProvider>
    </div>
  );
}

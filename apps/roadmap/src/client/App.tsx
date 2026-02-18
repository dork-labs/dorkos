import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { useRoadmapItems } from '@/layers/entities/roadmap-item';
import { useAppStore, useTheme } from '@/layers/shared/model';
import { HealthBar, ViewTabs, ThemeToggle, useHealthStats } from '@/layers/features/health-bar';
import { TableView } from '@/layers/features/table-view';
import { KanbanView } from '@/layers/features/kanban-view';
import { MoscowView } from '@/layers/features/moscow-view';
import { GanttView } from '@/layers/features/gantt-view';
import { ItemEditorDialog } from '@/layers/features/item-editor';
import { SpecViewerDialog } from '@/layers/features/spec-viewer';

/** Create a stable QueryClient with 30s staleTime and window focus refetching. */
function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30 * 1000,
        refetchOnWindowFocus: true,
      },
    },
  });
}

/** Inner app shell — requires QueryClientProvider to already be mounted. */
function AppShell() {
  const viewMode = useAppStore((s) => s.viewMode);
  const { data: items = [] } = useRoadmapItems();
  const stats = useHealthStats(items);

  // Apply theme class to document.documentElement on mount and preference change
  useTheme();

  return (
    <div className="flex h-dvh flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <div className="flex items-center border-b border-neutral-200 dark:border-neutral-700">
        <HealthBar {...stats} />
        <div className="ml-auto pr-4">
          <ThemeToggle />
        </div>
      </div>
      <ViewTabs />
      <main className="flex-1 overflow-auto">
        {viewMode === 'table' && <TableView />}
        {viewMode === 'kanban' && <KanbanView />}
        {viewMode === 'moscow' && <MoscowView />}
        {viewMode === 'gantt' && <GanttView />}
      </main>
      <ItemEditorDialog />
      <SpecViewerDialog />
    </div>
  );
}

/** Root application component for the DorkOS Roadmap app. */
export function App() {
  const [queryClient] = useState(() => makeQueryClient());

  return (
    <QueryClientProvider client={queryClient}>
      <MotionConfig reducedMotion="user">
        <AppShell />
      </MotionConfig>
    </QueryClientProvider>
  );
}

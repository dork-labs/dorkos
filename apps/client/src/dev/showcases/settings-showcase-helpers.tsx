import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutContent,
  NavigationLayoutPanel,
} from '@/layers/shared/ui';
import { MOCK_MESH_AGENTS, MOCK_SERVER_CONFIG } from './settings-mock-data';

/**
 * Wraps children in a fresh `QueryClient` prepopulated with mock query data so
 * data-driven settings tabs render their populated branches without making
 * network calls. Query keys are kept in sync with the actual hooks in
 * `apps/client/src/layers/features/settings/ui/*` — verified via grep.
 */
export function MockedQueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    c.setQueryData(['config'], MOCK_SERVER_CONFIG);
    c.setQueryData(['mesh', 'agents'], MOCK_MESH_AGENTS);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Bare `NavigationLayout` shell with a single panel for showcasing one tab in isolation. */
export function TabShell({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={value} onValueChange={() => {}}>
        <NavigationLayoutBody>
          <NavigationLayoutContent className="p-4">
            <NavigationLayoutPanel value={value}>
              <div className="space-y-4">{children}</div>
            </NavigationLayoutPanel>
          </NavigationLayoutContent>
        </NavigationLayoutBody>
      </NavigationLayout>
    </div>
  );
}

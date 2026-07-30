import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import {
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutContent,
  NavigationLayoutPanel,
} from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { createPlaygroundTransport } from '../playground-transport';
import { MOCK_MESH_AGENTS, MOCK_SERVER_CONFIG } from './settings-mock-data';

/**
 * Wraps children in a fresh `QueryClient` prepopulated with mock query data so
 * data-driven settings tabs render their populated branches without making
 * network calls. Query keys are kept in sync with the actual hooks in
 * `apps/client/src/layers/features/settings/ui/*` — verified via grep.
 *
 * The config is seeded under BOTH `['config']` and `['config','current']`: the
 * settings tabs and `useFeatureEnabled` read the bare key while
 * `entities/config`'s `useConfig` (and the Claude accounts card and status-bar
 * switcher through it) read the nested one. Seeding one leaves the other empty
 * and the showcase renders a loading branch nobody asked for.
 *
 * @param children - Showcase content to render.
 * @param config - Server config to seed; defaults to {@link MOCK_SERVER_CONFIG}.
 */
export function MockedQueryProvider({
  children,
  config = MOCK_SERVER_CONFIG,
}: {
  children: React.ReactNode;
  config?: ServerConfig;
}) {
  const [client] = useState(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    c.setQueryData(['config'], config);
    c.setQueryData(['config', 'current'], config);
    c.setQueryData(['mesh', 'agents'], MOCK_MESH_AGENTS);
    return c;
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * Playground transport whose `PATCH /api/config` is refused the way the server
 * refuses an `operator-only` write (403 under Require login).
 *
 * The refusal path is a state the playground could not otherwise reach — the
 * default playground transport resolves every call — and it is the one that must
 * never look like success.
 */
export function RefusedConfigWriteProvider({ children }: { children: React.ReactNode }) {
  const [transport] = useState<Transport>(() => {
    // A Proxy, not a spread: the playground transport is itself a Proxy over an
    // empty target, so `{ ...base }` would copy nothing and leave every other
    // method undefined.
    const base = createPlaygroundTransport();
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'updateConfig') {
          return () =>
            Promise.reject(
              Object.assign(new Error('Only a person can change those settings'), {
                status: 403,
                code: 'operator_only_config',
              })
            );
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  });
  return <TransportProvider transport={transport}>{children}</TransportProvider>;
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

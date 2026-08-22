import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ServerConfig } from '@dorkos/shared/types';
import type { Transport } from '@dorkos/shared/transport';
import {
  NavigationLayout,
  NavigationLayoutBody,
  NavigationLayoutContent,
  NavigationLayoutPanel,
  NavigationLayoutPanelHeader,
} from '@/layers/shared/ui';
import { TransportProvider } from '@/layers/shared/model';
import { RuntimeCardView } from '@/layers/features/settings';
import { createPlaygroundTransport } from '../playground-transport';
import {
  createRuntimeCardProps,
  MOCK_MESH_AGENTS,
  MOCK_SERVER_CONFIG,
  type RuntimeCardShowcaseOptions,
} from './settings-mock-data';
import { configKeys } from '@/layers/entities/config';

/**
 * Wraps children in a fresh `QueryClient` prepopulated with mock query data so
 * data-driven settings tabs render their populated branches without making
 * network calls. Query keys are kept in sync with the actual hooks in
 * `apps/client/src/layers/features/settings/ui/*` — verified via grep.
 *
 * The config is seeded under `configKeys.current()` and nothing else — every
 * reader in the cockpit is on that one key now (spec `sidebar-simplification`
 * D6, "one fetch per fact"), and a showcase that seeded a second one would keep
 * a dead entry alive.
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
    c.setQueryData(configKeys.current(), config);
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

/**
 * One runtime card, with a body a person can actually open.
 *
 * Expansion is controlled from outside in the real tab too — cards expand
 * independently and opening one never closes another — so the showcase owns the
 * same single piece of state the container owns and hands everything else over
 * as props. Shared between the runtime-card showcases and the accounts showcase,
 * which needs the same card as the context its section renders inside.
 *
 * @param props - The card's state (see `RuntimeCardShowcaseOptions`), plus the
 *   two slots a container fills: a section renderer and a connect flow.
 */
export function LiveRuntimeCard({
  renderSection,
  connectSlot,
  ...options
}: RuntimeCardShowcaseOptions & {
  /** Draw one declared section kind, exactly as the tab's registry does. */
  renderSection?: (kind: string) => ReactNode;
  /** The connect flow a not-ready card offers. */
  connectSlot?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(options.expanded ?? false);
  return (
    <RuntimeCardView
      {...createRuntimeCardProps({ ...options, expanded })}
      onToggleExpanded={() => setExpanded((open) => !open)}
      {...(renderSection ? { renderSection } : {})}
      {...(connectSlot ? { connectSlot } : {})}
    />
  );
}

/**
 * Bare `NavigationLayout` shell with a single panel for showcasing one tab in
 * isolation.
 *
 * `title` draws the panel header the real dialog draws. Pass it: no settings
 * tab titles itself any more (DOR-918 — that heading belongs to the dialog), so
 * a shell without it shows a headless panel the product never renders.
 *
 * @param value - Panel id, matched against the layout's active value.
 * @param title - Panel header title, as `TabbedDialog` would render it.
 * @param actions - Optional header actions, as the tab declares them.
 * @param children - The tab component under test.
 */
export function TabShell({
  value,
  title,
  actions,
  children,
}: {
  value: string;
  title?: string;
  actions?: ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="border-border overflow-hidden rounded-lg border">
      <NavigationLayout value={value} onValueChange={() => {}}>
        <NavigationLayoutBody>
          <NavigationLayoutContent className="p-4">
            <NavigationLayoutPanel value={value}>
              <div className="space-y-4">
                {title && (
                  <NavigationLayoutPanelHeader actions={actions}>
                    {title}
                  </NavigationLayoutPanelHeader>
                )}
                {children}
              </div>
            </NavigationLayoutPanel>
          </NavigationLayoutContent>
        </NavigationLayoutBody>
      </NavigationLayout>
    </div>
  );
}

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Transport } from '@dorkos/shared/transport';
import type {
  ConnectorWritesBack,
  ConnectorWritesBackChangeRequest,
} from '@dorkos/shared/connector-exclusion-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { WritesBackBlock } from '@/layers/features/connections';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/*
 * A connected app's writes-back switch (DOR-4794): off, on, and a load error.
 * Flipping it works here: on opens the confirm, off is immediate, and no
 * "Confirm it's you" sheet is shown. "Northwind Tracker" is made up.
 */

/** A transport whose switch starts at `start`, or fails to load when it is an Error. */
function WritesBack({ start }: { start: ConnectorWritesBack | Error }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState<Transport>(() => {
    // A Proxy, not a spread: the playground transport is itself a Proxy.
    const base = createPlaygroundTransport();
    let state = start;
    const answers: Record<string, (...args: never[]) => Promise<unknown>> = {
      getConnectorWritesBack: () =>
        state instanceof Error ? Promise.reject(state) : Promise.resolve(state),
      setConnectorWritesBack: (connectionId: string, change: ConnectorWritesBackChangeRequest) => {
        state = {
          connectionId,
          writesBackUnasked: change.writesBackUnasked,
          writesBackAttestedAt: change.writesBackUnasked ? new Date().toISOString() : null,
          supported: true,
        };
        return Promise.resolve({ ...state, changed: true });
      },
    };
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (typeof prop === 'string' && prop in answers) return answers[prop];
        return Reflect.get(target, prop, receiver);
      },
    });
  });
  return (
    <QueryClientProvider client={client}>
      <TransportProvider transport={transport}>
        <WritesBackBlock connectionId="conn-northwind" appName="Northwind Tracker" />
      </TransportProvider>
    </QueryClientProvider>
  );
}

const off = (): ConnectorWritesBack => ({
  connectionId: 'conn-northwind',
  writesBackUnasked: false,
  writesBackAttestedAt: null,
  supported: true,
});

const STATES: { label: string; start: () => ConnectorWritesBack | Error }[] = [
  { label: 'Off (the default)', start: off },
  {
    label: 'On',
    start: () => ({
      ...off(),
      writesBackUnasked: true,
      writesBackAttestedAt: '2026-11-19T12:00:00Z',
    }),
  },
  { label: 'Load error', start: () => new Error('down') },
];

/** The writes-back switch's states. */
export function WritesBackShowcases() {
  return (
    <PlaygroundSection
      title="Write back without asking"
      description="A connected app's panel: lets an agent that read only this app add, edit or comment there without a card. Turning it on asks for a confirm; off is immediate."
    >
      <ShowcaseDemo responsive>
        <div className="space-y-6">
          {STATES.map((state) => (
            <div key={state.label} className="space-y-2">
              <ShowcaseLabel>{state.label}</ShowcaseLabel>
              <WritesBack start={state.start()} />
            </div>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

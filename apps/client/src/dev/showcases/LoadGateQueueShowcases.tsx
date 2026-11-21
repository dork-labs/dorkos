import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { LoadGateWaitingJob, LoadGateWaitingLine } from '@dorkos/shared/load-gate-queue';
import type { Transport } from '@dorkos/shared/transport';
import { TransportProvider } from '@/layers/shared/model';
import { LoadGateQueueCard } from '@/layers/features/load-gate-queue';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { ShowcaseLabel } from '../ShowcaseLabel';

/*
 * The load gate's waiting line on the Activity page (DOR-4209). Agent and chat
 * names are made up: Scout, Atlas.
 */

const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000;

/** A waiting job, overriding only what a state needs. */
function job(overrides: Partial<LoadGateWaitingJob>): LoadGateWaitingJob {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    position: 1,
    ownedHere: true,
    label: 'pnpm',
    waitingSinceMs: minutesAgo(12),
    urgent: false,
    front: false,
    letThrough: false,
    ...overrides,
  };
}

const LINES: { label: string; line: LoadGateWaitingLine }[] = [
  {
    label: 'Two jobs waiting, one from another app',
    line: {
      jobs: [
        job({ agentName: 'Scout', chatTitle: 'Fix the login page' }),
        job({
          id: 'bbbbbbbbbbbbbbbb',
          position: 2,
          ownedHere: false,
          label: 'tsc',
          waitingSinceMs: minutesAgo(0),
        }),
      ],
    },
  },
  {
    label: 'Moved to the front, urgent, and let through',
    line: {
      jobs: [
        job({ agentName: 'Atlas', chatTitle: 'Release notes', front: true, label: 'vitest' }),
        job({
          id: 'cccccccccccccccc',
          position: 2,
          agentName: 'Scout',
          chatTitle: 'A very long chat title that has to be cut short on a phone',
          urgent: true,
          waitingSinceMs: minutesAgo(130),
        }),
        job({ id: 'dddddddddddddddd', position: 3, letThrough: true, label: 'docker' }),
      ],
    },
  },
];

/** A transport whose waiting line is `line`; actions are not sent anywhere. */
function WaitingLine({ line, children }: { line: LoadGateWaitingLine; children: ReactNode }) {
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  const [transport] = useState<Transport>(() => {
    // A Proxy, not a spread: the playground transport is itself a Proxy.
    const base = createPlaygroundTransport();
    const answers: Record<string, () => Promise<unknown>> = {
      getLoadGateWaitingLine: () => Promise.resolve(line),
      actOnLoadGateJob: () => Promise.resolve(line),
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
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

/** The Activity page's card of heavy jobs waiting their turn. */
export function LoadGateQueueShowcases() {
  return (
    <PlaygroundSection
      title="LoadGateQueueCard"
      description="Activity: heavy jobs waiting for the computer to be less busy. Let through runs one now; Urgent and Move to front change its place. No card while none wait."
    >
      <ShowcaseDemo responsive>
        <div className="space-y-6">
          {LINES.map(({ label, line }) => (
            <div key={label} className="space-y-2">
              <ShowcaseLabel>{label}</ShowcaseLabel>
              <WaitingLine line={line}>
                <LoadGateQueueCard />
              </WaitingLine>
            </div>
          ))}
        </div>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

/**
 * The notices DorkOS posts when a mini app stops on its own (DOR-4785), drawn
 * without a server: a quiet "restarting" row, and two "is off" rows with
 * Restart. People succeeds; Notes refuses so the error and retry can be reviewed.
 *
 * @module dev/showcases/ExtensionStoppedShowcases
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { InboxRow } from '@/layers/features/inbox';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { minutesAgo } from '../mock-samples/inbox';
import { createPlaygroundTransport } from '../playground-transport';

/** Off rows exercise success and refusal; the quiet row has no action. */
const ROWS: NotificationDTO[] = [
  {
    id: '01JZS0000000000000000003',
    kind: 'extension.stopped',
    tier: 'notable',
    subject: { type: 'system', id: 'extension:notes' },
    title: 'The Notes app is off',
    body: 'It stopped 3 times in 10 minutes, so DorkOS left it off.',
    actions: [{ id: 'restart-extension', label: 'Restart', style: 'primary' }],
    createdAt: minutesAgo(3),
  },
  {
    id: '01JZS0000000000000000002',
    kind: 'extension.stopped',
    tier: 'notable',
    subject: { type: 'system', id: 'extension:people' },
    title: 'The People app is off',
    body: 'It stopped 3 times in 10 minutes, so DorkOS left it off.',
    actions: [{ id: 'restart-extension', label: 'Restart', style: 'primary' }],
    createdAt: minutesAgo(2),
  },
  {
    id: '01JZS0000000000000000001',
    kind: 'extension.stopped',
    tier: 'quiet',
    subject: { type: 'system', id: 'extension:people' },
    title: 'The People app stopped responding. DorkOS is restarting it.',
    createdAt: minutesAgo(9),
  },
];

/** A mini app that kept stopping: restarted quietly, then left off with Restart. */
export function ExtensionStoppedShowcases() {
  const client = useMemo(() => new QueryClient(), []);
  // Preview actions never reach a real app, even on the dogfood server.
  const transport = useMemo(
    () =>
      new Proxy(createPlaygroundTransport(), {
        get(target, prop, receiver) {
          if (prop === 'restartExtension')
            return async (extensionId: string) => {
              if (extensionId === 'notes') throw new Error('Showcase refusal');
            };
          if (prop === 'markNotificationRead') return async () => ({ updated: 1, unreadCount: 0 });
          return Reflect.get(target, prop, receiver);
        },
      }),
    []
  );
  return (
    <PlaygroundSection
      title="Stopped app rows"
      description="Restart appears only when DorkOS leaves an app off."
    >
      <ShowcaseLabel>Restart People for success, Notes for the retry state</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={client}>
          <TransportProvider transport={transport}>
            <div
              data-testid="stopped-app-rows"
              className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2"
            >
              {ROWS.map((row) => (
                <InboxRow key={row.id} notification={row} agent={undefined} onOpen={() => {}} />
              ))}
            </div>
          </TransportProvider>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

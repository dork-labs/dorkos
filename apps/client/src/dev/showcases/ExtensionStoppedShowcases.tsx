/**
 * The notices DorkOS posts when a mini app stops on its own (DOR-4785), drawn
 * without a server: a quiet "restarted" row, and the "is off" row with
 * Restart. The words are exactly what `extension-stopped-notice.ts` builds.
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

/** The two rows one stretch of trouble leaves, newest first. */
const ROWS: NotificationDTO[] = [
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
          if (prop === 'restartExtension') return async () => undefined;
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
      <ShowcaseLabel>Restarting, then left off after 3 stops in 10 minutes</ShowcaseLabel>
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

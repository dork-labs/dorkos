/**
 * The Needs-you item for one agent taking another agent's access to an app
 * away (spec `agent-grant-autonomy`, PR D), drawn without a server: the real
 * `InboxRow` over a playground transport that answers the person's own
 * access-change route with made-up changes.
 *
 * Click Undo on the second row to see the refusal for a change that is stale.
 *
 * @module dev/showcases/AccessChangeShowcases
 */
import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ConnectorAccessChange } from '@dorkos/shared/connector-exclusion-schemas';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import type { Transport } from '@dorkos/shared/transport';
import { InboxRow } from '@/layers/features/inbox';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';

const ACTOR = {
  id: 'agent-ledger',
  name: 'ledger-bot',
  displayName: 'Ledger Bot',
  color: '#0ea5e9',
  icon: '📒',
};

/** A made-up notice for change `changeId`. */
function notice(changeId: string, index: number): NotificationDTO {
  return {
    id: `01JZR00000000000000000000${index}`,
    kind: 'connector.access_narrowed',
    tier: 'blocking',
    subject: { type: 'system', id: changeId },
    title: 'Ledger Bot took Sample Mail access away from inbox-helper',
    body: 'Undo puts it back.',
    actions: [
      { id: 'undo-access-change', label: 'Undo', style: 'neutral' },
      { id: 'keep-access-change', label: 'Keep the change', style: 'primary' },
    ],
    createdAt: new Date(Date.UTC(2026, 10, 8, 18, 0)).toISOString(),
  };
}

/** The made-up change behind a notice. */
function change(changeId: string): ConnectorAccessChange {
  return {
    changeId,
    kind: 'narrow_other',
    outcome: 'applied',
    refusalCode: null,
    actorKind: 'agent',
    actorId: ACTOR.id,
    targetAgentId: 'agent-inbox-helper',
    connectionId: 'connection-sample-mail',
    reason: 'It hasn’t used Sample Mail in 30 days.',
    undoOf: null,
    undoneBy: null,
    createdAt: new Date(Date.UTC(2026, 10, 8, 18, 0)).toISOString(),
  };
}

/** The playground transport, plus the routes these rows read. */
function accessChangeTransport(): Transport {
  const base = createPlaygroundTransport();
  return new Proxy(base, {
    get: (target, prop, receiver) => {
      if (prop === 'listMeshAgents') return async () => ({ agents: [ACTOR] });
      if (prop === 'getAccessChange') return async (changeId: string) => change(changeId);
      if (prop === 'markNotificationRead') return async () => ({ updated: 1, unreadCount: 0 });
      if (prop === 'undoAccessChange') {
        return async (changeId: string) => {
          if (changeId === 'change-stale') {
            throw Object.assign(new Error('Access has changed since then.'), {
              status: 409,
              code: 'UNDO_STALE',
            });
          }
          return { changeId, undoId: `undo-${changeId}` };
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** The access-change Needs-you rows: waiting, and one whose Undo is refused. */
export function AccessChangeShowcases() {
  const client = useMemo(() => new QueryClient(), []);
  const transport = useMemo(() => accessChangeTransport(), []);
  return (
    <PlaygroundSection
      title="Access change rows"
      description="One agent took another agent's access to an app away. The reason is the agent's own words, beside its avatar."
    >
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <ShowcaseLabel>Waiting on the person: Undo or Keep the change</ShowcaseLabel>
          <ShowcaseDemo>
            <div
              data-testid="access-change-waiting"
              className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2"
            >
              <InboxRow notification={notice('change-ok', 1)} onOpen={() => {}} />
            </div>
          </ShowcaseDemo>
          <ShowcaseLabel>Click Undo: access changed since, so it is refused in place</ShowcaseLabel>
          <ShowcaseDemo>
            <div
              data-testid="access-change-stale"
              className="border-border/60 bg-background/60 w-[min(30rem,100%)] rounded-lg border p-2"
            >
              <InboxRow notification={notice('change-stale', 2)} onOpen={() => {}} />
            </div>
          </ShowcaseDemo>
        </TransportProvider>
      </QueryClientProvider>
    </PlaygroundSection>
  );
}

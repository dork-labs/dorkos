import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PausedConnectionItem } from '@/layers/entities/attention';
import { YourAppRowView } from '@/layers/features/connections';
import type { YourAppRow } from '@/layers/features/connections/lib/app-list';
import { PausedConnectionList } from '@/layers/widgets/inbox-bell/ui/PausedConnectionList';
import { TransportProvider } from '@/layers/shared/model';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createPlaygroundTransport } from '../playground-transport';

const PAUSED: PausedConnectionItem = {
  id: 'deploy-hooks',
  name: 'Deploy hooks',
  kind: 'Webhook',
  confirmation: {
    references: [{ field: 'outbound.headers.Authorization', ref: 'env:DEPLOY_TOKEN' }],
    host: 'hooks.example.dev',
    fingerprint: 'fp-showcase',
    notSent: 3,
  },
};

const PAUSED_ROW: YourAppRow = {
  id: 'deploy-hooks',
  kind: 'chat',
  name: 'Deploy hooks',
  iconKey: 'webhook',
  account: null,
  identity: null,
  detail: 'Paused · confirm the setting it sends',
  tone: 'attention',
  action: 'review',
  detailTone: 'warning',
  waiting: 0,
};

/**
 * A connection paused until its owner confirms a setting it sends (DOR-3271),
 * as Needs you and the Connections list show it (DOR-3288): in Needs you, two
 * lines and Confirm under the text at 44px; in the list, the Paused line in
 * amber and Review that opens its panel.
 */
export function PausedConnectionShowcases() {
  const client = useMemo(() => new QueryClient(), []);
  const transport = useMemo(() => createPlaygroundTransport(), []);
  return (
    <PlaygroundSection
      title="Paused connection"
      description="A connection waiting for its owner to confirm a setting it sends. It waits on you; nothing broke."
    >
      <QueryClientProvider client={client}>
        <TransportProvider transport={transport}>
          <ShowcaseLabel>Needs you row</ShowcaseLabel>
          <ShowcaseDemo responsive>
            <div className="w-[min(30rem,100%)]">
              <PausedConnectionList items={[PAUSED]} />
            </div>
          </ShowcaseDemo>
          <ShowcaseLabel>Connections list row</ShowcaseLabel>
          <ShowcaseDemo responsive>
            <ul className="max-w-2xl">
              <YourAppRowView row={PAUSED_ROW} onOpen={() => {}} onAction={() => {}} />
            </ul>
          </ShowcaseDemo>
        </TransportProvider>
      </QueryClientProvider>
    </PlaygroundSection>
  );
}

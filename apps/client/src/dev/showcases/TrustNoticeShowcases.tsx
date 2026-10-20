import { useState } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { ConnectorConnectionSummary } from '@dorkos/shared/connector-resource-schemas';
import { TransportProvider } from '@/layers/shared/model';
import { Button, Dialog, DialogContent } from '@/layers/shared/ui';
import { TrustNoticeMoment } from '@/layers/features/trust-notice';
import { mockConnection } from '../mock-samples';
import { createPlaygroundTransport } from '../playground-transport';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

/** The notice inside the same dialog the moments rail opens it in. */
function RailDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        Open the notice
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <TrustNoticeMoment onClose={() => setOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Two apps the Trusted upgrade shared with every agent. */
const SHARED_APPS: ConnectorConnectionSummary[] = [
  mockConnection({
    everyAgentLevel: 'read-write',
    everyAgent: { operationRevisionIds: ['rev-1'], classifications: ['read', 'write'] },
  }),
  mockConnection({
    connectionId: 'conn-calendar' as ConnectorConnectionSummary['connectionId'],
    toolkit: 'googlecalendar',
    everyAgentLevel: 'read-write',
    everyAgent: { operationRevisionIds: ['rev-2'], classifications: ['read', 'write'] },
  }),
];

/** The notice with the shared-apps list, reading those apps from a scoped transport. */
function SharedAppsDemo() {
  const [transport] = useState<Transport>(() => {
    const base = createPlaygroundTransport();
    return new Proxy(base, {
      get: (target, prop, receiver) =>
        prop === 'getConnectorConnections'
          ? async () => ({ connections: SHARED_APPS })
          : (Reflect.get(target, prop, receiver) as unknown),
    });
  });
  return (
    <TransportProvider transport={transport}>
      <Dialog>
        <div className="bg-background grid max-w-lg gap-4 rounded-lg border p-6">
          <TrustNoticeMoment
            onClose={() => {}}
            sharedConnectionIds={SHARED_APPS.map((app) => app.connectionId)}
          />
        </div>
      </Dialog>
    </TransportProvider>
  );
}

/**
 * The one-time trust notice (spec `trusted-by-default-flip` §5.8). A fresh
 * install meets it on the launch after its first run, so it sits beside the
 * onboarding screens. Both buttons write through the playground transport.
 */
export function TrustNoticeShowcases() {
  return (
    <PlaygroundSection
      title="TrustNoticeMoment"
      description="Shown once on the moments rail to a Trusted install: agents now work without asking. Got it marks it seen; Keep asking me switches to Careful first."
    >
      <ShowcaseLabel>Inline</ShowcaseLabel>
      <ShowcaseDemo>
        {/* A closed Dialog root gives the title and description their context,
            so the body renders in place without the overlay. */}
        <Dialog>
          <div className="bg-background grid max-w-lg gap-4 rounded-lg border p-6">
            <TrustNoticeMoment onClose={() => {}} />
          </div>
        </Dialog>
      </ShowcaseDemo>
      <ShowcaseLabel>With apps the upgrade shared with every agent</ShowcaseLabel>
      <ShowcaseDemo>
        <SharedAppsDemo />
      </ShowcaseDemo>
      <ShowcaseLabel>As the moments rail opens it</ShowcaseLabel>
      <ShowcaseDemo>
        <RailDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

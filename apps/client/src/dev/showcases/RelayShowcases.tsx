import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { CatalogCard, ConnectionStatusBanner, RelayEmptyState } from '@/layers/features/relay';
import type { RelayConnectionState } from '@/layers/entities/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

const TELEGRAM_MANIFEST: AdapterManifest = {
  type: 'telegram',
  displayName: 'Telegram',
  description: 'Send and receive messages via Telegram bots.',
  iconId: 'telegram',
  category: 'messaging',
  builtin: true,
  multiInstance: false,
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true },
  ],
};

const GITHUB_MANIFEST: AdapterManifest = {
  type: 'github',
  displayName: 'GitHub',
  description: 'Automate workflows with GitHub webhooks and notifications.',
  iconId: 'github',
  category: 'automation',
  builtin: true,
  multiInstance: true,
  configFields: [
    { key: 'token', label: 'Personal Access Token', type: 'password', required: true },
    { key: 'repo', label: 'Repository', type: 'text', required: true },
  ],
};

const CONNECTION_STATES: RelayConnectionState[] = ['disconnected', 'reconnecting'];

/** Relay feature component showcases: CatalogCard, ConnectionStatusBanner, RelayEmptyState. */
export function RelayShowcases() {
  return (
    <>
      <PlaygroundSection
        title="CatalogCard"
        description="Adapter manifest card for the relay catalog browser."
      >
        <ShowcaseDemo>
          <div className="grid gap-4 sm:grid-cols-2">
            <CatalogCard manifest={TELEGRAM_MANIFEST} onAdd={() => {}} />
            <CatalogCard manifest={GITHUB_MANIFEST} onAdd={() => {}} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ConnectionStatusBanner"
        description="Relay connection state banner. Connected state renders null."
      >
        {CONNECTION_STATES.map((state) => (
          <div key={state}>
            <ShowcaseLabel>{state}</ShowcaseLabel>
            <ShowcaseDemo>
              <ConnectionStatusBanner connectionState={state} />
            </ShowcaseDemo>
          </div>
        ))}
      </PlaygroundSection>

      <PlaygroundSection
        title="RelayEmptyState"
        description="Empty state shown when no relay adapters are configured."
      >
        <ShowcaseDemo>
          <RelayEmptyState onAddAdapter={() => {}} />
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}

import type { PublicConnectedAccount } from '@dorkos/shared/connector-provider';
import { ServiceTile, AccountRow } from '@/layers/features/connections';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

const MANAGED_DISCLOSURE =
  'Connecting Gmail takes you to that service to sign in. Composio stores your connected ' +
  "accounts' login access in its own secure vault, not on your computer. Your agents can then " +
  'act for you; your password is never shared, and you can disconnect anytime.';

const SELF_HOST_DISCLOSURE =
  "You're connecting through your own Nango server. The keys to this connection are stored in " +
  'your database, on infrastructure you control. Nothing about this connection leaves your systems.';

function mockAccount(over: Partial<PublicConnectedAccount>): PublicConnectedAccount {
  return {
    id: 'ca_mock_1' as PublicConnectedAccount['id'],
    toolkit: 'gmail',
    label: 'work',
    status: 'active',
    custody: 'managed',
    disclosure: MANAGED_DISCLOSURE,
    ...over,
  };
}

/** Connections surface leaves: the service tile and the connected-account row. */
export function ConnectionsShowcases() {
  return (
    <>
      <PlaygroundSection
        title="ServiceTile"
        description="One connectable service on the /connections grid — service-first, a single Connect verb, provider invisible."
      >
        <ShowcaseLabel>Known services</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="grid max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
            <ServiceTile
              toolkit={{ slug: 'gmail', displayName: 'Gmail', authKind: 'oauth2' }}
              onConnect={() => {}}
            />
            <ServiceTile
              toolkit={{ slug: 'slack', displayName: 'Slack', authKind: 'oauth2' }}
              onConnect={() => {}}
            />
            <ServiceTile
              toolkit={{ slug: 'linear', displayName: 'Linear', authKind: 'oauth2' }}
              onConnect={() => {}}
            />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Unknown service (fallback icon)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-40">
            <ServiceTile
              toolkit={{ slug: 'obscureapi', displayName: 'Obscure API', authKind: 'api-key' }}
              onConnect={() => {}}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AccountRow"
        description="One connected account: service icon, Gmail (work) naming, lifecycle status, and its own server-composed custody sentence."
      >
        <ShowcaseLabel>Active, managed custody</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow account={mockAccount({})} onDisconnect={() => {}} />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Two accounts of one service</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl space-y-2">
            <AccountRow account={mockAccount({})} onDisconnect={() => {}} />
            <AccountRow
              account={mockAccount({
                id: 'ca_mock_2' as PublicConnectedAccount['id'],
                label: 'personal',
              })}
              onDisconnect={() => {}}
            />
          </ul>
        </ShowcaseDemo>

        <ShowcaseLabel>Expired (self-host custody)</ShowcaseLabel>
        <ShowcaseDemo>
          <ul className="max-w-xl">
            <AccountRow
              account={mockAccount({
                id: 'ca_mock_3' as PublicConnectedAccount['id'],
                toolkit: 'slack',
                label: 'team',
                status: 'expired',
                custody: 'self-host',
                disclosure: SELF_HOST_DISCLOSURE,
              })}
              onDisconnect={() => {}}
            />
          </ul>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}

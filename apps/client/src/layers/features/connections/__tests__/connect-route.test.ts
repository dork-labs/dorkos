import { describe, expect, it } from 'vitest';
import type {
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import {
  chooseConnectRoute,
  firstConnectReason,
  isCatalogOutage,
  needsFirstConnectStep,
  signInLine,
} from '../lib/connect-route';

const capabilities = {
  catalog: { status: 'available' as const },
  authentication: { status: 'available' as const },
  accounts: { status: 'available' as const },
  operations: { status: 'available' as const },
  execution: { status: 'available' as const },
  triggers: { status: 'unsupported' as const, reason: 'Not yet.' },
};

function route(
  id: string,
  over: Partial<ConnectorCatalogProviderRoute> = {}
): ConnectorCatalogProviderRoute {
  return {
    providerInstanceId: id as never,
    displayName: id,
    mode: 'byo',
    custody: 'managed',
    payer: 'operator_byo',
    capabilities,
    disclosure: 'Keeps sign-ins.',
    authKind: 'oauth2',
    ...over,
  };
}

const notion: ConnectorCatalogService = {
  serviceSlug: 'notion',
  displayName: 'Notion',
  iconKey: 'notion',
  intents: [{ kind: 'account', displayName: 'Use a Notion account', routes: [] }],
};

describe('chooseConnectRoute', () => {
  it('falls back to a DorkOS-account route first when the marked way does not reach the app', () => {
    const managed = route('managed', { mode: 'managed' });
    const way = {
      kind: 'own_key' as const,
      type: 'nango',
      status: 'ready' as const,
      providerInstanceId: 'nango' as never,
    };
    expect(chooseConnectRoute([route('mcp'), managed], { status: 'ready', way })).toBe(managed);
  });

  it('never picks a route that cannot sign in', () => {
    const offline = route('offline', {
      capabilities: {
        ...capabilities,
        authentication: { status: 'unsupported', reason: 'Not set up.' },
      },
    });
    expect(chooseConnectRoute([offline], undefined)).toBeNull();
  });
});

describe('needsFirstConnectStep', () => {
  it('is needed only for an app to sign in to that no way reaches yet', () => {
    expect(needsFirstConnectStep(notion)).toBe(true);
    expect(
      needsFirstConnectStep({
        ...notion,
        intents: [{ kind: 'account', displayName: 'Use a Notion account', routes: [route('a')] }],
      })
    ).toBe(false);
    // A chat app has no account to sign in to, so it never needs the step.
    expect(
      needsFirstConnectStep({
        ...notion,
        intents: [{ kind: 'messages', displayName: 'Chat', relayAdapterType: 'telegram' }],
      })
    ).toBe(false);
  });
});

describe('signInLine', () => {
  it('names the app itself when it signs in under its own name', () => {
    expect(signInLine(route('a', { signInThrough: 'Nango' }), notion)).toBe(
      'Notion will ask you to allow Nango — that’s the service DorkOS uses to connect.'
    );
  });

  it('says nothing for a direct route, a self-hosted Nango route, or a sign-in with no consent page', () => {
    expect(signInLine(route('a'), notion)).toBeNull();
    expect(
      signInLine(route('a', { signInThrough: 'Composio', authKind: 'api-key' }), notion)
    ).toBeNull();
  });
});

describe('firstConnectReason', () => {
  const nango = {
    kind: 'own_key' as const,
    type: 'nango',
    status: 'ready' as const,
    providerInstanceId: 'nango' as never,
  };

  it('names the working way that does not reach this app', () => {
    expect(
      firstConnectReason({ ways: [nango], newApps: { status: 'ready', way: nango } }, notion)
    ).toBe('Your Nango server can’t reach Notion yet.');
    const account = {
      kind: 'dorkos_account' as const,
      type: 'dorkos-managed',
      status: 'ready' as const,
      providerInstanceId: 'managed' as never,
      signInThrough: 'Composio',
    };
    expect(
      firstConnectReason({ ways: [account], newApps: { status: 'ready', way: account } }, notion)
    ).toBe('Your DorkOS account can’t reach Notion yet.');
  });

  it('gives the route’s own reason when a route exists but cannot sign in', () => {
    const blocked: ConnectorCatalogService = {
      ...notion,
      intents: [
        {
          kind: 'account',
          displayName: 'Use a Notion account',
          routes: [
            route('managed', {
              mode: 'managed',
              capabilities: {
                ...capabilities,
                authentication: { status: 'unsupported', reason: 'Not available for apps yet.' },
              },
            }),
          ],
        },
      ],
    };
    expect(needsFirstConnectStep(blocked)).toBe(true);
    expect(
      firstConnectReason(
        { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
        blocked
      )
    ).toBe('Not available for apps yet.');
  });

  it('explains a saved key that stopped working, and stays quiet when nothing is set up', () => {
    expect(
      firstConnectReason(
        { ways: [], newApps: { status: 'setup_needed', reason: 'own_key_unavailable' } },
        notion
      )
    ).toBe('Your saved key didn’t work the last time DorkOS checked it.');
    expect(
      firstConnectReason(
        {
          ways: [{ kind: 'dorkos_account', type: 'dorkos-managed', status: 'unlinked' }],
          newApps: { status: 'setup_needed', reason: 'dorkos_account_unlinked' },
        },
        notion
      )
    ).toBe('Your DorkOS account isn’t linked anymore.');
    expect(
      firstConnectReason(
        { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
        notion
      )
    ).toBeNull();
  });
});

describe('isCatalogOutage', () => {
  const way = {
    kind: 'own_key' as const,
    type: 'composio',
    status: 'ready' as const,
    providerInstanceId: 'c' as never,
  };
  const warning = { code: 'catalog_provider_unavailable', message: 'down' };

  it('is an outage only when a working way left the catalog partial', () => {
    expect(
      isCatalogOutage({
        warnings: [warning],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      })
    ).toBe(true);
    expect(
      isCatalogOutage({
        warnings: [],
        appConnections: { ways: [way], newApps: { status: 'ready', way } },
      })
    ).toBe(false);
    expect(
      isCatalogOutage({
        warnings: [warning],
        appConnections: {
          ways: [],
          newApps: { status: 'setup_needed', reason: 'own_key_unavailable' },
        },
      })
    ).toBe(false);
  });
});

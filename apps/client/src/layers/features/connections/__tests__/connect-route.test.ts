import { describe, expect, it } from 'vitest';
import type {
  ConnectorCatalogProviderRoute,
  ConnectorCatalogService,
} from '@dorkos/shared/connector-resource-schemas';
import {
  chooseConnectRoute,
  firstConnectReason,
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

  it('says nothing for a direct route or a sign-in with no consent page', () => {
    expect(signInLine(route('a'), notion)).toBeNull();
    expect(
      signInLine(route('a', { signInThrough: 'Composio', authKind: 'api-key' }), notion)
    ).toBeNull();
  });
});

describe('firstConnectReason', () => {
  it('says the working way does not reach this app', () => {
    const way = {
      kind: 'own_key' as const,
      type: 'nango',
      status: 'ready' as const,
      providerInstanceId: 'nango' as never,
      signInThrough: 'Nango',
    };
    expect(firstConnectReason({ ways: [way], newApps: { status: 'ready', way } }, 'Notion')).toBe(
      'Nango can’t reach Notion yet.'
    );
  });

  it('explains a saved key that stopped working, and stays quiet when nothing is set up', () => {
    expect(
      firstConnectReason(
        { ways: [], newApps: { status: 'setup_needed', reason: 'own_key_unavailable' } },
        'Notion'
      )
    ).toBe('Your saved key didn’t work the last time DorkOS checked it.');
    expect(
      firstConnectReason(
        { ways: [], newApps: { status: 'setup_needed', reason: 'nothing_set_up' } },
        'Notion'
      )
    ).toBeNull();
  });
});

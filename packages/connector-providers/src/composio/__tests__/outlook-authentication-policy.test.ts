import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projectComposioAuthenticationConfigPolicy } from '../authentication-config-policy.js';
import {
  matchesComposioAutomaticAuthenticationPolicy,
  normalizeComposioAuthenticationConfiguration,
} from '../authentication-configuration.js';

const outlook = (microsoft_cloud = 'global') => ({
  id: 'ac_synthetic',
  name: 'synthetic',
  toolkit: { slug: 'outlook' },
  auth_scheme: 'OAUTH2',
  status: 'ENABLED',
  is_composio_managed: true,
  type: 'default',
  is_enabled_for_tool_router: false,
  credentials: {
    client_id: 'SYNTHETIC_CLIENT',
    client_secret: 'PRIVATE_SENTINEL',
    oauth_redirect_uri: 'https://backend.composio.dev/api/v3/toolkits/auth/callback',
    scopes: ['read'],
    user_scopes: [],
    microsoft_cloud,
  },
  shared_credentials: {},
  shared_connection_fields: {},
  tool_access_config: {},
});

describe('managed Outlook OAuth policy envelope', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['global', 'REDACTED'])(
    'accepts the exact Outlook credential keys with %s without retaining their values',
    (cloud) => {
      const projected = projectComposioAuthenticationConfigPolicy(outlook(cloud));
      expect(projected).toEqual({
        type: 'default',
        scopes: ['read'],
        userScopes: [],
        credentialsEmpty: false,
        routerEnabled: false,
      });
      expect(JSON.stringify(projected)).not.toMatch(
        /microsoft_cloud|global|REDACTED|PRIVATE_SENTINEL|SYNTHETIC_CLIENT/
      );
      expect(console.warn).not.toHaveBeenCalled();
    }
  );

  it('preserves the normalized automatic policy when public-cloud metadata is present', () => {
    const raw = outlook();
    const { microsoft_cloud: _cloud, ...credentials } = raw.credentials;
    const before = normalizeComposioAuthenticationConfiguration({ ...raw, credentials });
    const after = normalizeComposioAuthenticationConfiguration(raw);
    expect(after).toEqual(before);
    expect(
      matchesComposioAutomaticAuthenticationPolicy(
        after,
        {
          toolkit: 'outlook',
          enabled: true,
          managedOAuth2: true,
          managedScopes: ['read'],
          managedUserScopes: [],
          methods: [],
        },
        { toolkit: 'outlook', scheme: 'OAUTH2', kind: 'oauth', source: 'managed', fields: [] }
      )
    ).toBe(true);
  });

  it.each([
    'gcc_high',
    'wrong-cloud',
    'GLOBAL',
    'redacted',
    ' global',
    'global ',
    'global/extra',
    ' REDACTED',
    'REDACTED ',
    'REDACTED/extra',
    '',
    null,
    undefined,
    true,
    42,
    {},
    [],
  ])('refuses a different or non-string cloud value (%#)', (microsoft_cloud) => {
    const raw = outlook();
    expect(
      projectComposioAuthenticationConfigPolicy({
        ...raw,
        credentials: { ...raw.credentials, microsoft_cloud },
      })
    ).toBeUndefined();
  });

  it.each(['gmail', 'slack', 'outlookmail', 'OUTLOOK', 'constructor', '__proto__'])(
    'refuses the cloud key on %s',
    (slug) => {
      expect(
        projectComposioAuthenticationConfigPolicy({ ...outlook(), toolkit: { slug } })
      ).toBeUndefined();
    }
  );

  it.each([
    { type: 'custom' },
    { is_composio_managed: false },
    { auth_scheme: 'API_KEY' },
    { toolkit: undefined },
  ])('requires managed Outlook OAuth (%#)', (change) => {
    expect(projectComposioAuthenticationConfigPolicy({ ...outlook(), ...change })).toBeUndefined();
  });

  it.each(['unknown_secret', 'verification_token'])('keeps the extra %s key refused', (key) => {
    const raw = outlook();
    expect(
      projectComposioAuthenticationConfigPolicy({
        ...raw,
        credentials: { ...raw.credentials, [key]: 'PRIVATE_SENTINEL' },
      })
    ).toBeUndefined();
  });

  it('logs the toolkit, reason and key names without credential values', () => {
    const raw = outlook();
    projectComposioAuthenticationConfigPolicy({
      ...raw,
      credentials: { ...raw.credentials, microsoft_cloud: 'PRIVATE_WRONG_CLOUD' },
    });
    expect(console.warn).toHaveBeenCalledWith(
      '[Composio] Authentication configuration policy refused',
      {
        toolkit: 'outlook',
        reason: 'unsupported_policy_shape',
        keys: ['credentials.microsoft_cloud'],
      }
    );
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toMatch(
      /PRIVATE_WRONG_CLOUD|PRIVATE_SENTINEL|SYNTHETIC_CLIENT|global|REDACTED/
    );
  });
});

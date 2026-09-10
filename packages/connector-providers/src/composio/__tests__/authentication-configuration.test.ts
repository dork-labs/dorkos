import { describe, expect, it } from 'vitest';
import {
  normalizeComposioToolkitAuthentication,
  normalizeComposioAuthenticationConfiguration,
  selectComposioAuthentication,
} from '../authentication-configuration.js';

const field = {
  name: 'api_key',
  displayName: 'API key',
  description: '',
  type: 'string',
  required: true,
  is_secret: true,
  default: 'SECRET_DEFAULT',
};
function raw(modes: string[] = ['API_KEY', 'OAUTH2']) {
  return {
    slug: 'synthetic',
    enabled: true,
    composio_managed_auth: [{ mode: 'OAUTH2', scopes: { available: ['read', 'write'] } }],
    auth_config_details: modes.map((mode) => ({
      mode,
      fields: {
        auth_config_creation: {
          required: [] as Array<typeof field>,
          optional: [] as Array<typeof field>,
        },
        connected_account_initiation: {
          required:
            mode === 'NO_AUTH'
              ? []
              : [
                  {
                    ...field,
                    name:
                      mode === 'BASIC' ? 'username' : mode === 'BEARER_TOKEN' ? 'token' : 'api_key',
                  },
                ],
          optional: [],
        },
      },
    })),
  };
}
const config = {
  id: 'ac_custom',
  name: 'Custom',
  toolkit: 'synthetic',
  scheme: 'API_KEY',
  enabled: true,
  managed: false,
};

describe('exact Composio authentication selection', () => {
  it('prefers managed OAuth over API key without retaining secret defaults', () => {
    const normalized = normalizeComposioToolkitAuthentication(raw());
    expect(selectComposioAuthentication(normalized)).toMatchObject({
      kind: 'oauth',
      source: 'managed',
      scheme: 'OAUTH2',
    });
    expect(JSON.stringify(normalized)).not.toContain('SECRET_DEFAULT');
    expect(normalized.managedScopes).toEqual(['read', 'write']);
  });
  it('preserves an explicit supported custom choice and refuses broken overrides without fallback', () => {
    const normalized = normalizeComposioToolkitAuthentication(raw());
    expect(selectComposioAuthentication(normalized, config)).toMatchObject({
      kind: 'fields',
      source: 'configured',
      scheme: 'API_KEY',
    });
    for (const bad of [
      { ...config, enabled: false },
      { ...config, toolkit: 'foreign' },
      { ...config, scheme: 'DCR_OAUTH' },
    ])
      expect(() => selectComposioAuthentication(normalized, bad)).toThrow();
  });
  it('keeps an exact existing OAuth2 override usable when optional field metadata is absent', () => {
    const normalized = normalizeComposioToolkitAuthentication({ slug: 'synthetic', enabled: true });
    expect(selectComposioAuthentication(normalized, { ...config, scheme: 'OAUTH2' })).toEqual({
      toolkit: 'synthetic',
      kind: 'oauth',
      scheme: 'OAUTH2',
      source: 'configured',
      fields: [],
    });
  });
  it('selects only declared field schemes and supports explicit empty no-auth', () => {
    for (const scheme of ['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH']) {
      const value = { ...raw([scheme]), composio_managed_auth: [] };
      expect(
        selectComposioAuthentication(normalizeComposioToolkitAuthentication(value))
      ).toMatchObject({ scheme, kind: scheme === 'NO_AUTH' ? 'none' : 'fields' });
    }
  });
  it('requires the pinned bearer/basic wire fields instead of silently creating an unusable account', () => {
    for (const scheme of ['BEARER_TOKEN', 'BASIC']) {
      const value = raw([scheme]);
      value.composio_managed_auth = [];
      value.auth_config_details[0].fields.connected_account_initiation.required[0].name =
        'unrelated';
      expect(() =>
        selectComposioAuthentication(normalizeComposioToolkitAuthentication(value))
      ).toThrow('account fields DorkOS does not support');
    }
  });
  it('does not manufacture OAuth for unknown modes, missing fields or developer setup requirements', () => {
    for (const scheme of ['OAUTH1', 'DCR_OAUTH', 'UNRECOGNIZED'])
      expect(() =>
        selectComposioAuthentication(
          normalizeComposioToolkitAuthentication({
            ...raw([scheme]),
            composio_managed_auth: [],
            composio_managed_auth_schemes: [scheme],
          })
        )
      ).toThrow();
    const value = raw(['API_KEY']);
    value.composio_managed_auth = [];
    value.auth_config_details[0].fields.auth_config_creation.required.push(field);
    expect(() =>
      selectComposioAuthentication(normalizeComposioToolkitAuthentication(value))
    ).toThrow();
  });
  it('rejects duplicate methods and leaves unknown input types unavailable', () => {
    expect(() => normalizeComposioToolkitAuthentication(raw(['API_KEY', 'API_KEY']))).toThrow();
    const constrained = raw(['API_KEY']);
    Object.assign(
      constrained.auth_config_details[0].fields.connected_account_initiation.required[0],
      { enum: ['fixed'] }
    );
    expect(() => normalizeComposioToolkitAuthentication(constrained)).toThrow(
      'declares account-field constraints'
    );
    const value = raw(['API_KEY']);
    value.composio_managed_auth = [];
    value.auth_config_details[0].fields.connected_account_initiation.required[0] = {
      ...field,
      type: 'object',
    };
    expect(() =>
      selectComposioAuthentication(normalizeComposioToolkitAuthentication(value))
    ).toThrow();
  });
  it('normalizes config identity without copying credentials or proxy secrets', () => {
    const normalized = normalizeComposioAuthenticationConfiguration({
      id: 'ac_custom',
      name: 'Custom',
      toolkit: { slug: 'synthetic' },
      auth_scheme: 'API_KEY',
      status: 'ENABLED',
      is_composio_managed: false,
      credentials: { token: 'SECRET' },
      proxy_config: { proxy_auth_key: 'SECRET' },
    });
    expect(normalized).toEqual(config);
    expect(JSON.stringify(normalized)).not.toContain('SECRET');
  });
});

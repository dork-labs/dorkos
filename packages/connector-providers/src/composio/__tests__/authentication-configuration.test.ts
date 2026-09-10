import { describe, expect, it } from 'vitest';
import {
  ComposioAuthenticationSetupError,
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
          optional: [] as Array<typeof field>,
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
  it('ignores provider-owned OAuth app setup constraints without weakening account fields', () => {
    const privateKey = 'PRIVATE_PROVIDER_CONSTRAINT';
    const privateValue = 'PRIVATE_PROVIDER_VALUE';
    const value = raw();
    const oauth = value.auth_config_details.find((method) => method.mode === 'OAUTH2')!;
    const oauthSetup = oauth.fields.auth_config_creation;
    oauthSetup.required.push(
      Object.assign({ ...field, name: 'oauth_required_1' }, { [privateKey]: privateValue }),
      Object.assign({ ...field, name: 'oauth_required_2' }, { [privateKey]: privateValue })
    );
    oauthSetup.optional.push(
      Object.assign({ ...field, name: 'oauth_optional_1' }, { [privateKey]: privateValue }),
      Object.assign({ ...field, name: 'oauth_optional_2' }, { [privateKey]: privateValue })
    );

    const normalized = normalizeComposioToolkitAuthentication(value);
    expect(selectComposioAuthentication(normalized)).toMatchObject({
      kind: 'oauth',
      source: 'managed',
      scheme: 'OAUTH2',
    });
    expect(selectComposioAuthentication(normalized, config)).toMatchObject({
      kind: 'fields',
      source: 'configured',
      scheme: 'API_KEY',
    });
    const brokenOverride = (() => {
      try {
        selectComposioAuthentication(normalized, { ...config, scheme: 'DCR_OAUTH' });
      } catch (error) {
        return error;
      }
    })();
    expect(brokenOverride).toMatchObject({ reason: 'unsupported_method' });
    expect(JSON.stringify(normalized)).not.toContain(privateKey);
    expect(JSON.stringify(normalized)).not.toContain(privateValue);

    const collected = raw(['API_KEY']);
    Object.assign(
      collected.auth_config_details[0].fields.connected_account_initiation.required[0],
      { [privateKey]: privateValue }
    );
    expect(() => normalizeComposioToolkitAuthentication(collected)).toThrow(
      'account-field constraints'
    );
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
    const constrainedError = (() => {
      try {
        normalizeComposioToolkitAuthentication(constrained);
      } catch (error) {
        return error;
      }
    })();
    expect(constrainedError).toMatchObject({
      reason: 'unsupported_metadata',
      metadataIssueCount: 1,
      metadataIssueLocations: ['connected_account_initiation_required'],
    });
    expect(String(constrainedError)).toContain('declares account-field constraints');
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
  it('projects strict issues only to fixed field regions and an issue-object count', () => {
    const privateKey = 'PRIVATE_UNKNOWN_KEY';
    const privateValue = 'PRIVATE_UNKNOWN_VALUE';
    const value = raw(['API_KEY']);
    const constrained = Object.assign({ ...field }, { [privateKey]: privateValue });
    const groups = value.auth_config_details[0].fields;
    groups.auth_config_creation.required.push({ ...constrained });
    groups.auth_config_creation.optional.push({ ...constrained });
    Object.assign(groups.connected_account_initiation.required[0], {
      [privateKey]: privateValue,
    });
    groups.connected_account_initiation.optional.push({ ...constrained });

    const error = (() => {
      try {
        normalizeComposioToolkitAuthentication(value);
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toMatchObject({
      reason: 'unsupported_metadata',
      metadataIssueCount: 4,
      metadataIssueLocations: [
        'auth_config_creation_optional',
        'auth_config_creation_required',
        'connected_account_initiation_optional',
        'connected_account_initiation_required',
      ],
      metadataMethodKinds: ['supported_account_fields'],
    });
    expect(JSON.stringify(error)).not.toContain(privateKey);
    expect(JSON.stringify(error)).not.toContain(privateValue);

    const unknownLocation = new ComposioAuthenticationSetupError('unsupported_metadata', {
      issueCount: 1,
      issueLocations: [privateKey],
      methodKinds: [privateKey],
    });
    expect(unknownLocation.metadataIssueLocations).toEqual([]);
    expect(unknownLocation.metadataMethodKinds).toEqual([]);
    expect(JSON.stringify(unknownLocation)).not.toContain(privateKey);

    const otherMethod = raw(['DCR']);
    Object.assign(
      otherMethod.auth_config_details[0].fields.connected_account_initiation.required[0],
      { [privateKey]: privateValue }
    );
    const otherError = (() => {
      try {
        normalizeComposioToolkitAuthentication(otherMethod);
      } catch (caught) {
        return caught;
      }
    })();
    expect(otherError).toMatchObject({ metadataMethodKinds: ['other'] });
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

import { describe, expect, it } from 'vitest';
import {
  normalizeComposioToolkitAuthentication,
  selectComposioAuthentication,
} from '../authentication-configuration.js';

// Representative field shapes observed from toolkit metadata on 2026-09-11.
// This is metadata only: no account credentials or provider responses are retained.
function toolkit(slug: string, visibility: unknown = true) {
  const field = (name: string, required: boolean) => ({
    name,
    displayName: name,
    description: 'Account setup field',
    type: 'string',
    required,
    user_visible: true,
  });
  const accountField = {
    ...field('generic_api_key', true),
    is_secret: true,
    legacy_template_name: 'api_key',
    user_visible: visibility,
  };
  return {
    slug,
    enabled: true,
    composio_managed_auth_schemes: ['OAUTH2'],
    auth_config_details: [
      {
        name: `${slug}_oauth`,
        mode: 'OAUTH2',
        required_scopes: [],
        fields: {
          auth_config_creation: {
            required: [field('client_id', true), field('client_secret', true)],
            optional: [
              {
                ...field('oauth_redirect_uri', false),
                default: 'https://backend.composio.dev/api/v1/auth-apps/add',
              },
              { ...field('scopes', false), default: 'read,write' },
            ],
          },
          connected_account_initiation: { required: [], optional: [] },
        },
      },
      ...(slug === 'googledrive'
        ? []
        : [
            {
              name: `${slug}_api_key`,
              mode: 'API_KEY',
              required_scopes: [],
              fields: {
                auth_config_creation: { required: [], optional: [] },
                connected_account_initiation: { required: [accountField], optional: [] },
              },
            },
          ]),
    ],
  };
}

const configured = (slug: string) => ({
  id: 'ac_synthetic',
  name: 'Synthetic explicit configuration',
  toolkit: slug,
  scheme: 'API_KEY',
  enabled: true,
  managed: false,
});

describe('Composio account-field visibility', () => {
  it.each(['linear', 'notion', 'googledrive'])('selects managed OAuth for %s metadata', (slug) => {
    const normalized = normalizeComposioToolkitAuthentication(toolkit(slug));
    expect(selectComposioAuthentication(normalized)).toEqual({
      toolkit: slug,
      scheme: 'OAUTH2',
      kind: 'oauth',
      source: 'managed',
      fields: [],
    });
  });

  it.each(['linear', 'notion'])(
    'preserves explicitly selected visible %s API-key fields',
    (slug) => {
      const normalized = normalizeComposioToolkitAuthentication(toolkit(slug));
      expect(selectComposioAuthentication(normalized, configured(slug)).fields).toEqual([
        {
          name: 'generic_api_key',
          label: 'generic_api_key',
          description: 'Account setup field',
          type: 'string',
          required: true,
          secret: true,
        },
      ]);
      expect(JSON.stringify(normalized)).not.toContain('user_visible');
      expect(JSON.stringify(normalized)).not.toContain('legacy_template_name');
    }
  );

  it('keeps hidden required fields unavailable without poisoning unrelated managed OAuth', () => {
    const value = toolkit('linear', false);
    const normalized = normalizeComposioToolkitAuthentication(value);
    expect(selectComposioAuthentication(normalized).kind).toBe('oauth');
    expect(() => selectComposioAuthentication(normalized, configured('linear'))).toThrow(
      'account fields DorkOS does not support'
    );
    value.composio_managed_auth_schemes = [];
    expect(() =>
      selectComposioAuthentication(normalizeComposioToolkitAuthentication(value))
    ).toThrow('account fields DorkOS does not support');
  });

  it.each(['true', 1, null, {}])('rejects malformed visibility %j', (visibility) => {
    expect(() => normalizeComposioToolkitAuthentication(toolkit('linear', visibility))).toThrow();
  });

  it.each(['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH'])(
    'keeps hidden optional fields unavailable for %s',
    (scheme) => {
      const visibleField = {
        name: scheme === 'BASIC' ? 'username' : scheme === 'BEARER_TOKEN' ? 'token' : 'api_key',
        displayName: 'Account field',
        description: '',
        type: 'string',
        required: true,
        user_visible: true,
      };
      const value = {
        slug: 'synthetic',
        enabled: true,
        auth_config_details: [
          {
            mode: scheme,
            fields: {
              auth_config_creation: { required: [], optional: [] },
              connected_account_initiation: {
                required: scheme === 'NO_AUTH' ? [] : [visibleField],
                optional: [
                  {
                    ...visibleField,
                    name: 'hidden_context',
                    required: false,
                    user_visible: false,
                    default: 'HIDDEN_PROVIDER_DEFAULT',
                  },
                ],
              },
            },
          },
        ],
      };
      const normalized = normalizeComposioToolkitAuthentication(value);
      expect(() => selectComposioAuthentication(normalized)).toThrow(
        'account fields DorkOS does not support'
      );
      expect(() =>
        selectComposioAuthentication(normalized, {
          ...configured('synthetic'),
          scheme,
        })
      ).toThrow('account fields DorkOS does not support');
      expect(JSON.stringify(normalized)).not.toContain('HIDDEN_PROVIDER_DEFAULT');
    }
  );

  it('leaves hidden OAuth initiation context with Connect Link', () => {
    const value = toolkit('linear', false);
    value.auth_config_details[0].fields.connected_account_initiation.required = [
      ...value.auth_config_details[1].fields.connected_account_initiation.required,
    ];
    const normalized = normalizeComposioToolkitAuthentication(value);
    expect(selectComposioAuthentication(normalized)).toMatchObject({ kind: 'oauth', fields: [] });
    expect(
      selectComposioAuthentication(normalized, {
        ...configured('linear'),
        scheme: 'OAUTH2',
      })
    ).toMatchObject({ kind: 'oauth', fields: [] });
  });

  it('does not treat visible fields as permission to discard unknown constraints', () => {
    const value = toolkit('linear');
    const required = value.auth_config_details[1].fields.connected_account_initiation.required;
    Object.assign(required[0], { enum: ['provider-required-value'] });
    expect(() => normalizeComposioToolkitAuthentication(value)).toThrow(
      'account-field constraints'
    );
  });
});

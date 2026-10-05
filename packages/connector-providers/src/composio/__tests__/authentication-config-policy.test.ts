import { describe, expect, it } from 'vitest';
import { projectComposioAuthenticationConfigPolicy } from '../authentication-config-policy.js';

const canonical = () => ({
  id: 'ac_synthetic',
  name: 'synthetic',
  toolkit: { slug: 'gmail' },
  auth_scheme: 'OAUTH2',
  is_composio_managed: true,
  type: 'default',
  is_enabled_for_tool_router: false,
  is_connection_revoke_supported: true,
  credentials: {
    client_id: 'SYNTHETIC_CLIENT',
    client_secret: 'PRIVATE_SENTINEL',
    oauth_redirect_uri: 'https://backend.composio.dev/api/v1/auth-apps/add',
    scopes: ['read'],
    user_scopes: [],
  },
  shared_credentials: {},
  tool_access_config: {},
});

describe('managed OAuth policy envelope', () => {
  it('accepts provider app metadata without retaining its values', () => {
    const projected = projectComposioAuthenticationConfigPolicy(canonical());
    expect(projected).toEqual({
      type: 'default',
      scopes: ['read'],
      userScopes: [],
      credentialsEmpty: false,
      routerEnabled: false,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /PRIVATE_SENTINEL|SYNTHETIC_CLIENT|oauth_redirect/
    );
  });
  it('accepts the documented v3 callback', () => {
    const raw = canonical();
    raw.credentials.oauth_redirect_uri =
      'https://backend.composio.dev/api/v3/toolkits/auth/callback';
    expect(projectComposioAuthenticationConfigPolicy(raw)).toBeDefined();
  });
  it.each([
    { type: 'custom' },
    { is_composio_managed: false },
    { auth_scheme: 'API_KEY' },
    { is_connection_revoke_supported: 'true' },
    { unknown_policy: true },
    { shared_credentials: { token: 'PRIVATE_SENTINEL' } },
    { proxy_config: { proxy_url: 'https://evil.test' } },
    { tool_access_config: { tools_available_for_execution: ['WRITE'] } },
    { restrict_to_following_tools: ['WRITE'] },
  ])('refuses unsupported or authority-changing envelope %j', (change) => {
    expect(
      projectComposioAuthenticationConfigPolicy({ ...canonical(), ...change })
    ).toBeUndefined();
  });
  it.each([
    { oauth_redirect_uri: 'https://evil.test' },
    { oauth_redirect_uri: 'https://backend.composio.dev.evil.test/api/v1/auth-apps/add' },
    { oauth_redirect_uri: 'https://backend.composio.dev/api/v1/auth-apps/add?next=evil' },
    { oauth_redirect_uri: 'https://backend.composio.dev/api/v1/auth-apps/add/extra' },
    { unknown_secret: 'PRIVATE_SENTINEL' },
    { client_secret: { nested: 'PRIVATE_SENTINEL' } },
    { scopes: null },
  ])('refuses unsupported credential shape %j', (change) => {
    const raw = canonical();
    expect(
      projectComposioAuthenticationConfigPolicy({
        ...raw,
        credentials: { ...raw.credentials, ...change },
      })
    ).toBeUndefined();
  });
});

// Composio's managed Slack app carries one more credential key than other
// managed OAuth apps: Slack's legacy `verification_token`. It is the provider
// app's own material, like `client_secret`, so it is accepted only for Slack
// and its value is never retained.
describe('managed Slack OAuth policy envelope', () => {
  const slack = () => {
    const raw = canonical();
    return {
      ...raw,
      toolkit: { slug: 'slack' },
      credentials: { ...raw.credentials, verification_token: 'SLACK_VERIFICATION_SENTINEL' },
    };
  };

  it('accepts the verification token Composio stores for its managed Slack app', () => {
    const projected = projectComposioAuthenticationConfigPolicy(slack());
    expect(projected).toEqual({
      type: 'default',
      scopes: ['read'],
      userScopes: [],
      credentialsEmpty: false,
      routerEnabled: false,
    });
    expect(JSON.stringify(projected)).not.toMatch(
      /SLACK_VERIFICATION_SENTINEL|verification_token|PRIVATE_SENTINEL/
    );
  });

  it('still refuses the verification token for any other toolkit', () => {
    for (const slug of ['gmail', 'slackbot', 'SLACK', 'discord']) {
      expect(
        projectComposioAuthenticationConfigPolicy({ ...slack(), toolkit: { slug } }),
        slug
      ).toBeUndefined();
    }
  });

  it('refuses the verification token on a Slack config with no toolkit slug', () => {
    const { toolkit: _toolkit, ...withoutToolkit } = slack();
    expect(projectComposioAuthenticationConfigPolicy(withoutToolkit)).toBeUndefined();
  });

  it('refuses a verification token that is not a string', () => {
    const raw = slack();
    expect(
      projectComposioAuthenticationConfigPolicy({
        ...raw,
        credentials: { ...raw.credentials, verification_token: { nested: 'SENTINEL' } },
      })
    ).toBeUndefined();
  });

  it('keeps every other unknown credential key refused for Slack', () => {
    const raw = slack();
    expect(
      projectComposioAuthenticationConfigPolicy({
        ...raw,
        credentials: { ...raw.credentials, signing_secret: 'PRIVATE_SENTINEL' },
      })
    ).toBeUndefined();
  });
});

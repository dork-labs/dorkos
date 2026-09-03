import { describe, it, expect } from 'vitest';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { resolveTunnelSettings, type TunnelEnvInputs } from '../tunnel-settings.js';

/** An env with nothing tunnel-related set — the desktop shell's situation. */
const EMPTY_ENV: TunnelEnvInputs = {
  TUNNEL_ENABLED: undefined,
  TUNNEL_PORT: undefined,
  TUNNEL_AUTH: undefined,
  TUNNEL_DOMAIN: undefined,
  NGROK_AUTHTOKEN: undefined,
};

/** A stored `tunnel` section, defaulted to "off and empty" like the schema's. */
function stored(overrides: Partial<UserConfig['tunnel']> = {}): UserConfig['tunnel'] {
  return { enabled: false, domain: null, authtoken: null, auth: null, ...overrides };
}

/** Call the resolver with the boilerplate filled in. */
function resolve(
  env: Partial<TunnelEnvInputs>,
  tunnel: UserConfig['tunnel'] | undefined,
  fallbackPort = 4242
) {
  return resolveTunnelSettings({ env: { ...EMPTY_ENV, ...env }, stored: tunnel, fallbackPort });
}

describe('resolveTunnelSettings', () => {
  describe('the enabled decision (what boot autostart reads)', () => {
    it('is enabled when the env flag says true, whatever the stored config says', () => {
      expect(resolve({ TUNNEL_ENABLED: true }, stored({ enabled: false })).enabled).toBe(true);
    });

    it('is enabled when the env flag is UNSET and the stored config says true', () => {
      // The desktop shell (apps/desktop/src/main/server-spawn.ts) passes no
      // TUNNEL_* env at all, so before DOR-1738 an enabled tunnel silently
      // failed to come back after a restart.
      expect(resolve({ TUNNEL_ENABLED: undefined }, stored({ enabled: true })).enabled).toBe(true);
    });

    it('is NOT enabled when the env flag is explicitly false and the config says true', () => {
      // An explicit `TUNNEL_ENABLED=false` is a person telling THIS process not
      // to expose itself; a stored preference must not talk it out of that.
      expect(resolve({ TUNNEL_ENABLED: false }, stored({ enabled: true })).enabled).toBe(false);
    });

    it('is not enabled when neither says so', () => {
      expect(resolve({ TUNNEL_ENABLED: undefined }, stored({ enabled: false })).enabled).toBe(
        false
      );
      expect(resolve({ TUNNEL_ENABLED: false }, stored({ enabled: false })).enabled).toBe(false);
    });

    it('is not enabled when there is no stored tunnel section at all', () => {
      expect(resolve({ TUNNEL_ENABLED: undefined }, undefined).enabled).toBe(false);
    });

    it('is still enabled from the env alone when there is no stored tunnel section', () => {
      expect(resolve({ TUNNEL_ENABLED: true }, undefined).enabled).toBe(true);
    });
  });

  describe('the settings it starts with', () => {
    it('prefers every env value over its stored counterpart', () => {
      const { config } = resolve(
        {
          TUNNEL_PORT: 5000,
          NGROK_AUTHTOKEN: 'env-token',
          TUNNEL_DOMAIN: 'env.ngrok.app',
          TUNNEL_AUTH: 'env-user:env-pass',
        },
        stored({
          authtoken: 'stored-token',
          domain: 'stored.ngrok.app',
          auth: 'stored-user:stored-pass',
        })
      );

      expect(config).toEqual({
        port: 5000,
        authtoken: 'env-token',
        domain: 'env.ngrok.app',
        basicAuth: 'env-user:env-pass',
      });
    });

    it('falls back to every stored value when the env carries none', () => {
      const { config } = resolve(
        {},
        stored({
          authtoken: 'stored-token',
          domain: 'stored.ngrok.app',
          auth: 'stored-user:stored-pass',
        }),
        4242
      );

      expect(config).toEqual({
        port: 4242,
        authtoken: 'stored-token',
        domain: 'stored.ngrok.app',
        basicAuth: 'stored-user:stored-pass',
      });
    });

    it('normalizes the stored nulls to undefined so nothing is passed to ngrok as null', () => {
      // TunnelConfig's optional fields are `string | undefined`; the config
      // schema spells "not set" as `null`. Handing ngrok a null domain would
      // ask it to register the domain "null".
      const { config } = resolve({}, stored());

      expect(config).toEqual({
        port: 4242,
        authtoken: undefined,
        domain: undefined,
        basicAuth: undefined,
      });
    });

    it('falls back to the port the app is served on when TUNNEL_PORT is unset', () => {
      expect(resolve({}, stored(), 6241).config.port).toBe(6241);
    });

    it('mixes the two sources per field rather than picking one source wholesale', () => {
      // The order is per field, so an env token plus a stored domain is a real
      // combination — this is what the CLI's config-to-env shim already does.
      const { config } = resolve(
        { NGROK_AUTHTOKEN: 'env-token' },
        stored({ authtoken: 'stored-token', domain: 'stored.ngrok.app' })
      );

      expect(config.authtoken).toBe('env-token');
      expect(config.domain).toBe('stored.ngrok.app');
    });

    it('treats an empty stored string as "not set" rather than passing it through', () => {
      // A blank domain reaches ngrok as `domain: ''`, which is not the same
      // request as "give me an ephemeral URL".
      const { config } = resolve({}, stored({ domain: '', auth: '', authtoken: '' }));

      expect(config).toEqual({
        port: 4242,
        authtoken: undefined,
        domain: undefined,
        basicAuth: undefined,
      });
    });

    it('honors an exported TUNNEL_AUTH even when nothing is stored (DOR-1738)', () => {
      // The security case: an operator who exports TUNNEL_AUTH and then turns
      // Remote Access on from the app used to get a tunnel with no password on
      // it, while GET /api/config told them auth was enabled.
      expect(resolve({ TUNNEL_AUTH: 'user:pass' }, stored()).config.basicAuth).toBe('user:pass');
      expect(resolve({ TUNNEL_AUTH: 'user:pass' }, undefined).config.basicAuth).toBe('user:pass');
    });

    it('resolves the same settings whether or not the tunnel is enabled', () => {
      // The route ignores `enabled` — the request is the intent — so the config
      // half must not quietly depend on it.
      const on = resolve({ TUNNEL_ENABLED: true, NGROK_AUTHTOKEN: 't' }, stored({ enabled: true }));
      const off = resolve({ TUNNEL_ENABLED: false, NGROK_AUTHTOKEN: 't' }, stored());

      expect(off.config).toEqual(on.config);
    });
  });
});

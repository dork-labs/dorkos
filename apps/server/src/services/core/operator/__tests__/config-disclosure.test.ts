/**
 * Drift guard + behavior tests for the tokenless config-disclosure allowlist.
 *
 * `config_get` answers with no credential on the login-off external `/mcp`
 * surface, so what it returns has to be a deliberate projection rather than
 * "everything minus a denylist". The guard here is the point of this file: it
 * compares {@link CONFIG_DISCLOSURE} against the leaves of the live
 * {@link UserConfigSchema} in **both** directions, so adding, renaming, or
 * removing a config field fails until someone classifies it. A denylist would
 * pass silently in exactly that case, which is how `mcp.apiKey` once reached this
 * surface.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  CONFIG_DISCLOSURE,
  PRESENCE_FLAG_PATHS,
  type ConfigDisclosure,
  configSchemaLeafPaths,
  projectDisclosedConfig,
} from '../config-disclosure.js';

/** Read a dot-path out of a plain object, or `undefined` when any hop is missing. */
function at(root: unknown, dotPath: string): unknown {
  let node: unknown = root;
  for (const part of dotPath.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Dot-paths classified with the given verdict. */
function pathsWithVerdict(verdict: ConfigDisclosure): string[] {
  return Object.entries(CONFIG_DISCLOSURE)
    .filter(([, v]) => v === verdict)
    .map(([k]) => k);
}

/**
 * A fully-populated, schema-valid config where every secret and credential
 * reference carries a unique `LEAK-<n>` sentinel, so a single sweep over the
 * serialized projection proves none of them escaped.
 */
function fullyPopulatedConfig(): Record<string, unknown> {
  const base = UserConfigSchema.parse({ version: 1 }) as unknown as Record<string, unknown>;
  return {
    ...base,
    server: { port: 4242, cwd: '/Users/me/code', boundary: '/Users/me', open: true },
    tunnel: {
      enabled: true,
      domain: 'my.example.com',
      authtoken: 'LEAK-1-ngrok-authtoken',
      auth: 'LEAK-2-basic-auth',
    },
    mcp: {
      enabled: true,
      apiKey: 'LEAK-3-mcp-api-key',
      rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
    },
    cloud: {
      instanceToken: 'LEAK-4-cloud-instance-token',
      instanceName: 'my-box',
      linkedAccountLabel: 'LEAK-5-person@example.com',
    },
    runtimes: {
      default: 'claude-code',
      opencode: {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/opencode',
        port: 0,
        provider: 'openrouter',
        baseURL: null,
      },
      codex: {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/codex',
        credentialRef: 'file:LEAK-6-codex-key-file',
      },
    },
    providers: {
      anthropic: 'file:LEAK-7-anthropic-key-file',
      openrouter: 'env:LEAK-8-OPENROUTER_API_KEY',
    },
    mesh: { scanRoots: ['/Users/me/code', '/Users/me/work'] },
  };
}

describe('CONFIG_DISCLOSURE drift guard', () => {
  it('classifies every leaf of UserConfigSchema', () => {
    // Direction A: a newly added config field must not slip onto the tokenless
    // surface unclassified. The failure message names the offenders so the fix is
    // "add a verdict", not "go hunting".
    const unclassified = configSchemaLeafPaths().filter((p) => !(p in CONFIG_DISCLOSURE));
    expect(unclassified).toEqual([]);
  });

  it('classifies nothing that is not a leaf of UserConfigSchema', () => {
    // Direction B: a renamed or removed field must not leave a stale verdict
    // behind, which would silently stop covering the field that replaced it.
    const schemaLeaves = new Set(configSchemaLeafPaths());
    const stale = Object.keys(CONFIG_DISCLOSURE).filter((p) => !schemaLeaves.has(p));
    expect(stale).toEqual([]);
  });

  it('withholds every secret and every credential reference', () => {
    // The classification itself is asserted, not just the projection: this is the
    // list a reviewer reads. Changing any of these to `expose` is a security
    // decision and has to break a test.
    expect(pathsWithVerdict('withhold').sort()).toEqual([
      'cloud.instanceToken',
      'cloud.linkedAccountLabel',
      'mcp.apiKey',
      'providers',
      'runtimes.codex.credentialRef',
      'tunnel.auth',
      'tunnel.authtoken',
    ]);
  });

  it('only flags presence for paths that are actually withheld', () => {
    for (const dotPath of PRESENCE_FLAG_PATHS) {
      expect(CONFIG_DISCLOSURE[dotPath as keyof typeof CONFIG_DISCLOSURE]).toBe('withhold');
    }
  });
});

describe('projectDisclosedConfig', () => {
  it('emits every exposed path present in the input', () => {
    const projected = projectDisclosedConfig(fullyPopulatedConfig());
    const missing = pathsWithVerdict('expose').filter((p) => at(projected, p) === undefined);
    expect(missing).toEqual([]);
  });

  it('emits no withheld path', () => {
    const projected = projectDisclosedConfig(fullyPopulatedConfig());
    const leaked = pathsWithVerdict('withhold').filter((p) => at(projected, p) !== undefined);
    expect(leaked).toEqual([]);
  });

  it('leaks no secret or credential-reference value anywhere in the payload', () => {
    // The catch-all: whatever the shape, no sentinel may appear in the JSON that
    // reaches an unauthenticated caller.
    const serialized = JSON.stringify(projectDisclosedConfig(fullyPopulatedConfig()));
    expect(serialized).not.toMatch(/LEAK-/);
  });

  it('replaces withheld credentials with boolean presence flags', () => {
    const projected = projectDisclosedConfig(fullyPopulatedConfig());
    expect(at(projected, 'tunnel.authtokenConfigured')).toBe(true);
    expect(at(projected, 'tunnel.authConfigured')).toBe(true);
    expect(at(projected, 'mcp.apiKeyConfigured')).toBe(true);
    expect(at(projected, 'cloud.instanceTokenConfigured')).toBe(true);
    expect(at(projected, 'runtimes.codex.credentialRefConfigured')).toBe(true);
    expect(projected.providersConfigured).toEqual(['anthropic', 'openrouter']);
  });

  it('reports false and an empty provider list on a fresh install', () => {
    const projected = projectDisclosedConfig(
      UserConfigSchema.parse({ version: 1 }) as unknown as Record<string, unknown>
    );
    expect(at(projected, 'tunnel.authtokenConfigured')).toBe(false);
    expect(at(projected, 'mcp.apiKeyConfigured')).toBe(false);
    expect(at(projected, 'cloud.instanceTokenConfigured')).toBe(false);
    expect(at(projected, 'runtimes.codex.credentialRefConfigured')).toBe(false);
    expect(projected.providersConfigured).toEqual([]);
  });

  it('keeps the paths an operator agent needs to address work', () => {
    // Deliberate exposure, not an oversight: `update_agent` targets an agent by
    // `cwd`, and an agent that cannot see the boundary cannot tell what it may
    // touch. Documented in the module doc; asserted so a later "redact all paths"
    // pass has to argue with a test.
    const projected = projectDisclosedConfig(fullyPopulatedConfig());
    expect(at(projected, 'server.cwd')).toBe('/Users/me/code');
    expect(at(projected, 'server.boundary')).toBe('/Users/me');
    expect(at(projected, 'mesh.scanRoots')).toEqual(['/Users/me/code', '/Users/me/work']);
  });

  it('drops keys the schema does not describe', () => {
    // An allowlist gets this for free: `conf` bookkeeping and any hand-edited
    // stray key never reach the caller.
    const projected = projectDisclosedConfig({
      ...fullyPopulatedConfig(),
      __internal__: { migrations: { version: '0.56.0' } },
      handEditedStray: 'LEAK-9-stray',
    });
    expect(projected.__internal__).toBeUndefined();
    expect(projected.handEditedStray).toBeUndefined();
    expect(JSON.stringify(projected)).not.toMatch(/LEAK-/);
  });

  it('does not materialize absent sections', () => {
    // A partial store (an older on-disk config, or a unit-test stub) must not gain
    // invented `null`s that a caller would read as "explicitly unset".
    const projected = projectDisclosedConfig({ version: 1 });
    expect(projected.version).toBe(1);
    expect(projected.server).toBeUndefined();
    expect(projected.ui).toBeUndefined();
  });

  it('returns a copy, never a live reference into the stored config', () => {
    const raw = fullyPopulatedConfig();
    const projected = projectDisclosedConfig(raw);
    (projected.mesh as { scanRoots: string[] }).scanRoots.push('/tmp/injected');
    expect((raw.mesh as { scanRoots: string[] }).scanRoots).toEqual([
      '/Users/me/code',
      '/Users/me/work',
    ]);
  });
});

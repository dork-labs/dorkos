/**
 * What the tokenless `config_get` projection emits: every exposed path, no
 * withheld one, presence flags for credentials, and nothing a hand-edited file
 * hides under a classified leaf. The drift guard is `../config-disclosure.test.ts`.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import { projectDisclosedConfig } from '../../config-disclosure.js';
import { at, fullyPopulatedConfig, pathsWithVerdict } from './config-disclosure.fixtures.js';

describe('projectDisclosedConfig', () => {
  it('starts from a fixture the live schema still accepts', () => {
    // Everything below asserts against this fixture, so it has to stay real: a
    // schema change that invalidates it would otherwise quietly weaken the rest.
    expect(() => UserConfigSchema.parse(fullyPopulatedConfig())).not.toThrow();
  });

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
    expect(serialized).not.toMatch(/LEAK[-_]/);
  });

  it('keeps raw MCP labels and transports while withholding complete URLs', () => {
    const config = UserConfigSchema.parse(fullyPopulatedConfig());
    const projected = projectDisclosedConfig(config);
    expect(projected.connectors).toEqual({
      rawMcpServers: [
        { slug: 'notion', displayName: 'Notion', transport: 'http' },
        { slug: 'calendar', displayName: 'Calendar', transport: 'sse' },
      ],
    });
    expect(config.connectors.rawMcpServers[0].url).toContain('LEAK-11-password');
    expect(config.connectors.rawMcpServers[1].url).toContain('LEAK-12-query-token');
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

  it('rebuilds a sidebar group from classified fields, dropping anything else', () => {
    // The realistic version of the defect: a credential-shaped property added to
    // the object inside `ui.sidebar.groups[]`. The guard above fails the build in
    // that case, and this proves the projection would not have emitted it anyway.
    const raw = fullyPopulatedConfig();
    const group = (raw.ui as { sidebar: { groups: Record<string, unknown>[] } }).sidebar.groups[0]!;
    group.secretToken = 'LEAK-10-group-token';
    group.credentials = { anthropic: 'LEAK-11-nested-in-group' };

    const projected = projectDisclosedConfig(raw);
    const projectedGroup = at(projected, 'ui.sidebar.groups[]') as Record<string, unknown>;
    expect(JSON.stringify(projected)).not.toMatch(/LEAK-/);
    expect(projectedGroup.secretToken).toBeUndefined();
    expect(projectedGroup.credentials).toBeUndefined();
    // And not over-redacted: the group a person configured still arrives whole.
    expect(projectedGroup.id).toBe('group-1');
    expect(projectedGroup.name).toBe('Work');
    expect(projectedGroup.items).toEqual([
      { kind: 'agent', path: '/Users/me/code' },
      { kind: 'room', roomId: '01JROOM' },
    ]);
    expect(projectedGroup.rules).toEqual({
      runtimes: ['claude-code'],
      namespaces: ['default'],
      statuses: ['active'],
      lastActiveWithinMs: 86_400_000,
      pathPrefix: '/Users/me',
    });
  });

  it('drops a non-scalar value stored under an exposed open record', () => {
    // An open record's keys are user-supplied, so the allowlist promise is only
    // about its value type. If a value ever stops being scalar, the entry goes.
    const raw = fullyPopulatedConfig();
    // A record's keys are whatever someone wrote, including the one key that is
    // not really a key. It has to be built with `JSON.parse` (as `conf` does when
    // it reads the file): an object literal's `__proto__` hits the prototype
    // setter and never becomes an own property, so a literal would assert
    // nothing. Skipping it is explicit in `sanitizeLeafValue` rather than left to
    // the setter's no-op, which a refactor could quietly undo.
    (raw.ui as { shapes: { agentDefaults: unknown } }).shapes.agentDefaults = JSON.parse(
      '{"/Users/me/code":"focus",' +
        '"/Users/me/work":{"shape":"focus","token":"LEAK-12-record-value"},' +
        '"__proto__":"LEAK-14-prototype-key"}'
    ) as Record<string, unknown>;

    const projected = projectDisclosedConfig(raw);
    const disclosed = at(projected, 'ui.shapes.agentDefaults') as Record<string, unknown>;
    expect(JSON.stringify(projected)).not.toMatch(/LEAK-/);
    expect(disclosed).toEqual({ '/Users/me/code': 'focus' });
    expect(Object.getOwnPropertyNames(disclosed)).toEqual(['/Users/me/code']);
    expect(({} as Record<string, unknown>).token).toBeUndefined();
  });

  it('drops structure hiding under a scalar leaf in a hand-edited config', () => {
    // The stored file is not always schema-valid: `conf` repairs corruption, and
    // a person can edit `config.json`. A leaf classified scalar never carries an
    // object out, whatever the file says.
    const projected = projectDisclosedConfig({
      ...fullyPopulatedConfig(),
      server: { port: 4242, cwd: { path: '/Users/me/code', token: 'LEAK-13-under-a-scalar' } },
    });
    expect(JSON.stringify(projected)).not.toMatch(/LEAK-/);
    expect(at(projected, 'server.cwd')).toBeUndefined();
    expect(at(projected, 'server.port')).toBe(4242);
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

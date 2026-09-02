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
 * Membership alone is not enough, so there is a third direction: every `expose`
 * verdict must also **resolve to a scalar**, an array of scalars, or an
 * explicitly allowlisted open record. Without that, a verdict on a subtree
 * (`ui.sidebar.groups`, an array of nine-property objects) silently covers whatever
 * anyone adds inside it, which is the `mcp.apiKey` failure mode one level down.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { UserConfigSchema } from '@dorkos/shared/config-schema';
import {
  CONFIG_DISCLOSURE,
  EXPOSED_RECORD_PATHS,
  PRESENCE_FLAG_PATHS,
  type ConfigDisclosure,
  type SchemaLeafShape,
  classifySchemaLeaves,
  configSchemaLeafPaths,
  configSchemaLeaves,
  projectDisclosedConfig,
} from '../config-disclosure.js';

/**
 * Read a dot-path out of a plain object, or `undefined` when any hop is missing.
 *
 * A `[]` segment reads the FIRST element in which the rest of the path resolves,
 * not simply element zero. `ui.sidebar.pinned` and friends hold a discriminated
 * union (sidebar-groups, DOR-579), so each element carries only its own branch's
 * fields — `path` on an agent, `roomId` on a room. An exposed per-element path
 * is therefore present in SOME element, and element-zero-only would report a
 * correctly-projected room field as missing.
 */
function at(root: unknown, dotPath: string): unknown {
  return walkPath(
    root,
    dotPath.split('.').filter((segment) => segment.length > 0)
  );
}

/** Recursive half of {@link at}. */
function walkPath(node: unknown, segments: readonly string[]): unknown {
  const segment = segments[0];
  if (segment === undefined) return node;
  const rest = segments.slice(1);
  if (node === null || typeof node !== 'object') return undefined;
  const next = (node as Record<string, unknown>)[segment.replace(/\[\]$/, '')];
  if (!segment.endsWith('[]')) return walkPath(next, rest);
  if (!Array.isArray(next)) return undefined;
  for (const element of next) {
    const found = walkPath(element, rest);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Shape the walker assigned to each leaf of the live schema. */
function schemaLeafShapes(): Map<string, SchemaLeafShape> {
  return new Map(configSchemaLeaves().map((leaf) => [leaf.path, leaf.shape]));
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
 *
 * Every nested shape is populated too (a smart sidebar group with all five rules,
 * both open records, and BOTH branches of the sidebar item-reference union in
 * each of the three membership lists), because an empty array or map — or a list
 * that only ever exercises one branch of a union — proves nothing about how the
 * projection treats what is inside one.
 */
function fullyPopulatedConfig(): Record<string, unknown> {
  const base = UserConfigSchema.parse({ version: 1 }) as unknown as Record<string, unknown>;
  return {
    ...base,
    server: { port: 4242, cwd: '/Users/me/code', boundary: '/Users/me', open: true },
    ui: {
      theme: 'dark',
      dismissedUpgradeVersions: ['0.55.0'],
      sidebar: {
        pinned: [
          { kind: 'agent', path: '/Users/me/code' },
          { kind: 'room', roomId: '01JPINNEDROOM' },
        ],
        groups: [
          {
            id: 'group-1',
            name: 'Work',
            // Both branches of the item-reference union, so the projection is
            // exercised on an element that carries `path` and one that carries
            // `roomId` (each drops the other branch's field).
            items: [
              { kind: 'agent', path: '/Users/me/code' },
              { kind: 'room', roomId: '01JROOM' },
            ],
            sortMode: 'recent',
            collapsed: false,
            displayFilter: 'all',
            muted: false,
            kind: 'smart',
            rules: {
              runtimes: ['claude-code'],
              namespaces: ['default'],
              statuses: ['active'],
              lastActiveWithinMs: 86_400_000,
              pathPrefix: '/Users/me',
            },
          },
        ],
        sections: { agents: { collapsed: true, sortMode: 'recent', displayFilter: 'active' } },
        muted: [
          { kind: 'agent', path: '/Users/me/noisy' },
          { kind: 'room', roomId: '01JMUTEDROOM' },
        ],
        gettingStarted: { retired: ['suggestion:ask-dorkbot'] },
        digest: { lastShownDate: '2026-08-09' },
      },
      promos: { dismissedIds: ['remote-access'] },
      shapes: {
        active: 'focus',
        agentDefaults: { '/Users/me/code': 'focus' },
        autoFollowAgent: false,
      },
      statusBar: { pins: ['cwd'] },
      composer: { richText: true },
      autonomyAcknowledgedAt: '2026-08-01T09:30:00.000Z',
      fullPowerDecidedAt: '2026-08-22T11:15:00.000Z',
      fullPowerChoice: 'full',
    },
    profile: {
      roles: ['Engineer'],
      tools: ['Linear'],
      displayName: 'Dorian',
      // The `agent` branch of the provenance union, because it is the only one
      // that carries both leaves — an `operator` value has no `agentName`, so a
      // fixture built on it would leave that path unexercised (DOR-1022).
      displayNameSource: { kind: 'agent', agentName: 'DorkBot' },
      rolePromptDismissedAt: '2026-08-05T12:00:00.000Z',
    },
    workbench: { defaultViewers: { csv: 'file' }, terminalGraceTtlMinutes: 10, autoOpenDiff: true },
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
      // Deliberately NOT the shipped default, so the projection is shown to
      // carry the stored value rather than a schema default that would look
      // identical either way.
      dorkosTools: true,
      // A global stop with one runtime overriding it, so the projection is
      // exercised on both halves of the override rather than on one.
      defaultTrustStop: 'act',
      // A populated roster, including an unnamed account, so the projection is
      // exercised on both `label` branches rather than on an empty array.
      claudeCode: {
        defaultAccount: '/Users/me/.claude2',
        accounts: [
          { id: 'acme-corp', path: '/Users/me/.claude', label: 'Acme Corp' },
          { id: 'claude2', path: '/Users/me/.claude2', label: null },
        ],
        defaultModel: 'opus',
        defaultEffort: 'high',
        defaultTrustStop: null,
        persistentSession: true,
      },
      opencode: {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/opencode',
        port: 0,
        provider: 'openrouter',
        baseURL: null,
        // No `defaultEffort` sibling: OpenCode's API takes no effort at all.
        defaultModel: 'openrouter/anthropic/claude-opus-4.6',
        defaultTrustStop: null,
      },
      codex: {
        enabled: true,
        binaryPath: '/opt/homebrew/bin/codex',
        credentialRef: 'file:LEAK-6-codex-key-file',
        defaultModel: 'gpt-5.3-codex',
        defaultEffort: 'medium',
        defaultTrustStop: 'ask',
      },
    },
    providers: {
      anthropic: 'file:LEAK-7-anthropic-key-file',
      openrouter: 'env:LEAK-8-OPENROUTER_API_KEY',
    },
    connectors: {
      rawMcpServers: [
        {
          slug: 'notion',
          displayName: 'Notion',
          url: 'https://mcp.notion.example',
          transport: 'http',
        },
      ],
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
      // The one entry here that is not a secret: `ui.sidebar.sections` is a
      // record of objects, a shape `classifySchemaLeaves` cannot name a path
      // inside, so fail-closed applies. See its comment in CONFIG_DISCLOSURE.
      'ui.sidebar.sections',
    ]);
  });

  it('only flags presence for paths that are actually withheld', () => {
    for (const dotPath of PRESENCE_FLAG_PATHS) {
      expect(CONFIG_DISCLOSURE[dotPath as keyof typeof CONFIG_DISCLOSURE]).toBe('withhold');
    }
  });

  it('resolves every exposed leaf to a scalar, an array of scalars, or an allowlisted record', () => {
    // Direction C, and the reason this file exists a second time: membership in
    // the table says a path was classified, not that the verdict covers a value
    // anybody read. A verdict on a subtree covers every field added inside it
    // forever, which is `mcp.apiKey` one level down. Exposing a shape whose
    // contents the schema does not fully name has to be argued, so it fails here.
    const shapes = schemaLeafShapes();
    const offenders = pathsWithVerdict('expose')
      .map((path) => ({ path, shape: shapes.get(path) }))
      .filter(({ path, shape }) => {
        if (shape === 'scalar' || shape === 'scalar-array') return false;
        return !(shape === 'record' && EXPOSED_RECORD_PATHS.includes(path));
      });
    expect(offenders).toEqual([]);
  });

  it('lists every exposed open record explicitly', () => {
    const shapes = schemaLeafShapes();
    // Forward: nothing sits on the allowlist that is not actually an exposed
    // record, so the list cannot rot into a place stale entries hide.
    for (const path of EXPOSED_RECORD_PATHS) {
      expect(CONFIG_DISCLOSURE[path as keyof typeof CONFIG_DISCLOSURE]).toBe('expose');
      expect(shapes.get(path)).toBe('record');
    }
    // Backward: every exposed record is on it.
    const exposedRecords = pathsWithVerdict('expose').filter((p) => shapes.get(p) === 'record');
    expect(exposedRecords.sort()).toEqual([...EXPOSED_RECORD_PATHS].sort());
  });

  it('descends into array elements rather than stopping at the array', () => {
    const paths = configSchemaLeafPaths();
    // The concrete regression: `ui.sidebar.groups` is an array of nine-property
    // objects. Stopping there is what let a field added to a group inherit the
    // array's verdict.
    expect(paths).not.toContain('ui.sidebar.groups');
    expect(paths).toContain('ui.sidebar.groups[].id');
    expect(paths).toContain('ui.sidebar.groups[].rules.pathPrefix');
  });
});

describe('classifySchemaLeaves', () => {
  // Shapes the live config schema does not contain today. The point of the walk
  // is what it does when one of them arrives, so it is exercised directly.
  const scalar = { type: 'string' } as const;
  const secretObject = {
    type: 'object',
    properties: { host: scalar, secretToken: scalar },
    additionalProperties: false,
  } as const;

  it('reads a nullable scalar as one scalar leaf', () => {
    expect(classifySchemaLeaves({ anyOf: [scalar, { type: 'null' }] }, 'tunnel.domain')).toEqual([
      { path: 'tunnel.domain', shape: 'scalar' },
    ]);
  });

  it('sees through a nullable object branch', () => {
    // The reviewer's first synthetic repro: retyping `tunnel.domain` to a
    // nullable object used to hide `secretToken` from the leaf set entirely.
    expect(
      classifySchemaLeaves({ anyOf: [secretObject, { type: 'null' }] }, 'tunnel.domain')
    ).toEqual([
      { path: 'tunnel.domain.host', shape: 'scalar' },
      { path: 'tunnel.domain.secretToken', shape: 'scalar' },
    ]);
  });

  it('sees into every branch of a union', () => {
    // The second repro: a discriminated union used to read as a single leaf.
    const leaves = classifySchemaLeaves(
      {
        anyOf: [
          { type: 'object', properties: { kind: scalar }, additionalProperties: false },
          {
            type: 'object',
            properties: { kind: scalar, secretKey: scalar },
            additionalProperties: false,
          },
        ],
      },
      'auth'
    );
    expect(leaves).toEqual([
      { path: 'auth.kind', shape: 'scalar' },
      { path: 'auth.secretKey', shape: 'scalar' },
    ]);
  });

  it('marks a path whose union branches disagree unsupported', () => {
    expect(
      classifySchemaLeaves(
        { anyOf: [{ type: 'array', items: scalar }, secretObject] },
        'tunnel.domain'
      )
    ).toContainEqual({ path: 'tunnel.domain', shape: 'unsupported' });
  });

  it('descends into array elements and flags arrays of scalars', () => {
    expect(classifySchemaLeaves({ type: 'array', items: scalar }, 'mesh.scanRoots')).toEqual([
      { path: 'mesh.scanRoots', shape: 'scalar-array' },
    ]);
    expect(
      classifySchemaLeaves({ type: 'array', items: secretObject }, 'ui.sidebar.groups')
    ).toEqual([
      { path: 'ui.sidebar.groups[].host', shape: 'scalar' },
      { path: 'ui.sidebar.groups[].secretToken', shape: 'scalar' },
    ]);
  });

  it('accepts a record of scalars and refuses a record of anything else', () => {
    expect(
      classifySchemaLeaves({ type: 'object', additionalProperties: scalar }, 'providers')
    ).toEqual([{ path: 'providers', shape: 'record' }]);
    expect(
      classifySchemaLeaves({ type: 'object', additionalProperties: secretObject }, 'providers')
    ).toEqual([{ path: 'providers', shape: 'unsupported' }]);
    // `z.record(z.string(), z.unknown())` — an untyped value can hold anything.
    expect(classifySchemaLeaves({ type: 'object', additionalProperties: {} }, 'providers')).toEqual(
      [{ path: 'providers', shape: 'unsupported' }]
    );
  });

  it('refuses shapes it cannot reduce instead of waving them through', () => {
    const unsupported = (node: unknown) => classifySchemaLeaves(node, 'x');
    // Named fields plus an open catchall: the catchall's contents have no path.
    expect(
      unsupported({ type: 'object', properties: { a: scalar }, additionalProperties: scalar })
    ).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({ $ref: '#/$defs/Thing' })).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({ allOf: [secretObject] })).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({ type: 'array', prefixItems: [scalar] })).toEqual([
      { path: 'x', shape: 'unsupported' },
    ]);
    expect(unsupported({ type: 'array' })).toEqual([{ path: 'x', shape: 'unsupported' }]);
    expect(unsupported({})).toEqual([{ path: 'x', shape: 'unsupported' }]);
  });

  it('contributes no leaf for an object that can hold nothing', () => {
    expect(classifySchemaLeaves({ type: 'object', additionalProperties: false }, 'x')).toEqual([]);
  });
});

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

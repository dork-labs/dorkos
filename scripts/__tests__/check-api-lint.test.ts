import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BASELINE_PATH,
  compare,
  describe as describeFinding,
  duplicateFindings,
  isBlocking,
  lowered,
  measure,
  raisedAgainst,
  type Counts,
} from '../api-lint/check-api-lint.ts';
import {
  groupOf,
  normalisePath,
  parseCensus,
  type OpenApiDocument,
  type OperationNode,
} from '../api-lint/document.ts';
import {
  COMMAND_WORDS,
  duplicateOperationIds,
  errorMissingItems,
  errorShapeItems,
  isHandRegistryFile,
  listPagingItems,
  operationIdItems,
  paramNameItems,
  registerPathLines,
  RULE_IDS,
  RULES,
  undocumentedRouteItems,
  unservedOperationItems,
  verbPathItems,
} from '../api-lint/rules.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(ROOT, 'scripts', 'api-lint', 'check-api-lint.ts');

/** The repo-wide test reads the whole spec, census and registry; see check-own-mocks. */
const SCAN_TIMEOUT_MS = 30_000;

const ERROR_REF = { $ref: '#/components/schemas/ErrorResponse' };

/** A clean operation: an id, a shared-shape 404 and a plain 200. */
function op(extra: Partial<OperationNode> = {}): OperationNode {
  return {
    operationId: `op-${Math.random()}`,
    responses: {
      '200': { content: { 'application/json': { schema: { type: 'object' } } } },
      '404': { content: { 'application/json': { schema: ERROR_REF } } },
    },
    ...extra,
  };
}

function doc(paths: OpenApiDocument['paths'], schemas = {}): OpenApiDocument {
  return { paths, components: { schemas } };
}

function census(...routes: string[]) {
  return parseCensus(JSON.stringify({ routes }), 'census');
}

function counts(partial: Partial<Counts>): Counts {
  return Object.fromEntries(RULE_IDS.map((rule) => [rule, partial[rule] ?? {}])) as Counts;
}

describe('document helpers', () => {
  it('writes every Hono parameter form as {name}', () => {
    expect(normalisePath('/api/agents/:id')).toBe('/api/agents/{id}');
    expect(normalisePath('/api/relay/endpoints/:subject{.+}/inbox')).toBe(
      '/api/relay/endpoints/{subject}/inbox'
    );
    expect(normalisePath('/api/files/:name?')).toBe('/api/files/{name}');
    expect(normalisePath('/api/agents/')).toBe('/api/agents');
    expect(normalisePath('/')).toBe('/');
  });

  it('groups by the first segment under /api, or the first segment outside it', () => {
    expect(groupOf('/api/sessions/{id}/messages')).toBe('sessions');
    expect(groupOf('/a2a/agents/{id}')).toBe('a2a');
    expect(groupOf('/api')).toBe('api');
  });
});

describe('operation-id', () => {
  it('finds an operation with no id, and passes one that has one', () => {
    const d = doc({ '/api/agents': { get: op({ operationId: '' }), post: op() } });
    expect(operationIdItems(d)).toEqual({ agents: ['GET /api/agents'] });
    expect(operationIdItems(doc({ '/api/agents': { get: op() } }))).toEqual({});
  });

  it('fails a shared id whatever the baseline says', () => {
    const d = doc({
      '/api/agents': { get: op({ operationId: 'listAgents' }) },
      '/api/mesh/agents': { get: op({ operationId: 'listAgents' }) },
    });
    const dupes = duplicateOperationIds(d);
    expect(dupes).toEqual({ listAgents: ['GET /api/agents', 'GET /api/mesh/agents'] });
    const [finding] = duplicateFindings(dupes);
    expect(finding).toMatchObject({ kind: 'duplicate', rule: 'operation-id', unit: 'listAgents' });
    expect(describeFinding(finding!)).toContain('must be unique');
  });

  it('fails ids that match once lowercased with underscores removed, as the generator does', () => {
    const d = doc({
      '/api/x/a': { get: op({ operationId: 'x.foo_bar' }) },
      '/api/x/b': { get: op({ operationId: 'x.fooBar' }) },
    });
    expect(duplicateOperationIds(d)).toEqual({
      'x.foo_bar': ['GET /api/x/a (x.foo_bar)', 'GET /api/x/b (x.fooBar)'],
    });
  });
});

describe('verb-path', () => {
  it('finds a static command word and any -all segment', () => {
    const d = doc({
      '/api/agents/{id}/start': { post: op() },
      '/api/notifications/read-all': { post: op() },
    });
    expect(verbPathItems(d)).toEqual({
      agents: ['/api/agents/{id}/start (start)'],
      notifications: ['/api/notifications/read-all (read-all)'],
    });
  });

  it('never counts a noun, an allowed sub-resource verb, or a parameter', () => {
    const d = doc({
      '/api/agents/{id}/pause': { post: op() },
      '/api/agents/{create}': { get: op() },
      '/api/agents/{id}/messages': { get: op() },
    });
    expect(verbPathItems(d)).toEqual({});
    expect(COMMAND_WORDS).toContain('sign-out-all');
  });

  it('skips only the exact capability invoke path, not the word anywhere', () => {
    const d = doc({
      '/api/capabilities/{id}/invoke': { post: op() },
      '/api/agents/{id}/invoke': { post: op() },
    });
    expect(verbPathItems(d)).toEqual({ agents: ['/api/agents/{id}/invoke (invoke)'] });
  });
});

describe('param-name', () => {
  it('counts each extra name a resource goes by within its group', () => {
    const d = doc({
      '/api/rooms/{id}': { get: op() },
      '/api/rooms/{roomId}/members': { get: op() },
      '/api/rooms/{room}/files': { get: op() },
    });
    expect(paramNameItems(d)).toEqual({
      rooms: ['rooms: {room} beside {id}', 'rooms: {roomId} beside {id}'],
    });
  });

  it('passes one name per resource, and keeps groups apart', () => {
    const d = doc({
      '/api/rooms/{id}': { get: op() },
      '/api/rooms/{id}/members': { get: op() },
      '/api/mesh/rooms/{roomId}': { get: op() },
    });
    expect(paramNameItems(d)).toEqual({});
  });
});

describe('error-missing', () => {
  it('finds an operation with no 4xx or 5xx, and passes one with a 404', () => {
    const bare = op({ responses: { '200': {} } });
    expect(errorMissingItems(doc({ '/api/x': { get: bare } }))).toEqual({ x: ['GET /api/x'] });
    expect(errorMissingItems(doc({ '/api/x': { get: op() } }))).toEqual({});
  });
});

describe('error-shape', () => {
  it('finds an inline error body and an error with no body', () => {
    const inline = { content: { 'application/json': { schema: { type: 'object' } } } };
    const d = doc({ '/api/x': { get: op({ responses: { '400': inline, '500': {} } }) } });
    expect(errorShapeItems(d)).toEqual({ x: ['GET /api/x 400', 'GET /api/x 500'] });
  });

  it('passes a $ref to the shared schema, directly or through components.responses', () => {
    const viaResponse: OpenApiDocument = {
      paths: {
        '/api/x': { get: op({ responses: { '409': { $ref: '#/components/responses/E' } } }) },
      },
      components: { responses: { E: { content: { 'application/json': { schema: ERROR_REF } } } } },
    };
    expect(errorShapeItems(doc({ '/api/x': { get: op() } }))).toEqual({});
    expect(errorShapeItems(viaResponse)).toEqual({});
  });

  it('passes a problem document, plain or with extension members (DOR-4979)', () => {
    const problem = { $ref: '#/components/schemas/Problem' };
    const plain = { content: { 'application/problem+json': { schema: problem } } };
    const extended = {
      content: {
        'application/problem+json': {
          schema: { allOf: [problem, { type: 'object', properties: { conflicts: {} } }] },
        },
      },
    };
    const inline = { content: { 'application/problem+json': { schema: { type: 'object' } } } };
    const d = doc({
      '/api/x': { get: op({ responses: { '409': plain, '412': extended, '500': inline } }) },
    });
    expect(errorShapeItems(d)).toEqual({ x: ['GET /api/x 500'] });
  });
});

describe('list-paging', () => {
  const ok = (schema: object) => ({ '200': { content: { 'application/json': { schema } } } });
  const query = (...names: string[]) => names.map((name) => ({ name, in: 'query' }));

  it('finds an unpaged array, an object holding an array, and a $ref one level down', () => {
    const d = doc(
      {
        '/api/a': { get: op({ responses: ok({ type: 'array' }) }) },
        '/api/b': { get: op({ responses: ok({ properties: { items: { type: 'array' } } }) }) },
        '/api/c': { get: op({ responses: ok({ $ref: '#/components/schemas/List' }) }) },
      },
      { List: { type: 'object', properties: { rows: { type: ['array', 'null'] } } } }
    );
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'], b: ['GET /api/b'], c: ['GET /api/c'] });
  });

  it('passes cursor + limit + nextCursor, and never judges an item GET or a non-list', () => {
    const paged = { properties: { items: { type: 'array' }, nextCursor: { type: 'string' } } };
    const d = doc({
      '/api/a': { get: op({ parameters: query('cursor', 'limit'), responses: ok(paged) }) },
      '/api/a/{id}': { get: op({ responses: ok({ type: 'array' }) }) },
      '/api/b': { get: op({ responses: ok({ type: 'object' }) }) },
    });
    expect(listPagingItems(d)).toEqual({});
  });

  it('looks one level into oneOf, anyOf and allOf for a list body and its nextCursor', () => {
    const items = { properties: { items: { type: 'array' } } };
    const paged = { allOf: [items, { properties: { nextCursor: { type: 'string' } } }] };
    const d = doc({
      '/api/a': { get: op({ responses: ok({ oneOf: [{ type: 'object' }, items] }) }) },
      '/api/b': { get: op({ responses: ok({ anyOf: [{ $ref: '#/components/schemas/L' }] }) }) },
      '/api/c': { get: op({ parameters: query('cursor', 'limit'), responses: ok(paged) }) },
    });
    d.components = { schemas: { L: { type: 'array' } } };
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'], b: ['GET /api/b'] });
  });

  it('fails a list that takes cursor and limit but returns no nextCursor', () => {
    const d = doc({
      '/api/a': {
        get: op({ parameters: query('cursor', 'limit'), responses: ok({ type: 'array' }) }),
      },
    });
    expect(listPagingItems(d)).toEqual({ a: ['GET /api/a'] });
  });
});

describe('undocumented-route and unserved-operation', () => {
  it('matches :id against {agentId}, so a naming mismatch is not a coverage gap', () => {
    const d = doc({ '/api/agents/{agentId}/pause': { post: op() } });
    const c = census('POST /api/agents/:id/pause');
    expect(undocumentedRouteItems(d, c)).toEqual({});
    expect(unservedOperationItems(d, c)).toEqual({});
  });

  it('finds a served route missing from the document, and a documented one nobody serves', () => {
    const d = doc({ '/api/agents': { get: op() } });
    const c = census('POST /api/agents');
    expect(undocumentedRouteItems(d, c)).toEqual({ agents: ['POST /api/agents'] });
    expect(unservedOperationItems(d, c)).toEqual({ agents: ['GET /api/agents'] });
  });

  it('ignores middleware, wildcards, test routes, the extension router and non-/api routes', () => {
    const c = census(
      'ALL /api/admin/*',
      'ALL /api/tasks',
      'GET /api/docs/*',
      'GET /api/test/route-census',
      'GET /api/ext/:id/settings',
      'POST /mcp'
    );
    expect(undocumentedRouteItems(doc({}), c)).toEqual({});
  });

  it('matches a census path with a trailing slash', () => {
    const d = doc({ '/api/agents': { get: op() } });
    expect(undocumentedRouteItems(d, census('GET /api/agents/'))).toEqual({});
  });

  it('counts ALL on the same path, and a wildcard over the prefix, as serving', () => {
    const d = doc({
      '/api/extensions/media/{ticket}': { get: op() },
      '/api/auth/api-key/create': { post: op() },
      '/api/auth': { get: op() },
    });
    const c = census('ALL /api/extensions/media/:ticket', 'ALL /api/auth/*', 'GET /api/auth');
    expect(unservedOperationItems(d, c)).toEqual({});
  });

  it('does not let a wildcard of another method serve, or a prefix match a longer name', () => {
    const d = doc({ '/api/docs/x': { post: op() }, '/api/authors': { get: op() } });
    const c = census('GET /api/docs/*', 'ALL /api/auth/*');
    expect(unservedOperationItems(d, c)).toEqual({
      docs: ['POST /api/docs/x'],
      authors: ['GET /api/authors'],
    });
  });

  it('never judges a documented /api/test or /api/ext/{id} operation as unserved', () => {
    const d = doc({ '/api/test/reset': { post: op() }, '/api/ext/{id}/settings': { get: op() } });
    expect(unservedOperationItems(d, census())).toEqual({});
  });
});

describe('hand-registered-path', () => {
  it('matches the hand registry files and nothing else', () => {
    expect(isHandRegistryFile('apps/server/src/services/core/openapi-registry.ts')).toBe(true);
    expect(isHandRegistryFile('apps/server/src/services/core/openapi/domains.ts')).toBe(true);
    expect(isHandRegistryFile('apps/server/src/services/todos/todos-openapi.ts')).toBe(true);
    expect(isHandRegistryFile('apps/server/src/services/connectors/events/openapi.ts')).toBe(true);
    expect(
      isHandRegistryFile('apps/server/src/services/core/capabilities/openapi-projection.ts')
    ).toBe(false);
    expect(isHandRegistryFile('apps/server/src/services/todos/__tests__/todos-openapi.ts')).toBe(
      false
    );
  });

  it('counts each call, two on one line, and skips comment lines', () => {
    const call = 'registry.' + 'registerPath(';
    const text = [`${call}{});`, `// ${call}`, ` * ${call}`, `${call}a); ${call}b);`].join('\n');
    expect(registerPathLines(text)).toEqual([1, 4, 4]);
  });
});

describe('measure', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'api-lint-'));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  it('reads --spec and --census from the paths it is given', { timeout: SCAN_TIMEOUT_MS }, () => {
    const spec = join(scratch, 'openapi.json');
    const routes = join(scratch, 'census.json');
    writeFileSync(spec, JSON.stringify(doc({ '/api/agents': { get: op({ operationId: '' }) } })));
    writeFileSync(routes, JSON.stringify({ routes: ['GET /api/agents', 'POST /api/agents'] }));
    const m = measure(ROOT, { spec, census: routes });
    expect(m.counts['operation-id']).toEqual({ agents: 1 });
    expect(m.counts['undocumented-route']).toEqual({ agents: 1 });
  });

  it('cannot measure an input it cannot read', () => {
    expect(() => measure(ROOT, { spec: join(scratch, 'missing.json') })).toThrow(/cannot read/);
  });
});

describe('the ratchet', () => {
  it('reports growth, a new unit, and a drop the baseline has not locked in', () => {
    const findings = compare(
      counts({ 'verb-path': { agents: 3, mesh: 1 }, 'list-paging': { rooms: 1 } }),
      { 'verb-path': { agents: 2 }, 'list-paging': { rooms: 2, relay: 4 } }
    );
    expect(findings).toEqual([
      { kind: 'grew', rule: 'verb-path', unit: 'agents', count: 3, baseline: 2 },
      { kind: 'new', rule: 'verb-path', unit: 'mesh', count: 1 },
      { kind: 'stale', rule: 'list-paging', unit: 'rooms', count: 1, baseline: 2 },
      { kind: 'stale', rule: 'list-paging', unit: 'relay', baseline: 4 },
    ]);
  });

  it('refuses a raised or added entry, and skips a rule the base never had', () => {
    expect(
      raisedAgainst(
        { 'verb-path': { agents: 3, mesh: 1 }, 'list-paging': { rooms: 9 } },
        { 'verb-path': { agents: 2 } }
      )
    ).toEqual([
      { kind: 'raised', rule: 'verb-path', unit: 'agents', count: 3, baseline: 2 },
      { kind: 'raised', rule: 'verb-path', unit: 'mesh', count: 1 },
    ]);
    expect(raisedAgainst({ 'verb-path': { agents: 1 } }, { 'verb-path': { agents: 2 } })).toEqual(
      []
    );
  });

  it('lowers entries, drops units at zero, and never raises or adds', () => {
    const next = lowered(counts({ 'verb-path': { agents: 1, mesh: 5, rooms: 2 } }), {
      'verb-path': { agents: 2, mesh: 3, gone: 1 },
    });
    expect(next['verb-path']).toEqual({ agents: 1, mesh: 3 });
    expect(next['list-paging']).toEqual({});
  });

  it('sets an advisory rule to its measured counts, up, down, added and removed', () => {
    const next = lowered(
      counts({ 'hand-registered-path': { 'a.ts': 7, 'b.ts': 1, 'new.ts': 2 } }),
      {
        'hand-registered-path': { 'a.ts': 6, 'b.ts': 3, 'gone.ts': 4 },
      }
    );
    expect(next['hand-registered-path']).toEqual({ 'a.ts': 7, 'b.ts': 1, 'new.ts': 2 });
  });

  it('never judges a raised advisory entry against the base', () => {
    expect(
      raisedAgainst(
        { 'hand-registered-path': { 'a.ts': 9, 'new.ts': 1 } },
        { 'hand-registered-path': { 'a.ts': 2 } }
      )
    ).toEqual([]);
  });

  it('lets a stale entry pass in the merge queue, and only there', () => {
    const stale = { kind: 'stale' as const, rule: 'verb-path' as const, unit: 'agents' };
    expect(isBlocking(stale)).toBe(true);
    expect(isBlocking(stale, true)).toBe(false);
    expect(isBlocking({ kind: 'grew', rule: 'verb-path', unit: 'agents' }, true)).toBe(true);
  });

  it('fails on a blocking rule or a shared id, never on an advisory rule', () => {
    expect(isBlocking({ kind: 'grew', rule: 'verb-path', unit: 'agents' })).toBe(true);
    expect(isBlocking({ kind: 'duplicate', rule: 'operation-id', unit: 'x' })).toBe(true);
    expect(RULES['hand-registered-path'].blocking).toBe(false);
    expect(isBlocking({ kind: 'grew', rule: 'hand-registered-path', unit: 'a.ts' })).toBe(false);
    expect(isBlocking({ kind: 'raised', rule: 'hand-registered-path', unit: 'a.ts' })).toBe(false);
  });

  it('names the rule, the unit, the counts and the fix', () => {
    const line = describeFinding({
      kind: 'grew',
      rule: 'list-paging',
      unit: 'rooms',
      count: 3,
      baseline: 2,
    });
    expect(line).toBe(
      'list-paging in rooms: 3 (baseline 2). Page the list: accept cursor and limit, and return nextCursor.'
    );
  });
});

describe('the command line', () => {
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [CLI, '--root', ROOT, ...args], { encoding: 'utf8' });

  it('cannot run with --base and no value, or an empty one', { timeout: SCAN_TIMEOUT_MS }, () => {
    expect(run('--base').status).toBe(2);
    expect(run('--base', '').status).toBe(2);
    expect(run('--base', '--update').status).toBe(2);
  });

  it('cannot run against a base git does not have', { timeout: SCAN_TIMEOUT_MS }, () => {
    const result = run('--base', 'no-such-ref-api-lint');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('is not a commit');
  });
});

describe('the command line on a scratch repo', () => {
  const repo = mkdtempSync(join(tmpdir(), 'api-lint-cli-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout.trim();
  const spec = join(repo, 'openapi.json');
  const routes = join(repo, 'census.json');
  const baselineFile = join(repo, BASELINE_PATH);
  /** Two documented GETs whose paths end in a command word: verb-path agents 2. */
  const twoVerbs = {
    '/api/agents/sync': { get: op() },
    '/api/agents/refresh': { get: op() },
  };
  const writeInputs = (paths: OpenApiDocument['paths']) => {
    writeFileSync(spec, JSON.stringify(doc(paths)));
    const served = Object.keys(paths).map((p) => `GET ${p}`);
    writeFileSync(routes, JSON.stringify({ routes: served }));
  };
  const writeBaselineRules = (rules: Partial<Counts>) =>
    writeFileSync(baselineFile, JSON.stringify({ $comment: 'test', rules }));
  const readRules = () =>
    (JSON.parse(readFileSync(baselineFile, 'utf8')) as { rules: Partial<Counts> }).rules;
  const run = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [CLI, '--root', repo, '--spec', spec, '--census', routes, ...args],
      {
        encoding: 'utf8',
      }
    );

  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  mkdirSync(dirname(baselineFile), { recursive: true });
  writeInputs(twoVerbs);
  writeBaselineRules({ 'verb-path': { agents: 2 } });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');

  it('passes at the baseline', () => {
    writeInputs(twoVerbs);
    writeBaselineRules({ 'verb-path': { agents: 2 } });
    expect(run('--base', base).status).toBe(0);
  });

  it('exits 1 when a count grew', () => {
    writeInputs({ ...twoVerbs, '/api/agents/reset': { get: op() } });
    writeBaselineRules({ 'verb-path': { agents: 2 } });
    const result = run('--base', base);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('verb-path in agents: 3 (baseline 2)');
  });

  it('exits 1 when the baseline was raised by hand against --base', () => {
    writeInputs({ ...twoVerbs, '/api/agents/reset': { get: op() } });
    writeBaselineRules({ 'verb-path': { agents: 3 } });
    const result = run('--base', base);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('baseline raised from 2 to 3');
  });

  it('exits 0 with only advisory notes', () => {
    writeInputs(twoVerbs);
    writeBaselineRules({ 'verb-path': { agents: 2 } });
    mkdirSync(join(repo, 'apps/server/src'), { recursive: true });
    writeFileSync(join(repo, 'apps/server/src/x-openapi.ts'), 'registry.registerPath({});\n');
    try {
      const result = run('--base', base);
      expect(result.status).toBe(0);
      expect(result.stderr).toContain(
        'advisory: hand-registered-path in apps/server/src/x-openapi.ts'
      );
    } finally {
      rmSync(join(repo, 'apps'), { recursive: true, force: true });
    }
  });

  it('lowers the baseline with --update, then passes', () => {
    writeInputs({ '/api/agents/sync': { get: op() } });
    writeBaselineRules({ 'verb-path': { agents: 2 } });
    expect(run('--base', base).status).toBe(1);
    expect(run('--update').status).toBe(0);
    expect(readRules()['verb-path']).toEqual({ agents: 1 });
    expect(run('--base', base).status).toBe(0);
  });

  it('fails a stale entry on a PR, and only prints it with --queue', () => {
    writeInputs({ '/api/agents/sync': { get: op() } });
    writeBaselineRules({ 'verb-path': { agents: 2 } });
    expect(run('--base', base).status).toBe(1);
    const queued = run('--base', base, '--queue');
    expect(queued.status).toBe(0);
    expect(queued.stderr).toContain('advisory: verb-path in agents: down to 1 (baseline 2)');
  });
});

// The gate in the queue is the workflow step in typecheck.yml (it also takes
// --base); this test runs in the repo-wide scripts suite beside it.
describe('the repo', () => {
  it(
    'adds no blocking API lint finding beyond the baseline, and has locked in every drop',
    { timeout: SCAN_TIMEOUT_MS },
    () => {
      const baseline = (
        JSON.parse(readFileSync(join(ROOT, BASELINE_PATH), 'utf8')) as { rules: Partial<Counts> }
      ).rules;
      const m = measure(ROOT);
      // A run that read nothing would compare clean against nothing; prove it read the repo.
      expect(m.scanned.operations).toBeGreaterThan(400);
      expect(m.scanned.registryFiles).toBeGreaterThan(30);
      expect(duplicateFindings(m.duplicates)).toEqual([]);
      expect(
        compare(m.counts, baseline).filter((f) => isBlocking(f)),
        'Fix the new finding, or after fixing some run `pnpm check:api-lint -- --update`.'
      ).toEqual([]);
    }
  );
});

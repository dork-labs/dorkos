import { describe, it, expect } from 'vitest';
import { assignOperationIds, deriveOperationId, isCollectionPath } from '../operation-ids.js';

describe('deriveOperationId', () => {
  it.each([
    // A command word at the end is the verb, and leaves the Resource.
    ['post', '/api/agents/{id}/pause', false, 'agents.pause'],
    ['post', '/api/local-browser/handoff/stop', false, 'localBrowser.stopHandoff'],
    ['post', '/api/devices/sign-out-all', false, 'devices.signOutAll'],
    ['post', '/api/tunnel/start', false, 'tunnel.start'],
    ['post', '/api/local-browser/sign-in', false, 'localBrowser.signIn'],
    ['post', '/api/workbench/sign', false, 'workbench.sign'],
    // A hyphenated last segment led by a command word is the verb too...
    ['post', '/api/auth/revoke-session', false, 'auth.revokeSession'],
    ['post', '/api/extensions/{id}/start-work', false, 'extensions.startWork'],
    [
      'post',
      '/api/marketplace/packages/{name}/check-files',
      false,
      'marketplace.checkFilesPackages',
    ],
    // ...unless it is a named thing, or the method is GET (a GET reads what it names).
    ['post', '/api/hub/computers/link-code', false, 'hub.createComputersLinkCode'],
    ['get', '/api/runs/run-history', false, 'runs.getRunHistory'],
    // GET: a collection path is `list`, anything else `get` (paging: see below).
    ['get', '/api/sessions', true, 'sessions.list'],
    ['get', '/api/sessions/{id}', true, 'sessions.get'],
    ['get', '/api/sessions/{id}/messages', false, 'sessions.getMessages'],
    ['get', '/api/sessions/{id}/messages/{messageId}', false, 'sessions.getMessages'],
    ['get', '/api/health/deep', false, 'health.getDeep'],
    ['get', '/api/health', false, 'health.get'],
    ['get', '/api/cloud/status', false, 'cloud.getStatus'],
    ['get', '/api/sessions/{id}/settings', false, 'sessions.getSettings'],
    ['GET', '/.well-known/agent-card.json', false, 'wellKnown.getAgentCardJson'],
    // POST creates; the Resource keeps path order.
    ['post', '/api/sessions', false, 'sessions.create'],
    ['post', '/api/sessions/{id}/messages', false, 'sessions.createMessages'],
    ['post', '/api/rooms/{id}/members', false, 'rooms.createMembers'],
    [
      'post',
      '/api/connectors/connections/{connectionId}/events/subscriptions',
      false,
      'connectors.createConnectionsEventsSubscriptions',
    ],
    ['post', '/mcp', false, 'mcp.create'],
    // PUT and PATCH update; DELETE deletes.
    ['patch', '/api/config', false, 'config.update'],
    [
      'put',
      '/api/runtimes/claude-code/accounts/{id}/no-auto-move',
      false,
      'runtimes.updateClaudeCodeAccountsNoAutoMove',
    ],
    ['delete', '/api/work-queues/{id}/items/{itemId}', false, 'workQueues.deleteItems'],
  ] as const)('%s %s (collection: %s) → %s', (method, path, isCollection, id) => {
    expect(deriveOperationId(method, path, { isCollection })).toBe(id);
  });
});

describe('isCollectionPath', () => {
  const paths = new Set(['/api/sessions', '/api/sessions/{id}', '/api/a', '/api/a/{id}/x']);
  it.each([
    ['/api/sessions', true],
    ['/api/sessions/', true],
    ['/api/sessions/{id}', false],
    // An item deeper down is not an item of this path.
    ['/api/a', false],
    ['/api/none', false],
  ])('%s → %s', (path, expected) => {
    expect(isCollectionPath(path, paths)).toBe(expected);
  });
});

/** A document of bare operations, keyed `path → method → operation`. */
function document(paths: Record<string, Record<string, object>>) {
  return { paths } as {
    paths: Record<string, Record<string, { operationId?: string }>>;
  };
}

/** An operation whose `200` JSON body is `schema`. */
function answering(schema: object) {
  return { responses: { 200: { content: { 'application/json': { schema } } } } };
}

describe('assignOperationIds', () => {
  it('fills in a derived id on every operation that has none', () => {
    const doc = document({
      '/api/sessions': { get: {}, post: {} },
      '/api/sessions/{id}': { get: {}, delete: {} },
    });
    assignOperationIds(doc);
    expect(doc.paths['/api/sessions']?.get?.operationId).toBe('sessions.list');
    expect(doc.paths['/api/sessions']?.post?.operationId).toBe('sessions.create');
    expect(doc.paths['/api/sessions/{id}']?.get?.operationId).toBe('sessions.get');
    expect(doc.paths['/api/sessions/{id}']?.delete?.operationId).toBe('sessions.delete');
  });

  it('names a GET by the paths alone, never by its response body', () => {
    const doc = document({
      '/api/a': { get: answering({ type: 'array' }) },
      '/api/b': { get: answering({ type: 'object', properties: { items: { type: 'array' } } }) },
      '/api/b/{id}': { get: {} },
    });
    assignOperationIds(doc);
    expect(doc.paths['/api/a']?.get?.operationId).toBe('a.get');
    expect(doc.paths['/api/b']?.get?.operationId).toBe('b.list');
  });

  it('names a GET that pages (a limit or cursor query parameter) list', () => {
    const query = (name: string) => ({ parameters: [{ in: 'query', name }] });
    const doc = document({
      '/api/rooms/{id}/entries': { get: query('cursor') },
      '/api/usage': { get: query('limit') },
      '/api/one': { get: query('fields') },
      '/api/two/{x}': { get: { parameters: [{ in: 'path', name: 'cursor' }] } },
    });
    assignOperationIds(doc);
    expect(doc.paths['/api/rooms/{id}/entries']?.get?.operationId).toBe('rooms.listEntries');
    expect(doc.paths['/api/usage']?.get?.operationId).toBe('usage.list');
    expect(doc.paths['/api/one']?.get?.operationId).toBe('one.get');
    expect(doc.paths['/api/two/{x}']?.get?.operationId).toBe('two.get');
  });

  it('keeps an id set by hand', () => {
    const doc = document({ '/api/audit/{id}': { get: { operationId: 'audit.get_entry' } } });
    assignOperationIds(doc);
    expect(doc.paths['/api/audit/{id}']?.get?.operationId).toBe('audit.get_entry');
  });

  it('throws, naming both, when two derived ids collide', () => {
    const doc = document({
      '/api/marketplace/sources/{name}/refresh': { post: {} },
      '/api/marketplace/sources/refresh': { post: {} },
    });
    expect(() => assignOperationIds(doc)).toThrow(
      /"marketplace\.refreshSources".*POST \/api\/marketplace\/sources\/\{name\}\/refresh.*POST \/api\/marketplace\/sources\/refresh/
    );
  });

  it('throws when a derived id collides with a hand-set one, even when the hand-set one comes later', () => {
    const doc = document({
      '/api/sessions': { get: {} },
      '/api/sessions/{id}': { get: {} },
      '/api/other': { get: { operationId: 'sessions.list' } },
    });
    expect(() => assignOperationIds(doc)).toThrow(/GET \/api\/other .* and GET \/api\/sessions/);
  });

  it('throws when two ids differ only by case or underscores', () => {
    const doc = document({
      '/api/a': { get: { operationId: 'audit.running_chats' } },
      '/api/b': { get: { operationId: 'audit.runningChats' } },
    });
    expect(() => assignOperationIds(doc)).toThrow(/"audit\.running_chats".*"audit\.runningChats"/);
  });

  it('throws when two hand-set ids collide', () => {
    const doc = document({
      '/api/a': { get: { operationId: 'same' } },
      '/api/b': { get: { operationId: 'same' } },
    });
    expect(() => assignOperationIds(doc)).toThrow(/"same"/);
  });

  it('leaves path-level fields that are not operations alone', () => {
    const doc = { paths: { '/api/x': { parameters: [], summary: 'shared', get: {} } } };
    assignOperationIds(doc);
    expect(doc.paths['/api/x']).toEqual({
      parameters: [],
      summary: 'shared',
      get: { operationId: 'x.get' },
    });
  });
});

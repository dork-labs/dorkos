import { describe, it, expect } from 'vitest';
import { assignOperationIds, deriveOperationId } from '../operation-ids.js';

describe('deriveOperationId', () => {
  it.each([
    // A command word at the end is the verb, and leaves the Resource.
    ['post', '/api/agents/{id}/pause', false, 'agents.pause'],
    ['post', '/api/sessions/{id}/continue/cancel', false, 'sessions.cancelContinue'],
    ['post', '/api/notifications/read-all', false, 'notifications.readAll'],
    ['put', '/api/work-queues/stop', false, 'workQueues.stop'],
    ['post', '/api/local-browser/sign-in', false, 'localBrowser.signIn'],
    // GET: an item path is `get`; otherwise the response decides.
    ['get', '/api/sessions', true, 'sessions.list'],
    ['get', '/api/sessions/{id}', true, 'sessions.get'],
    ['get', '/api/sessions/{id}/messages', true, 'sessions.listMessages'],
    ['get', '/api/sessions/{id}/messages/{messageId}', false, 'sessions.getMessages'],
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
  ] as const)('%s %s (list body: %s) → %s', (method, path, returnsList, id) => {
    expect(deriveOperationId(method, path, { returnsList })).toBe(id);
  });
});

/** A document of bare operations, keyed `path → method → operation`. */
function document(paths: Record<string, Record<string, object>>, schemas = {}) {
  return { paths, components: { schemas } } as {
    paths: Record<string, Record<string, { operationId?: string }>>;
    components: { schemas: Record<string, unknown> };
  };
}

/** An operation whose `200` JSON body is `schema`. */
function answering(schema: object) {
  return { responses: { 200: { content: { 'application/json': { schema } } } } };
}

describe('assignOperationIds', () => {
  it('fills in a derived id on every operation that has none', () => {
    const doc = document({
      '/api/sessions': { get: answering({ type: 'array' }), post: {} },
      '/api/sessions/{id}': { get: {}, delete: {} },
    });
    assignOperationIds(doc);
    expect(doc.paths['/api/sessions']?.get?.operationId).toBe('sessions.list');
    expect(doc.paths['/api/sessions']?.post?.operationId).toBe('sessions.create');
    expect(doc.paths['/api/sessions/{id}']?.get?.operationId).toBe('sessions.get');
    expect(doc.paths['/api/sessions/{id}']?.delete?.operationId).toBe('sessions.delete');
  });

  it('reads list or get from the 200 body, one $ref deep', () => {
    const doc = document(
      {
        '/api/a': { get: answering({ $ref: '#/components/schemas/Page' }) },
        '/api/b': { get: answering({ $ref: '#/components/schemas/One' }) },
        '/api/c': { get: answering({ type: ['array', 'null'] }) },
        '/api/d': { get: {} },
      },
      {
        Page: { type: 'object', properties: { items: { type: 'array' } } },
        One: { type: 'object', properties: { name: { type: 'string' } } },
      }
    );
    assignOperationIds(doc);
    expect(doc.paths['/api/a']?.get?.operationId).toBe('a.list');
    expect(doc.paths['/api/b']?.get?.operationId).toBe('b.get');
    expect(doc.paths['/api/c']?.get?.operationId).toBe('c.list');
    expect(doc.paths['/api/d']?.get?.operationId).toBe('d.get');
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
      '/api/sessions': { get: answering({ type: 'array' }) },
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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createBrowserOwnerScopeResolver } from '../owner-scope.js';

const state = vi.hoisted(() => ({
  login: true,
  ownerId: 'account-owner' as string | null,
  authorId: 'stable-operator-author',
  onAuthor: undefined as (() => void) | undefined,
  failConfig: false,
  authorCalls: 0,
  authorOverride: undefined as unknown,
  overrideAuthor: false,
}));
vi.mock('../../config-manager.js', () => ({
  configManager: {
    get: () => {
      if (state.failConfig) throw new Error('unreadable config');
      return { enabled: state.login };
    },
  },
}));
vi.mock('../../auth/index.js', () => ({
  readOwnerAccount: () => (state.ownerId === null ? null : { id: state.ownerId }),
}));
vi.mock('../../capabilities/index.js', () => ({ APPROVAL_TOKEN_HEADER: 'x-dorkos-approval' }));
vi.mock('../../agent-identity/agent-identity-service.js', () => ({
  agentTokenDigestPrefix: () => 'test-digest',
  getAgentIdentityService: () => undefined,
}));
vi.mock('../../../../env.js', () => ({ env: { DORKOS_ALLOW_INSECURE_BIND: false } }));
vi.mock('../../tunnel-manager.js', () => ({ tunnelManager: { status: { url: null } } }));
vi.mock('../../../rooms/index.js', () => ({
  getRoomService: () => ({
    authorRegistry: {
      bindOwner: (id: string) => {
        state.authorCalls++;
        state.onAuthor?.();
        return state.overrideAuthor
          ? state.authorOverride
          : { id: state.authorId, kind: 'human', naturalKey: `user:${id}` };
      },
      localHuman: () => {
        state.authorCalls++;
        state.onAuthor?.();
        return state.overrideAuthor
          ? state.authorOverride
          : { id: state.authorId, kind: 'human', naturalKey: 'local' };
      },
    },
  }),
}));

function request(headers: Request['headers'] = {}, peer = '127.0.0.1'): Request {
  return {
    headers: { host: 'localhost:4242', ...headers },
    socket: { remoteAddress: peer },
  } as Request;
}
function response(
  credential: 'cookie' | 'api-key' | null = 'cookie',
  userId = 'account-owner'
): Response {
  return { locals: credential ? { user: { userId, credential } } : {} } as Response;
}
function resolveNamespace(req = request(), res = response()) {
  const resolver = createBrowserOwnerScopeResolver();
  return resolver.consume(resolver.resolve(req, res));
}

beforeEach(() => {
  state.login = true;
  state.ownerId = 'account-owner';
  state.authorId = 'stable-operator-author';
  state.onAuthor = undefined;
  state.failConfig = false;
  state.authorCalls = 0;
  state.authorOverride = undefined;
  state.overrideAuthor = false;
});

describe('server browser metadata owner scopes', () => {
  it('requires the owner cookie rather than any authenticated account or API key', () => {
    expect(resolveNamespace(request(), response('cookie', 'other-account'))).toBeNull();
    expect(resolveNamespace(request(), response('api-key'))).toBeNull();
    expect(resolveNamespace(request(), response(null))).toBeNull();
    expect(state.authorCalls).toBe(0);
    expect(resolveNamespace()).toEqual({ ownerAuthorId: state.authorId, posture: 'signedInOwner' });
  });

  it.each([true, false])('refuses agent/approval presentation with login=%s', (login) => {
    state.login = login;
    for (const headers of [
      { 'x-dorkos-agent': '' },
      { 'x-dorkos-agent': 'revoked-or-unknown' },
      { 'x-dorkos-approval': '' },
    ])
      expect(resolveNamespace(request(headers))).toBeNull();
    const res = response();
    res.locals.agentIdentity = { inactive: 'revoked' };
    expect(resolveNamespace(request(), res)).toBeNull();
    res.locals.agentIdentity = { agentPath: '/known/live-agent' };
    expect(resolveNamespace(request(), res)).toBeNull();
    expect(state.authorCalls).toBe(0);
    expect(resolveNamespace()).not.toBeNull();
  });

  it('never uses a request-body owner or actor as verified identity', () => {
    const req = request();
    req.body = { ownerAuthorId: state.authorId, userId: 'account-owner', actor: 'operator' };
    expect(resolveNamespace(req, response(null))).toBeNull();
    req.body = { ownerAuthorId: 'forged-owner', actor: 'another-actor' };
    expect(resolveNamespace(req)).toEqual({
      ownerAuthorId: state.authorId,
      posture: 'signedInOwner',
    });
  });

  it('refuses login-on without an install owner, allowing the distinct local-off posture', () => {
    state.ownerId = null;
    expect(resolveNamespace()).toBeNull();
    state.login = false;
    expect(resolveNamespace(request(), response(null))).toEqual({
      ownerAuthorId: state.authorId,
      posture: 'localOperator',
    });
  });

  it('requires both actual peer and host under local-off, without forwarded-header adoption', () => {
    state.login = false;
    for (const req of [
      request({}, '192.168.1.10'),
      request({ host: 'evil.example' }),
      request({ host: 'evil.example', 'x-forwarded-host': 'localhost' }),
      request({ 'x-forwarded-for': '127.0.0.1' }, '192.168.1.10'),
    ])
      expect(resolveNamespace(req, response(null))).toBeNull();
    expect(state.authorCalls).toBe(0);
    expect(resolveNamespace(request(), response(null))).not.toBeNull();
  });

  it('keeps the existing author namespace when operator resolution delegates to owner binding', () => {
    state.login = false;
    state.ownerId = null;
    const local = resolveNamespace(request(), response(null));
    state.ownerId = 'account-owner';
    state.login = true;
    const signedIn = resolveNamespace();
    expect(local?.ownerAuthorId).toBe(signedIn?.ownerAuthorId);
    expect(local?.posture).toBe('localOperator');
    expect(signedIn?.posture).toBe('signedInOwner');
    // Stable ID is supplied by the actual registry port; this is delegation,
    // not a substitute for its separately tested real transactional rebind.
  });

  it('rejects scope copies, serialization, foreign resolvers and replay', () => {
    const a = createBrowserOwnerScopeResolver(),
      b = createBrowserOwnerScopeResolver();
    const scope = a.resolve(request(), response());
    expect(scope).not.toBeNull();
    expect(a.consume({ ...scope })).toBeNull();
    expect(a.consume(JSON.parse(JSON.stringify(scope)))).toBeNull();
    expect(b.consume(scope)).toBeNull();
    expect(a.consume(scope)).toEqual({ ownerAuthorId: state.authorId, posture: 'signedInOwner' });
    expect(a.consume(scope)).toBeNull();
  });

  it('retirement invalidates outstanding scopes and blocks new resolution', () => {
    const resolver = createBrowserOwnerScopeResolver();
    const scope = resolver.resolve(request(), response());
    expect(scope).not.toBeNull();
    resolver.retire();
    expect(resolver.consume(scope)).toBeNull();
    expect(resolver.resolve(request(), response())).toBeNull();
  });

  it('withholds scope when author resolution changes login, owner, or retires the resolver', () => {
    const resolver = createBrowserOwnerScopeResolver();
    state.onAuthor = () => {
      state.login = false;
    };
    expect(resolver.resolve(request(), response())).toBeNull();
    state.login = true;
    state.onAuthor = () => {
      state.ownerId = 'replacement-owner';
    };
    expect(resolver.resolve(request(), response())).toBeNull();
    state.ownerId = 'account-owner';
    state.onAuthor = () => resolver.retire();
    expect(resolver.resolve(request(), response())).toBeNull();
    state.onAuthor = undefined;
    expect(resolveNamespace()).not.toBeNull();
  });

  it('fails closed on unreadable configuration and author storage errors', () => {
    state.failConfig = true;
    expect(resolveNamespace()).toBeNull();
    state.failConfig = false;
    state.onAuthor = () => {
      throw new Error('author write refused');
    };
    expect(resolveNamespace()).toBeNull();
    state.onAuthor = undefined;
    expect(resolveNamespace()).not.toBeNull();
  });

  it('refuses malformed returned author correspondence, with a healthy resolved peer', () => {
    state.overrideAuthor = true;
    for (const author of [
      { id: state.authorId, kind: 'agent', naturalKey: 'user:account-owner' },
      { id: state.authorId, kind: 'human', naturalKey: 'user:other-account' },
      { id: '', kind: 'human', naturalKey: 'user:account-owner' },
    ]) {
      state.authorOverride = author;
      const callsBefore = state.authorCalls;
      expect(resolveNamespace()).toBeNull();
      expect(state.authorCalls).toBe(callsBefore + 1);
    }
    state.overrideAuthor = false;
    const callsBefore = state.authorCalls;
    expect(resolveNamespace()).toEqual({
      ownerAuthorId: state.authorId,
      posture: 'signedInOwner',
    });
    expect(state.authorCalls).toBe(callsBefore + 1);
  });
});

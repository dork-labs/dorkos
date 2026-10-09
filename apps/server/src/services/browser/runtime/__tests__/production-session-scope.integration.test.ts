import { fixture } from '../../api/__tests__/input-routes.fixture.js';
import { expect, it, onTestFinished, vi } from 'vitest';
import { eq, and, roomMembers, user, workspaces } from '@dorkos/db';
import type { BrowserAttachment } from '@dorkos/shared/browser-schemas';
import { configManager } from '../../../core/config-manager.js';
import { ConnectorRuntimePrincipalService } from '../../../connectors/principal/runtime-principal-service.js';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { BrowserRegistryStore } from '../../registry/store.js';
import { captureRuntimeBrowserBirth, type RuntimeBrowserBirth } from '../runtime-birth.js';
import { createProductionBrowserSession } from '../production-session.js';

const originals = vi.hoisted(() => ({
  mode: vi.fn(),
  network: vi.fn(),
  scope: undefined as undefined | ((actor: string, target: BrowserAttachment) => boolean),
  observe: false,
}));
vi.mock('../startup-mode.js', () => ({
  captureProductionBrowserMode: originals.mode,
}));
vi.mock('../../egress/broker/live/production-composition.js', () => ({
  createProductionLiveBrowserComposition: originals.network,
}));
vi.mock('../../api/grants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/grants.js')>();
  return {
    ...actual,
    OwnedBrowserGrants: class extends actual.OwnedBrowserGrants {
      constructor(...args: ConstructorParameters<typeof actual.OwnedBrowserGrants>) {
        super(...args);
        if (originals.observe) originals.scope = args[1];
      }
    },
  };
});

// The production session consumes the actual combined scope constructor receiver.
// SQL, BetterAuth, authors, grants and runtime principals are original services;
// the network acquisition is deliberately held before any native producer.
async function scopeFixture(runtime: boolean) {
  const bank: {
    starting?: Promise<Awaited<ReturnType<typeof fixture>>>;
    owner?: ReturnType<typeof createProductionBrowserSession>;
    opening?: Promise<unknown>;
    preparing?: Promise<unknown>;
    finishing?: Promise<void>;
    closed: boolean;
    release?: () => void;
  } = { closed: false };
  const expected = new Error('ORIGINAL_SCOPE_CONTROL_NETWORK_RETURN');
  const finish = () => {
    bank.closed = true;
    if (bank.finishing) return bank.finishing;
    bank.finishing = Promise.resolve().then(async () => {
      let first: { value: unknown } | undefined;
      try {
        bank.release?.();
      } catch (value) {
        first ??= { value };
      }
      const closing = Promise.resolve().then(async () => {
        await Promise.allSettled([
          ...(bank.starting ? [bank.starting] : []),
          ...(bank.preparing ? [bank.preparing] : []),
        ]);
        if (bank.owner) await bank.owner.close();
      });
      for (const result of await Promise.allSettled([
        ...(bank.starting ? [bank.starting] : []),
        ...(bank.preparing ? [bank.preparing] : []),
        ...(bank.opening ? [bank.opening] : []),
        closing,
      ]))
        if (result.status === 'rejected' && result.reason !== expected)
          first ??= { value: result.reason };
      originals.observe = false;
      originals.scope = undefined;
      if (first) throw first.value;
    });
    return bank.finishing;
  };
  onTestFinished(finish);
  const setup = Promise.resolve().then(async () => {
    if (bank.closed) throw new Error('SCOPE_CONTROL_CLOSED');
    bank.starting = fixture(undefined, finish);
    const f = await bank.starting;
    if (bank.closed) throw new Error('SCOPE_CONTROL_CLOSED');
    const db = f.canvasScope.db;
    const state = { active: true };
    let birth: RuntimeBrowserBirth | undefined;
    if (runtime) {
      const account = db
        .select()
        .from(user)
        .all()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]!;
      const path = '/fixture/scope-agent',
        cwd = '/fixture/scope-workspace';
      db.insert(workspaces)
        .values({
          id: 'scope-workspace',
          projectKey: 'scope-project',
          key: 'main',
          path: cwd,
          source: '/fixture/source',
          provider: 'worktree',
          status: 'ready',
          portBase: 6200,
          portBlockSize: 10,
          ownerKind: 'agent',
          ownerRef: path,
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
        })
        .run();
      const principals = new ConnectorRuntimePrincipalService({
        db,
        authority: {
          authorizeTurn: async () => ({
            owner: { kind: 'user', userId: account.id },
            agentId: 'scope-manifest',
          }),
          revalidateTurn: async () => state.active,
        },
      });
      await principals.initializeBoot();
      if (bank.closed) throw new Error('SCOPE_CONTROL_CLOSED');
      const signal = new AbortController().signal;
      const turn = await principals.openTurn(
        {
          runtime: 'claude-code',
          canonicalSessionId: 'scope-session',
          agentPath: path,
          canonicalCwd: cwd,
          signal,
        },
        { isCurrent: () => state.active }
      );
      if (bank.closed) throw new Error('SCOPE_CONTROL_CLOSED');
      const resolved = await principals.resolve({
        bearer: turn.bearer,
        expectedRuntime: 'claude-code',
        expectedCanonicalCwd: cwd,
      });
      if (bank.closed || resolved.status !== 'resolved') throw new Error('SCOPE_CONTROL_CLOSED');
      const authors = new AuthorRegistry(db, {
        byPath: () => ({
          id: 'scope-manifest',
          name: 'Scope agent',
          displayName: 'Scope agent',
          responseMode: 'always',
          emoji: null,
          color: null,
        }),
      });
      birth = await captureRuntimeBrowserBirth({
        db,
        principals,
        authors,
        enabled: () => !bank.closed,
        context: {
          serverPrincipal: resolved.principal,
          identity: {
            agentPath: path,
            displayName: 'Scope agent',
            createdAt: new Date().toISOString(),
          },
          sessionId: 'scope-session',
          signal,
        },
      });
      if (bank.closed) throw new Error('SCOPE_CONTROL_CLOSED');
    }
    const held = new Promise<never>((_yes, no) => {
      bank.release = () => no(expected);
    });
    void held.catch(() => {});
    const entered = vi.fn(() => held);
    originals.network.mockReset().mockReturnValue({
      // Local-site approval is outside this control; unexpected use must refuse.
      allowLocalDestination: () => {
        throw new Error('UNEXPECTED_LOCAL_DESTINATION_ENTRY');
      },
      close: async () => {},
      authorizeWorkspace: entered,
      authorizeRuntimeWorkspace: entered,
    });
    originals.mode.mockReset().mockReturnValue({
      ownerId: f.canvasScope.owner,
      current: () => !bank.closed,
      configuration: { network: { policyRevision: 1 } },
    });
    originals.observe = true;
    bank.owner = createProductionBrowserSession({
      db,
      config: configManager,
      registry: f.registry,
      store: new BrowserRegistryStore(db, 'scope-constructor-control'),
      admission: { kind: 'production-browser-mode' },
    } as Parameters<typeof createProductionBrowserSession>[0]);
    bank.opening = bank.owner.open(
      {},
      birth?.workspaceId ?? 'source-scope',
      {
        requestId: 'scope_constructor_request_',
        mode: 'ephemeral',
      },
      new AbortController().signal,
      undefined,
      birth
    );
    void bank.opening.catch(() => {});
    await vi.waitFor(() => expect(entered).toHaveBeenCalledOnce());
    if (bank.closed || !originals.scope) throw new Error('SCOPE_CONTROL_CLOSED');
    return { f, scope: originals.scope, birth, state, finish, db };
  });
  bank.preparing = setup;
  return setup;
}

it('human production birth consumes genuine Canvas room membership and rejects its actual removal', async () => {
  const x = await scopeFixture(false),
    target = { kind: 'room' as const, roomId: x.f.canvasScope.roomId };
  expect(x.scope(x.f.canvasScope.recipient, target)).toBe(true);
  x.db
    .delete(roomMembers)
    .where(
      and(
        eq(roomMembers.roomId, target.roomId),
        eq(roomMembers.authorId, x.f.canvasScope.recipient)
      )
    )
    .run();
  expect(x.scope(x.f.canvasScope.recipient, target)).toBe(false);
  expect(
    x.scope(x.f.canvasScope.recipient, {
      kind: 'session',
      sessionId: 'absent-session',
    })
  ).toBe(false);
  await x.finish();
});
it('current runtime production birth admits its exact recipient session and separately genuine Canvas occupancy', async () => {
  const x = await scopeFixture(true),
    birth = x.birth!;
  expect(x.scope(birth.recipientId, { kind: 'session', sessionId: birth.sessionId })).toBe(true);
  expect(
    x.scope(birth.recipientId, {
      kind: 'session',
      sessionId: 'different-session',
    })
  ).toBe(false);
  expect(
    x.scope(x.f.canvasScope.recipient, {
      kind: 'room',
      roomId: x.f.canvasScope.roomId,
    })
  ).toBe(true);
  await x.finish();
});
it('retired runtime production birth cannot fall through to an otherwise authentic Canvas room member', async () => {
  const x = await scopeFixture(true),
    birth = x.birth!;
  const target = { kind: 'room' as const, roomId: x.f.canvasScope.roomId };
  expect(x.scope(x.f.canvasScope.recipient, target)).toBe(true);
  x.state.active = false;
  expect(birth.actor()).toBe(false);
  expect(x.scope(x.f.canvasScope.recipient, target)).toBe(false);
  expect(x.scope(birth.recipientId, { kind: 'session', sessionId: birth.sessionId })).toBe(false);
  await x.finish();
});

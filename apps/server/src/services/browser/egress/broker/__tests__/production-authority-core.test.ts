import { validateEngineConfiguration, type EngineConfiguration } from '@dorkos/browser';
import { createProductionBrowserRuntimeOwner } from '../../../runtime/production-owner.js';
import { BrowserRegistryStore } from '../../../registry/store.js';
import { installedPublisherAnchor } from '../../../runtime/installed-publisher-anchor.mjs';
import { logger } from '../../../../../lib/logger.js';
import { createBrowserRuntimeOwnerResolution } from '../../../runtime/runtime-owner-resolution.js';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import {
  createDb,
  runMigrations,
  session,
  user,
  workspaces,
  approvals,
  connectorRuntimeBindings,
  eq,
} from '@dorkos/db';
import { ConnectorRuntimePrincipalService } from '../../../../connectors/principal/runtime-principal-service.js';
import { createAuth } from '../../../../core/auth/index.js';
import { initConfigManager, configManager } from '../../../../core/config-manager.js';
import {
  createBrowserAuthorityCore,
  type PrivateLiveNetworkPreparation,
} from '../live/authority-core.js';
import { createServerInventory } from '../server-inventory.js';
import { createBrokerIssuer } from '../issuer.js';
import { createPrivateBroker } from '../broker.js';
import { FakeSocket, FakeBody, fakeTransport } from './fake-transport.js';
import { turns } from './broker-fixture.js';
import { AuthorRegistry } from '../../../../rooms/author-registry.js';
import { ApprovalService, hashApprovalInput } from '../../../../core/approvals/index.js';
import { createRuntimeWorkspaceDelegations } from '../../../runtime/runtime-workspace-delegation.js';
// This constructor seam is a semantic lifecycle control, not native/Chromium evidence.
// SQL, Better Auth, config subscriptions, inventory listener and broker are actual services.
const originalPackage = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../../../runtime/installed-package.js', () => ({
  resolveServerBrowserRuntimePackage: originalPackage.resolve,
}));
const lifecycle = vi.hoisted(() => ({
  consumeConfiguration: undefined as undefined | ((value: unknown) => void),
  currentFault: undefined as undefined | { value: unknown },
  custody: true,
  ordinary: true,
  runtime: 'a'.repeat(64) as string | null,
  retire: vi.fn(),
  consumeOptional: undefined as undefined | ((owner: unknown) => void),
  consumeNavigation: undefined as
    undefined | ((navigation: unknown, receiver: unknown) => Promise<void>),
}));
vi.mock('@dorkos/browser/server-owner', () => ({
  constructOwnedBrowserEngine: (
    _config: unknown,
    owner: {
      navigation?: unknown;
      registerBirth(value: object): void;
      network?: {
        bindBeforeLaunch(value: object): Promise<object>;
        activateReady(value: object, peer: object): Promise<void>;
      };
    }
  ) => {
    lifecycle.consumeConfiguration?.(_config);
    let finish!: () => void;
    const observation = new Promise<void>((resolve) => {
      finish = resolve;
    });
    return {
      async open() {
        const receiver = {
          browserId: 'fixture-browser',
          browserGeneration: 1,
          isOrdinary: () => lifecycle.ordinary,
          isAuthorityCurrent: () => {
            if (lifecycle.currentFault) throw lifecycle.currentFault.value;
            return lifecycle.custody && lifecycle.ordinary;
          },
          verifiedRuntimeBinding: () =>
            lifecycle.runtime === null
              ? null
              : { runtimeIdentity: lifecycle.runtime, policyRevision: 1 },
          observation,
          authorityRevoked() {
            lifecycle.ordinary = false;
            lifecycle.retire();
            finish();
            return observation;
          },
        };
        owner.registerBirth(receiver);

        if (owner.network) {
          const peer = await owner.network.bindBeforeLaunch(receiver);
          await lifecycle.consumeNavigation?.(owner.navigation, receiver);
          lifecycle.consumeOptional?.(owner);
          await owner.network.activateReady(receiver, peer);
        }
        return { browserId: 'fixture-browser', browserGeneration: 1 };
      },
      async shutdown() {
        lifecycle.ordinary = false;
        finish();
        return [{ cleanup: 'observed' }];
      },
    };
  },
}));
const cleanup: Array<() => Promise<unknown>> = [];
const acceptedAuthorityFailures: unknown[] = [];
// Release every held original before reverse owner/database/home teardown can wait on it.
const releases: Array<() => void> = [];
afterEach(async () => {
  let failed = false;
  let first: unknown;
  for (const release of releases.splice(0)) {
    try {
      release();
    } catch (value) {
      if (!failed) first = value;
      failed = true;
    }
  }
  for (const close of cleanup.splice(0).reverse()) {
    try {
      await close();
    } catch (error) {
      if (!failed) first = error;
      failed = true;
    }
  }
  lifecycle.currentFault = undefined;
  lifecycle.custody = true;
  lifecycle.runtime = 'a'.repeat(64);
  lifecycle.ordinary = true;
  lifecycle.retire.mockReset();
  lifecycle.consumeConfiguration = undefined;
  originalPackage.resolve.mockReset();
  lifecycle.consumeNavigation = undefined;
  lifecycle.consumeOptional = undefined;
  acceptedAuthorityFailures.length = 0;
  if (failed) throw first;
});
async function fixture(
  mode: 'CONNECT' | 'HTTP' | 'WS' = 'CONNECT',
  network?: PrivateLiveNetworkPreparation,
  beforeOpen?: (
    authority: ReturnType<typeof createBrowserAuthorityCore>,
    grant: Parameters<ReturnType<typeof createBrowserAuthorityCore>['openEngine']>[0]
  ) => void,
  participants?: Parameters<ReturnType<typeof createBrowserAuthorityCore>['openEngine']>[4],
  beforeAuthority?: (auth: ReturnType<typeof createAuth>) => void,
  runtimeAdmission?: (value: {
    db: ReturnType<typeof createDb>;
    owner: typeof user.$inferSelect;
    workspacePath: string;
    authority: ReturnType<typeof createBrowserAuthorityCore>;
  }) => Promise<Parameters<ReturnType<typeof createBrowserAuthorityCore>['openEngine']>[0]>,
  construction?: {
    runtimeOwner: NonNullable<Parameters<typeof createBrowserAuthorityCore>[1]>;
    configuration: EngineConfiguration;
    observeOriginalRegistry?(store: BrowserRegistryStore): void;
  }
) {
  const home = await mkdtemp(join(tmpdir(), 'browser-live-authority-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  initConfigManager(home);
  configManager.set('auth', { enabled: true });
  const db = createDb(join(home, 'fixture.db'));
  cleanup.push(async () => db.$client.close());
  runMigrations(db);
  const auth = createAuth(db, home);
  const response = await auth.api.signUpEmail({
    body: {
      name: 'Fixture owner',
      email: 'fixture' + '@' + 'dork.test',
      password: 'fixture-password-not-personal',
    },
    asResponse: true,
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const owner = db.select().from(user).get()!;
  db.insert(workspaces)
    .values({
      id: 'fixture-workspace',
      projectKey: 'fixture-project',
      key: 'fixture',
      path: join(home, 'workspace'),
      source: home,
      provider: 'clone',
      status: 'ready',
      portBase: 6400,
      portBlockSize: 10,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    })
    .run();
  const inventory = createServerInventory({
    instances: [{ id: 'fixture', listeners: ['http'] }],
    adminAuthorities: [],
    now: () => 0,
  });
  const listener = inventory.acquire(
    'fixture',
    'http',
    () => {
      const original = createServer();
      cleanup.push(
        () =>
          new Promise<void>((resolve, reject) =>
            original.close((error) => (error ? reject(error) : resolve()))
          )
      );
      return original;
    },
    (server) => server.listen(0, '127.0.0.1')
  );
  await once(listener, 'listening');
  beforeAuthority?.(auth);
  const authority = createBrowserAuthorityCore(
    {
      db,
      auth,
      config: configManager,
      inventory,
      policyRevision: 1,
      now: () => 0,
    },
    construction?.runtimeOwner
  );
  cleanup.push(async () => {
    try {
      await authority.stopAndJoin();
    } catch (value) {
      if (!acceptedAuthorityFailures.some((reason) => Object.is(reason, value))) throw value;
    }
  });
  const grant = runtimeAdmission
    ? await runtimeAdmission({
        db,
        owner,
        workspacePath: join(home, 'workspace'),
        authority,
      })
    : await authority.authorizeWorkspace(
        { cookie },
        'fixture-workspace',
        new AbortController().signal
      );
  const registryStore = construction ? new BrowserRegistryStore(db, 'fixture-vm-boot') : undefined;
  if (registryStore) construction?.observeOriginalRegistry?.(registryStore);
  beforeOpen?.(authority, grant);
  const { binding } = await authority
    .openEngine(
      grant,
      construction?.configuration ?? (network ? { network: { kind: 'owned' } } : {}),
      {},
      network,
      registryStore && participants ? { ...participants, registryStore } : participants
    )
    .catch((value) => {
      acceptedAuthorityFailures.push(value);
      throw value;
    });
  const issuer = createBrokerIssuer({ ports: authority.ports, now: () => 0 });
  const run = await issuer.retainRun(binding);
  const fake = fakeTransport();
  const broker = createPrivateBroker({
    issuer,
    run,
    transport: fake.transport,
    policy: {
      revision: 1,
      ...inventory.observe().policyInputs!,
      resolver: async () => ({ a: ['8.8.8.8'], aaaa: [], cname: [] }),
    },
  });
  if (mode === 'WS') {
    const accept = createHash('sha1')
      .update('dGhlIHNhbXBsZSBub25jZQ==' + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
    vi.mocked(fake.transport.exchange).mockResolvedValue({
      status: 101,
      headers: {
        connection: 'upgrade',
        upgrade: 'websocket',
        'sec-websocket-accept': accept,
      },
      websocketAccept: accept,
      body: fake.responseBody,
      head: new Uint8Array(),
    });
  }
  const descriptor = await broker.start();
  cleanup.push(() => broker.close());
  const client = new FakeSocket();
  expect(
    fake.accept(client, {
      raw: {
        method: mode === 'CONNECT' ? 'CONNECT' : 'GET',
        target:
          mode === 'CONNECT'
            ? 'example.test:443'
            : mode === 'WS'
              ? 'ws://example.test/'
              : 'http://example.test/',
        head: new Uint8Array(),
        rawHeaders: [
          'Host',
          mode === 'CONNECT' ? 'example.test:443' : 'example.test',
          ...(mode === 'WS'
            ? [
                'Connection',
                'Upgrade',
                'Upgrade',
                'websocket',
                'Sec-WebSocket-Version',
                '13',
                'Sec-WebSocket-Key',
                'dGhlIHNhbXBsZSBub25jZQ==',
              ]
            : []),
          'Proxy-Authorization',
          `Bearer ${descriptor.credential}`,
        ],
      },
      body: new FakeBody(),
    })
  ).toBe(true);
  await turns();
  expect(client.writes.join('')).toContain(
    mode === 'CONNECT' ? '200 Connection Established' : mode === 'WS' ? '101 Origin' : '200 Origin'
  );
  return {
    db,
    auth,
    cookie,
    binding,
    authority,
    grant,
    issuer,
    run,
    client,
    origin: fake.origins[0]!,
    owner,
    fake,
  };
}
it.each(
  (['CONNECT', 'HTTP', 'WS'] as const).flatMap((mode) =>
    (['owner', 'workspace', 'credential', 'config', 'grant', 'custody', 'runtime'] as const).map(
      (cause) => ({
        mode,
        cause,
      })
    )
  )
)(
  'rechecks actual $cause authority before another existing $mode byte',
  async ({ cause, mode }) => {
    const f = await fixture(mode);
    if (mode === 'HTTP') f.fake.responseBody.emit('allowed-before');
    else f.client.emit('allowed-before');
    const beforeOrigin = [...f.origin.writes],
      beforeClient = [...f.client.writes];
    expect((mode === 'HTTP' ? beforeClient : beforeOrigin).join('')).toContain('allowed-before');
    if (cause === 'owner') f.db.delete(user).where(eq(user.id, f.owner.id)).run();
    if (cause === 'workspace')
      f.db
        .update(workspaces)
        .set({ status: 'removing' })
        .where(eq(workspaces.id, 'fixture-workspace'))
        .run();
    if (cause === 'credential') f.db.delete(session).run();
    if (cause === 'config') configManager.set('auth', { enabled: false });
    if (cause === 'grant') f.authority.revokeWorkspace(f.grant);
    if (cause === 'custody') lifecycle.custody = false;
    if (cause === 'runtime') lifecycle.runtime = 'b'.repeat(64);
    if (mode === 'HTTP') f.fake.responseBody.emit('must-not-forward');
    else f.client.emit('must-not-forward');
    await turns();
    expect(f.origin.writes).toEqual(beforeOrigin);
    expect(f.client.writes).toEqual(beforeClient);
    expect(f.client.observedClosed).toBe(true);
    expect(f.origin.observedClosed).toBe(true);
    expect(() => f.issuer.check(f.run)).toThrow('AUTHORITY_REFUSED');
    expect(lifecycle.retire).toHaveBeenCalled();
  }
);
it('refuses copied grant DTOs and reuse of original one-use consent', async () => {
  const f = await fixture();
  let first: Readonly<{ value: unknown }> | undefined;
  try {
    await f.authority.openEngine({ ...f.grant }, {}, {});
  } catch (value) {
    first = Object.freeze({ value });
  }
  if (!first) throw new Error('EXPECTED_ORIGINAL_GRANT_REFUSAL');
  // Qualify the exact expected sticky original before later assertions or owner teardown.
  acceptedAuthorityFailures.push(first.value);
  expect(first.value).toMatchObject({ code: 'AUTHORITY_REFUSED' });
  await expect(f.authority.openEngine(f.grant, {}, {})).rejects.toThrow('AUTHORITY_REFUSED');
  await expect(f.authority.stopAndJoin()).rejects.toBe(first.value);
});

it('reserves authentication capacity before 64 held original calls begin and refuses the 65th', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release); // Installed before fixture/auth producers and any later original joins.
  let hold = false;
  let calls!: { mockClear(): void; mockRestore(): void };
  const authenticationBank: {
    results?: Promise<PromiseSettledResult<unknown>[]>;
  } = {};
  const f = await fixture('CONNECT', undefined, undefined, undefined, (auth) => {
    const original = auth.api.getSession.bind(auth.api);
    calls = vi.spyOn(auth.api, 'getSession').mockImplementation(async (request) => {
      if (hold) await gate;
      return original(request);
    });
  });
  // The initial fixture authentication naturally returned; no lifetime slot remains occupied.
  calls.mockClear();
  hold = true;
  cleanup.push(async () => {
    if (authenticationBank.results) await authenticationBank.results;
    calls.mockRestore();
  });
  authenticationBank.results = Promise.allSettled(
    Array.from({ length: 65 }, () =>
      f.authority.authorizeWorkspace(
        { cookie: f.cookie },
        'fixture-workspace',
        new AbortController().signal
      )
    )
  );
  let settled: PromiseSettledResult<unknown>[];
  try {
    await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(64));
  } finally {
    release();
    settled = await authenticationBank.results; // Join every admitted actual callback even if an assertion fails.
  }
  expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(64);
  expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
});

it('prepares cold before ready activation and binds the same original receiver and peer', async () => {
  const order: string[] = [];
  const peer = Object.freeze({
    url: 'http://127.0.0.1:6401',
    credentials: Object.freeze({
      username: 'dorkos',
      password: 'fixture-only',
    }),
    isCustodyKnown: () => true,
    close: async () => {},
  });
  let original: unknown;
  const f = await fixture('CONNECT', {
    async prepare(context) {
      order.push('cold');
      original = context.receiver;
      expect(context.authorizationEpoch).toBe(1);
      expect(context.binding.browserId).toBe(context.receiver.browserId);
      return peer;
    },
    async activate(receiver, actualPeer) {
      order.push('ready');
      expect(receiver).toBe(original);
      expect(actualPeer).toBe(peer);
      expect(receiver.isOrdinary()).toBe(true);
    },
  });
  expect(order).toEqual(['cold', 'ready']);
  expect(f.client.observedClosed).toBe(false);
});

it('refuses an acquired cold peer with unknown custody before ready activation', async () => {
  const activate = vi.fn();
  await expect(
    fixture('CONNECT', {
      async prepare() {
        return Object.freeze({
          url: 'http://127.0.0.1:6401',
          credentials: Object.freeze({
            username: 'dorkos',
            password: 'fixture-only',
          }),
          isCustodyKnown: () => false,
          close: async () => {},
        });
      },
      activate,
    })
  ).rejects.toThrow('AUTHORITY_REFUSED');
  expect(activate).not.toHaveBeenCalled();
  expect(lifecycle.retire).toHaveBeenCalledOnce();
});
it('refuses custody loss during cold activation and retires the same original', async () => {
  await expect(
    fixture('CONNECT', {
      async prepare() {
        return Object.freeze({
          url: 'http://127.0.0.1:6401',
          credentials: Object.freeze({
            username: 'dorkos',
            password: 'fixture-only',
          }),
          isCustodyKnown: () => true,
          close: async () => {},
        });
      },
      async activate() {
        lifecycle.custody = false;
      },
    })
  ).rejects.toThrow('AUTHORITY_REFUSED');
  expect(lifecycle.retire).toHaveBeenCalledOnce();
});

it('refuses missing verified original runtime proof', async () => {
  lifecycle.runtime = null;
  await expect(fixture()).rejects.toThrow('AUTHORITY_REFUSED');
  expect(lifecycle.retire).toHaveBeenCalledOnce();
});

it('reserves the original one-use grant before a participant getter reenters open', async () => {
  let authority!: ReturnType<typeof createBrowserAuthorityCore>;
  let grant!: Parameters<typeof authority.openEngine>[0];
  let reentrant: Promise<unknown> | undefined;
  let cause: unknown;
  cleanup.push(async () => {
    if (reentrant) {
      try {
        await reentrant;
      } catch (value) {
        cause = value;
      }
    }
  });
  const participants = {
    get bindEngine() {
      reentrant = authority.openEngine(grant, {}, {});
      // Observe its exact rejection immediately while retaining the original operation for cleanup.
      void reentrant.catch(() => {});
      return () => {};
    },
    registerBirth() {},
    refuseBirth() {},
  };
  await fixture(
    'CONNECT',
    undefined,
    (actual, capability) => {
      authority = actual;
      grant = capability;
    },
    participants
  );
  await expect(reentrant).rejects.toThrow('AUTHORITY_REFUSED');
  try {
    await reentrant;
  } catch (value) {
    acceptedAuthorityFailures.push(value);
  }
  void cause;
});

it('joins held original cold preparation when stop enters and retains its undefined rejection', async () => {
  let release!: (value: unknown) => void;
  const held = new Promise<never>((_resolve, reject) => {
    release = reject;
  });
  let authority: ReturnType<typeof createBrowserAuthorityCore> | undefined;
  const preparationBank: {
    opening?: Promise<unknown>;
    closing?: Promise<unknown>;
  } = {};
  releases.push(() => release(undefined));
  cleanup.push(async () => {
    release(undefined);
    const originals = [preparationBank.opening, preparationBank.closing].filter(
      (value): value is Promise<unknown> => value !== undefined
    );
    const results = await Promise.allSettled(originals);
    for (const result of results)
      if (result.status === 'rejected' && result.reason !== undefined) throw result.reason;
  });
  let entered!: () => void;
  const preparing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  preparationBank.opening = fixture(
    'CONNECT',
    {
      prepare() {
        entered();
        return held;
      },
      async activate() {
        throw new Error('ACTIVATION_MUST_NOT_START');
      },
    },
    (actual) => {
      authority = actual;
    }
  );
  void preparationBank.opening.catch(() => {});
  await preparing;
  preparationBank.closing = authority!.stopAndJoin();
  void preparationBank.closing.catch(() => {});
  let settled = false;
  void preparationBank.closing.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.resolve();
  expect(settled).toBe(false);
  release(undefined);
  await expect(preparationBank.opening).rejects.toBeUndefined();
  await expect(preparationBank.closing).rejects.toBeUndefined();
  acceptedAuthorityFailures.push(undefined);
});

it('uses captured cold activation despite replacement of the caller network callback during preparation', async () => {
  const replacement = vi.fn(async () => {
    throw false;
  });
  const originalActivate = vi.fn(async () => {});
  const network: PrivateLiveNetworkPreparation = {
    async prepare() {
      network.activate = replacement;
      return Object.freeze({
        url: 'http://127.0.0.1:6401',
        credentials: Object.freeze({
          username: 'dorkos',
          password: 'fixture-only',
        }),
        isCustodyKnown: () => true,
        close: async () => {},
      });
    },
    activate: originalActivate,
  };
  await fixture('CONNECT', network);
  expect(originalActivate).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});

it('forwards original navigation receiver and continuation callbacks after caller replacement during cold preparation', async () => {
  const register = vi.fn(function (this: unknown) {
    expect(this).toBe(navigation);
  });
  const lifetime = vi.fn(function (this: unknown) {
    expect(this).toBe(navigation);
  });
  const acquire = vi.fn(async function (this: unknown) {
    expect(this).toBe(continuation);
  });
  const join = vi.fn(async function (this: unknown) {
    expect(this).toBe(continuation);
  });
  const transition = vi.fn(function (this: unknown) {
    expect(this).toBe(continuation);
  });
  const replacement = vi.fn(() => {
    throw new Error('REPLACED_CALLER_CALLBACK');
  });
  const continuation = {
    acquire,
    joinPublications: join,
    observeTransition: transition,
  };
  const navigation = {
    registerDispatcher: register,
    observeLifetime: lifetime,
    continuation,
  };
  const participants = {
    registerBirth() {},
    refuseBirth() {},
    navigation,
  } as unknown as Parameters<ReturnType<typeof createBrowserAuthorityCore>['openEngine']>[4];
  lifecycle.consumeNavigation = async (value, receiver) => {
    const captured = value as typeof navigation;
    Reflect.apply(captured.registerDispatcher, captured, [{}]);
    Reflect.apply(captured.observeLifetime, captured, [receiver]);
    await Reflect.apply(captured.continuation.acquire, captured.continuation, [{}]);
    await Reflect.apply(captured.continuation.joinPublications, captured.continuation, [{}]);
    Reflect.apply(captured.continuation.observeTransition, captured.continuation, [
      {},
      Promise.resolve({}),
    ]);
  };
  await fixture(
    'CONNECT',
    {
      async prepare() {
        navigation.registerDispatcher = replacement;
        navigation.observeLifetime = replacement;
        continuation.acquire = replacement as unknown as typeof acquire;
        continuation.joinPublications = replacement as unknown as typeof join;
        continuation.observeTransition = replacement;
        return Object.freeze({
          url: 'http://127.0.0.1:6401',
          credentials: Object.freeze({
            username: 'dorkos',
            password: 'fixture-only',
          }),
          isCustodyKnown: () => true,
          close: async () => {},
        });
      },
      async activate() {},
    },
    undefined,
    participants
  );
  for (const original of [register, lifetime, acquire, join, transition])
    expect(original).toHaveBeenCalledOnce();
  expect(replacement).not.toHaveBeenCalled();
});

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'genuine %s original turn opens its agent workspace and cannot forward after turn revocation',
  async (runtime) => {
    let original: ConnectorRuntimePrincipalService | undefined;
    let bindingId: string | undefined;
    const f = await fixture(
      'CONNECT',
      undefined,
      undefined,
      undefined,
      undefined,
      async ({ db, owner, workspacePath, authority }) => {
        db.update(workspaces)
          .set({ ownerKind: 'agent', ownerRef: '/fixture/runtime-agent' })
          .where(eq(workspaces.id, 'fixture-workspace'))
          .run();
        const principals = new ConnectorRuntimePrincipalService({
          db,
          authority: {
            authorizeTurn: async () => ({
              owner: { kind: 'user', userId: owner.id },
              agentId: 'runtime-manifest-original',
            }),
            revalidateTurn: async () => true,
          },
        });
        await principals.initializeBoot();
        const signal = new AbortController().signal;
        const turn = await principals.openTurn(
          {
            runtime,
            canonicalSessionId: 'runtime-session-original',
            agentPath: '/fixture/runtime-agent',
            canonicalCwd: workspacePath,
            signal,
          },
          { isCurrent: () => true }
        );
        const resolved = await principals.resolve({
          bearer: turn.bearer,
          expectedRuntime: runtime,
          expectedCanonicalCwd: workspacePath,
        });
        if (resolved.status !== 'resolved' || resolved.principal.claims.kind !== 'runtime')
          throw new Error('Original runtime fixture credential refused');
        original = principals;
        bindingId = resolved.principal.claims.bindingId;
        return authority.authorizeRuntimeWorkspace(
          principals,
          resolved.principal,
          'fixture-workspace',
          signal
        );
      }
    );
    f.client.emit('owned-turn-before');
    expect(f.origin.writes.join('')).toContain('owned-turn-before');
    const before = [...f.origin.writes];
    if (!original || !bindingId) throw new Error('Original runtime credential not captured');
    await original.revoke(bindingId, 'turn_cancelled');
    f.client.emit('revoked-turn-after');
    await turns();
    expect(f.origin.writes).toEqual(before);
    expect(f.client.observedClosed).toBe(true);
    expect(lifecycle.retire).toHaveBeenCalledTimes(1);
  }
);

it.each(['claude-code', 'codex', 'opencode'] as const)(
  'genuine local-install %s turn maps the original owner without rewriting claims and stops after account admission loss',
  async (runtime) => {
    let original: ConnectorRuntimePrincipalService | undefined;
    let bindingId: string | undefined;
    let mappedAdmission = true;
    const f = await fixture(
      'CONNECT',
      undefined,
      undefined,
      undefined,
      undefined,
      async ({ db, owner, workspacePath, authority }) => {
        db.update(workspaces)
          .set({ ownerKind: 'agent', ownerRef: '/fixture/runtime-agent' })
          .where(eq(workspaces.id, 'fixture-workspace'))
          .run();
        const principals = new ConnectorRuntimePrincipalService({
          db,
          authority: {
            authorizeTurn: async () => ({
              owner: {
                kind: 'local_install',
                installationId: 'original-installation',
              },
              agentId: 'runtime-manifest-original',
            }),
            revalidateTurn: async () => true,
          },
        });
        await principals.initializeBoot();
        const signal = new AbortController().signal;
        const turn = await principals.openTurn(
          {
            runtime,
            canonicalSessionId: 'runtime-session-original',
            agentPath: '/fixture/runtime-agent',
            canonicalCwd: workspacePath,
            signal,
          },
          { isCurrent: () => true }
        );
        const resolved = await principals.resolve({
          bearer: turn.bearer,
          expectedRuntime: runtime,
          expectedCanonicalCwd: workspacePath,
        });
        if (resolved.status !== 'resolved' || resolved.principal.claims.kind !== 'runtime')
          throw new Error('Original runtime fixture credential refused');
        original = principals;
        bindingId = resolved.principal.claims.bindingId;
        expect(resolved.principal.claims.owner).toEqual({
          kind: 'local_install',
          installationId: 'original-installation',
        });
        const row = db
          .select()
          .from(connectorRuntimeBindings)
          .where(eq(connectorRuntimeBindings.id, bindingId))
          .get();
        expect([row?.ownerKind, row?.ownerId]).toEqual(['local_install', 'original-installation']);
        const owners = createBrowserRuntimeOwnerResolution({
          db,
          authors: new AuthorRegistry(db),
          installationId: 'original-installation',
          enabled: () => mappedAdmission,
        });
        return authority.authorizeRuntimeWorkspace(
          principals,
          resolved.principal,
          'fixture-workspace',
          signal,
          undefined,
          owners
        );
      }
    );
    f.client.emit('owned-turn-before');
    expect(f.origin.writes.join('')).toContain('owned-turn-before');
    const before = [...f.origin.writes];
    if (!original || !bindingId) throw new Error('Original runtime credential not captured');
    mappedAdmission = false;
    f.client.emit('revoked-turn-after');
    await turns();
    expect(f.origin.writes).toEqual(before);
    expect(f.client.observedClosed).toBe(true);
    expect(lifecycle.retire).toHaveBeenCalledTimes(1);
  }
);

it('forwards each exact optional native dispatcher receiver after caller replacement during original cold preparation', async () => {
  const dispatcher = Object.freeze({ original: 'native-dispatcher' });
  const observations: Array<{ receiver: object; dispatcher: unknown }> = [];
  const receivers = ['upload', 'download', 'semantic'].map(() => ({
    registerDispatcher: function (this: object, value: unknown) {
      observations.push({ receiver: this, dispatcher: value });
    },
  }));
  const [upload, download, semantic] = receivers;
  const replacement = vi.fn(() => {
    throw new Error('REPLACED_OPTIONAL_RECEIVER');
  });
  const participants = {
    registerBirth() {},
    refuseBirth() {},
    upload,
    download,
    semantic,
  } as unknown as Parameters<ReturnType<typeof createBrowserAuthorityCore>['openEngine']>[4];
  lifecycle.consumeOptional = (value) => {
    const owner = value as {
      upload: { registerDispatcher(value: unknown): void };
      download: { registerDispatcher(value: unknown): void };
      semantic: { registerDispatcher(value: unknown): void };
    };
    for (const original of [owner.upload, owner.download, owner.semantic])
      original.registerDispatcher(dispatcher);
  };
  await fixture(
    'CONNECT',
    {
      async prepare() {
        for (const receiver of receivers) receiver.registerDispatcher = replacement;
        return Object.freeze({
          url: 'http://127.0.0.1:6401',
          credentials: Object.freeze({
            username: 'dorkos',
            password: 'fixture-only',
          }),
          isCustodyKnown: () => true,
          close: async () => {},
        });
      },
      async activate() {},
    },
    undefined,
    participants
  );
  expect(observations.map((value) => value.receiver)).toEqual(receivers);
  expect(observations.every((value) => value.dispatcher === dispatcher)).toBe(true);
  expect(replacement).not.toHaveBeenCalled();
});

it('consumes a genuine owner-approved ordinary workspace through network authority and fences it when that exact approval is revoked', async () => {
  const bank: { revoke?: () => void } = {};
  const f = await fixture(
    'CONNECT',
    undefined,
    undefined,
    undefined,
    undefined,
    async ({ db, owner, workspacePath, authority }) => {
      const principals = new ConnectorRuntimePrincipalService({
        db,
        authority: {
          authorizeTurn: async () => ({
            owner: { kind: 'user', userId: owner.id },
            agentId: 'delegated-manifest',
          }),
          revalidateTurn: async () => true,
        },
      });
      await principals.initializeBoot();
      const signal = new AbortController().signal;
      const turn = await principals.openTurn(
        {
          runtime: 'claude-code',
          canonicalSessionId: 'delegated-session',
          agentPath: '/fixture/delegated-agent',
          canonicalCwd: workspacePath,
          signal,
        },
        { isCurrent: () => true }
      );
      const resolved = await principals.resolve({
        bearer: turn.bearer,
        expectedRuntime: 'claude-code',
        expectedCanonicalCwd: workspacePath,
      });
      if (resolved.status !== 'resolved') throw new Error('ORIGINAL_PRINCIPAL_MISSING');
      const authors = new AuthorRegistry(db, {
        byPath: () => ({
          id: 'delegated-manifest',
          name: 'Agent',
          displayName: 'Agent',
          responseMode: 'always',
          emoji: null,
          color: null,
        }),
      });
      const delegations = createRuntimeWorkspaceDelegations({
        db,
        enabled: () => true,
        refuse: () => new Error('DELEGATION_REFUSED'),
      });
      releases.push(() => delegations.close());
      const input = {
        workspaceId: 'fixture-workspace',
        sessionId: 'delegated-session',
      };
      const change = delegations.describe(input);
      const service = new ApprovalService(db);
      const binding = {
        capabilityId: 'browser.open_delegated',
        inputHash: hashApprovalInput({ input, change }),
      };
      const ticket = service.request({
        ...binding,
        summary: 'Open this workspace browser',
        requestedBy: 'Agent',
        requestedByPath: '/fixture/delegated-agent',
        requestingSession: { sessionId: input.sessionId, cwd: workspacePath },
      });
      if (service.grant(ticket.approvalId, owner.id)) throw new Error('APPROVAL_FAILED');
      const consumed = service.consume(ticket.token, binding);
      if (consumed.outcome !== 'granted') throw new Error('APPROVAL_FAILED');
      const token = delegations.issue(
        input,
        input,
        {
          serverPrincipal: resolved.principal,
          identity: {
            agentPath: '/fixture/delegated-agent',
            displayName: 'Agent',
            createdAt: new Date().toISOString(),
          },
          sessionId: input.sessionId,
          signal,
          approvedChange: change,
          approval: {
            via: 'approval',
            approvalId: consumed.approvalId,
            decidedByUserId: consumed.decidedByUserId,
          },
        },
        principals,
        authors
      );
      bank.revoke = () => {
        db.update(approvals)
          .set({ state: 'denied' })
          .where(eq(approvals.id, ticket.approvalId))
          .run();
      };
      const grant = await authority.authorizeRuntimeWorkspace(
        principals,
        resolved.principal,
        input.workspaceId,
        signal,
        token
      );
      const row = db.select().from(workspaces).where(eq(workspaces.id, input.workspaceId)).get();
      expect(row?.ownerKind).toBeNull();
      expect(row?.ownerRef).toBeNull();
      return grant;
    }
  );
  f.client.emit('approved-original');
  expect(f.origin.writes.join('')).toContain('approved-original');
  const before = [...f.origin.writes];
  if (!bank.revoke) throw new Error('ORIGINAL_APPROVAL_MISSING');
  bank.revoke();
  f.client.emit('revoked-original');
  await turns();
  expect(f.origin.writes).toEqual(before);
  expect(f.client.observedClosed).toBe(true);
  expect(lifecycle.retire).toHaveBeenCalledTimes(1);
});

it.each([
  ['owner', 'facts.owner'],
  ['session', 'facts.session'],
  ['session-expired', 'facts.session-expired'],
  ['session-changed', 'facts.session-changed'],
  ['workspace-status', 'facts.workspace-status'],
  ['workspace-changed', 'facts.workspace-changed'],
  ['ordinary', 'authority.ordinary'],
  ['current', 'authority.current'],
  ['runtime', 'authority.runtime'],
] as const)(
  'labels the actual original human authority %s decision using genuine SQL',
  async (change, stage) => {
    const diagnosticRows: unknown[] = [];
    const info = vi.spyOn(logger, 'info').mockImplementation((message, ...values) => {
      if (message === 'Browser viewer original refusal stage') diagnosticRows.push(values[0]);
    });
    cleanup.push(async () => {
      info.mockRestore();
    });
    const f = await fixture();
    if (change === 'owner') f.db.delete(user).where(eq(user.id, f.owner.id)).run();
    if (change === 'session') f.db.delete(session).run();
    if (change === 'session-expired')
      f.db
        .update(session)
        .set({ expiresAt: new Date(0) })
        .run();
    if (change === 'session-changed')
      f.db
        .update(session)
        .set({ updatedAt: new Date(0) })
        .run();
    if (change === 'workspace-status')
      f.db
        .update(workspaces)
        .set({ status: 'removing' })
        .where(eq(workspaces.id, 'fixture-workspace'))
        .run();
    if (change === 'workspace-changed')
      f.db
        .update(workspaces)
        .set({ source: '/changed-source' })
        .where(eq(workspaces.id, 'fixture-workspace'))
        .run();
    if (change === 'ordinary') lifecycle.ordinary = false;
    if (change === 'current') lifecycle.custody = false;
    if (change === 'runtime') lifecycle.runtime = 'b'.repeat(64);
    expect(() => f.authority.ports.readCurrent(f.binding)).toThrow('AUTHORITY_REFUSED');
    expect(diagnosticRows.at(-1)).toEqual({ stage, ordinal: 1 });
    await turns();
    expect(lifecycle.retire).toHaveBeenCalledOnce();
    expect(() => f.authority.ports.readCurrent(f.binding)).toThrow('AUTHORITY_REFUSED');
    expect(diagnosticRows.at(-1)).toEqual({ stage: 'authority.active', ordinal: 2 });
  }
);
it.each([false, undefined])(
  'retains exact current-authority fault %s and retires independently of logger failure',
  async (cause) => {
    const info = vi.spyOn(logger, 'info').mockImplementation((message) => {
      if (message === 'Browser viewer original refusal stage') throw new Error('DIAGNOSTIC_ONLY');
    });
    cleanup.push(async () => {
      info.mockRestore();
    });
    const f = await fixture();
    lifecycle.currentFault = { value: cause };
    let first: { value: unknown } | undefined;
    try {
      f.authority.ports.readCurrent(f.binding);
    } catch (value) {
      first = { value };
    }
    expect(first).toEqual({ value: cause });
    await turns();
    expect(lifecycle.retire).toHaveBeenCalledOnce();
    expect(() => f.authority.ports.readCurrent(f.binding)).toThrow('AUTHORITY_REFUSED');
  }
);

it('refuses an empty installed VM catalogue through real registry-backed authority and joins both owners', async () => {
  const runtimeOwner = createProductionBrowserRuntimeOwner();
  const expected: { failure?: { value: unknown } } = {};
  cleanup.push(async () => {
    try {
      await runtimeOwner.close();
    } catch (value) {
      if (!expected.failure || !Object.is(value, expected.failure.value)) throw value;
    }
  });
  const configuration = validateEngineConfiguration({
    dataDir: '/owned/browser',
    runtime: {
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: '/supplied/library',
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path: '/supplied/executable',
        sha256: 'a'.repeat(64),
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin',
        arch: 'arm64',
      },
      identity: { mode: 'chrome-compatible', policyRevision: 1 },
    },
    network: { kind: 'owned', origin: 'about:blank', policyRevision: 1 },
    clock: { wallNow: Date.now, monotonicNow: performance.now },
    processes: {
      observe: async () => ({ status: 'unknown' }),
      descendants: async () => ({ status: 'unknown', identities: [] }),
    },
    policy: { authorizeAction: async () => 'refused', verifyBrokerLease: async () => 'unknown' },
  });
  expect(installedPublisherAnchor).toBeNull();
  const oldConstructor = vi.fn();
  lifecycle.consumeConfiguration = oldConstructor;
  const prepare = vi.fn(async () => {
    throw new Error('UNENTERED_NETWORK');
  });
  const activate = vi.fn(async () => {});
  const bindEngine = vi.fn();
  const registerInput = vi.fn();
  const registerCapture = vi.fn();
  const registerNavigation = vi.fn();
  const registerBirth = vi.fn();
  const refuseBirth = vi.fn();
  const originals: {
    authority?: ReturnType<typeof createBrowserAuthorityCore>;
    registry?: BrowserRegistryStore;
  } = {};
  const [opening] = await Promise.allSettled([
    fixture(
      'CONNECT',
      { prepare, activate },
      (authority) => {
        originals.authority = authority;
      },
      {
        bindEngine,
        input: { registerDispatcher: registerInput },
        capture: { registerDispatcher: registerCapture },
        navigation: { registerDispatcher: registerNavigation },
        registerBirth,
        refuseBirth,
      },
      undefined,
      undefined,
      {
        runtimeOwner,
        configuration,
        observeOriginalRegistry(store) {
          originals.registry = store;
        },
      }
    ),
  ]);
  if (opening.status !== 'rejected') throw new Error('EXPECTED_INSTALLED_VM_REFUSAL');
  expected.failure = { value: opening.reason }; // Retain exact original before assertions/teardown.
  const { authority: originalAuthority, registry: originalRegistry } = originals;
  if (!originalAuthority || !originalRegistry) throw new Error('ORIGINAL_AUTHORITY_NOT_CAPTURED');
  // Enter both independent cleanup duties before observing either result.
  const joined = await Promise.allSettled([runtimeOwner.close(), originalAuthority.stopAndJoin()]);
  expect(opening.reason).toMatchObject({
    message:
      process.platform === 'darwin' && process.arch === 'arm64'
        ? 'INSTALLED_PUBLISHER_ANCHOR_REQUIRED'
        : 'INSTALLED_RUNTIME_STAGE',
  });
  for (const result of joined) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(result.reason).toBe(opening.reason);
  }
  expect(originalRegistry.rows()).toHaveLength(0);
  expect(originalPackage.resolve).not.toHaveBeenCalled();
  for (const call of [
    oldConstructor,
    prepare,
    activate,
    bindEngine,
    registerInput,
    registerCapture,
    registerNavigation,
    registerBirth,
    refuseBirth,
  ])
    expect(call).not.toHaveBeenCalled();
});

it.each(['CONNECT', 'HTTP', 'WS'] as const)(
  'preserves the actual existing %s flow across Community navigation preference writes',
  async (mode) => {
    const f = await fixture(mode);
    configManager.setDot('ui.communityNavigation', { version: 1, owners: [] });
    if (mode === 'HTTP') f.fake.responseBody.emit('after-navigation-preference');
    else f.client.emit('after-navigation-preference');
    await turns();
    f.issuer.check(f.run);
    expect((mode === 'HTTP' ? f.client.writes : f.origin.writes).join('')).toContain(
      'after-navigation-preference'
    );
    expect(f.client.observedClosed).toBe(false);
    expect(f.origin.observedClosed).toBe(false);
    expect(lifecycle.retire).not.toHaveBeenCalled();
  }
);

it.each(['auth', 'browser', 'browser.chromeUserAgent', 'tunnel'] as const)(
  'retires the original active broker on relevant config path %s including parent replacement',
  async (path) => {
    const f = await fixture();
    if (path === 'browser.chromeUserAgent') {
      const { mintBrowserIdentityChoicePermit } =
        await import('../../../runtime/activation/identity-choice-permit.js');
      configManager.chooseOwnedBrowserIdentity(
        true,
        mintBrowserIdentityChoicePermit(configManager, true, () => true)
      );
    } else configManager.set(path, { ...configManager.get(path) });
    f.client.emit('must-not-forward-after-relevant-config');
    await turns();
    expect(() => f.issuer.check(f.run)).toThrow('AUTHORITY_REFUSED');
    expect(f.origin.writes.join('')).not.toContain('must-not-forward-after-relevant-config');
    expect(f.client.observedClosed).toBe(true);
    expect(f.origin.observedClosed).toBe(true);
    expect(lifecycle.retire).toHaveBeenCalled();
  }
);

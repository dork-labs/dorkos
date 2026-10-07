import type { BrowserControllerNavigation } from '../controller-navigation.js';
import { expect, onTestFinished, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Request, type Response } from 'express';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createDb, runMigrations, user, account, type Db } from '@dorkos/db';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { BrowserInputRequestSchema, type BrowserBinding } from '@dorkos/shared/browser-schemas';
import type { BrowserResult } from '@dorkos/browser';
import type { BrowserLifecycleEngine } from '@dorkos/browser/server-owner';
import { constructOwnedBrowserEngine } from '../../../../../../../packages/browser/src/engine.js';
import { BrowserLifecycleError } from '../../../../../../../packages/browser/src/lifecycle/errors.js';
import {
  configuration,
  fakePage,
  requestId,
  root,
} from '../../../../../../../packages/browser/src/__tests__/parent-fixture.js';
import { getAuth, initAuth, toNodeHandler } from '../../../core/auth/index.js';
import { sessionGate } from '../../../core/auth/session-gate.js';
import { configManager, initConfigManager } from '../../../core/config-manager.js';
import { createRoomHarness, agentLookupFor } from '../../../rooms/__tests__/room-test-harness.js';
import { setRoomService } from '../../../rooms/index.js';
import { resolveCaller } from '../../../../routes/room-caller.js';
import { env } from '../../../../env.js';
import { BrowserRegistry } from '../../registry/registry.js';
import { BrowserRegistryStore } from '../../registry/store.js';
import { OwnedBrowserGrants } from '../grants.js';
import { OwnedBrowserController } from '../controller.js';
import { BrowserControllerIdentities } from '../controller-auth.js';
import { BrowserControllerHost } from '../controller-host.js';
import { BrowserControllerInput } from '../controller-input.js';

import { BrowserInputRoutes } from '../input-routes.js';
import { BrowserApiRefusal } from '../service.js';

// Actual auth/HTTP/SQLite/registry/source-engine composition. Only native methods/process
// identity/library/proxy stand in; these controls do not establish native/platform rendering.
const source = vi.hoisted(() => ({ launch: vi.fn() }));
vi.mock('../../../../../../../packages/browser/src/runtime/public-library.js', () => ({
  verifiedLibrary: async () => ({ launchPersistentContext: source.launch }),
}));
vi.mock('../../../../../../../packages/browser/src/runtime/host-identity.js', () => ({
  hostIdentity: () => root,
  nativeHolder: async () => root,
}));
vi.mock('../../../../../../../packages/browser/src/network/fixture-proxy.js', () => ({
  startFixtureProxy: async () => ({
    url: 'http://127.0.0.1:9002',
    close: async () => {},
  }),
}));
export const target = swappableServer();
const cookies = (response: { headers: Record<string, unknown> }) =>
  (response.headers['set-cookie'] as string[]).map((value) => value.split(';')[0]).join('; ');

type Captured = { req: Request; res: Response };
export async function fixture(
  navigation?: BrowserControllerNavigation,
  beforeDispose?: () => Promise<void>
) {
  const originals: {
    home?: string;
    db?: Db;
    engine?: ReturnType<typeof constructOwnedBrowserEngine>;
    input?: BrowserControllerInput;
    identities?: BrowserControllerIdentities;
    grants?: OwnedBrowserGrants;
    routes?: BrowserInputRoutes;
    navigation?: BrowserControllerNavigation;
  } = { navigation };
  const releases: Array<() => void> = [];
  const restores: Array<() => void> = [];
  const acceptedFailures = new Set<unknown>();
  let enabled = true;
  let expectedTerminal: 'retired-controller-input' | undefined;
  let originalInputUncertain = false;
  onTestFinished(async () => {
    let failed = false,
      first: unknown;
    let shutdownOutcomes: Array<{ cleanup: string; reason: string | null }> = [];
    const healthy = {
      navigation: navigation === undefined,
      routes: false,
      input: false,
      identity: false,
      grants: false,
      engine: false,
      db: false,
    };
    for (const release of releases) {
      try {
        release();
      } catch (error) {
        if (!failed) {
          failed = true;
          first = error;
        }
      }
    }
    // Consumer participants release and join their original work before this fixture's services/DB.
    try {
      await beforeDispose?.();
    } catch (error) {
      if (!failed) {
        failed = true;
        first = error;
      }
    }
    for (const close of [
      async () => {
        await originals.navigation?.close();
        healthy.navigation = true;
      },
      async () => {
        try {
          await originals.routes?.close();
          healthy.routes = true;
        } catch (error) {
          if (!acceptedFailures.has(error)) throw error;
        }
      },
      async () => {
        try {
          await originals.input?.close();
          healthy.input = true;
        } catch (error) {
          // Only the exact body-observed original negative cause is accepted. Custody
          // stays unverified, so the retained home cannot become healthy cleanup.
          if (!acceptedFailures.has(error)) throw error;
        }
      },
      async () => {
        await originals.identities?.close();
        healthy.identity = true;
      },
      async () => {
        await originals.grants?.closeExpiry();
        healthy.grants = true;
      },
      async () => {
        const receipts = await originals.engine?.shutdown();
        shutdownOutcomes = (receipts ?? []).map((receipt) => ({
          cleanup: receipt.cleanup,
          reason: 'reason' in receipt ? (receipt.reason ?? null) : null,
        }));
        if (receipts?.some((receipt) => receipt.cleanup !== 'observed')) {
          if (!expectedTerminal) throw new Error('original-input-engine-cleanup-unverified');
        } else healthy.engine = true;
      },
      async () => {
        originals.db?.$client.close();
        healthy.db = true;
      },
    ]) {
      try {
        await close();
      } catch (error) {
        if (!failed) {
          failed = true;
          first = error;
        }
      }
    }
    for (const restore of restores) {
      try {
        restore();
      } catch (error) {
        if (!failed) {
          failed = true;
          first = error;
        }
      }
    }
    try {
      // This body observed a failed grant reset before joining original identity cleanup.
      // The failed Seat is no longer a reset candidate; only a genuine fulfilled join qualifies.
      if (expectedTerminal && !healthy.identity)
        throw new Error('expected-original-retired-controller-identity-join-not-observed');
      if (originals.home && !expectedTerminal && Object.values(healthy).every(Boolean))
        fs.rmSync(originals.home, { recursive: true, force: true });
      else if (originals.home && (acceptedFailures.size > 0 || expectedTerminal)) {
        const row =
          JSON.stringify({
            kind: 'browser-input-negative-cleanup',
            expectedTerminal: expectedTerminal ?? null,
            identityCleanup: healthy.identity ? 'joined' : 'unverified',
            shutdownOutcomes,
            healthy,
            homeRemoved: false,
            home: originals.home,
          }) + '\n';
        if (Buffer.byteLength(row) > 1024 || fs.writeSync(1, row) !== Buffer.byteLength(row))
          throw new Error('input-negative-cleanup-receipt-refused');
      }
    } catch (error) {
      if (!failed) {
        failed = true;
        first = error;
      }
    }
    if (failed) throw first;
  });
  const home = (originals.home = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-private-input-')));
  initConfigManager(home);
  const db: Db = (originals.db = createDb(path.join(home, 'input.db')));
  runMigrations(db);
  initAuth(db, home);
  const app = express(),
    captures: Captured[] = [];
  const authenticationPhase = new AsyncLocalStorage<{
    inputCaptured: boolean;
  }>();
  // Observe each original HTTP request before its ordinary session gate. This marker
  // carries no user/grant/native authority and never changes the original auth result.
  app.use((_req, _res, next) => authenticationPhase.run({ inputCaptured: false }, next));
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json());
  app.use(sessionGate);
  app.post('/api/capture', (req, res) => {
    captures.push({ req, res });
    res.json({ captured: captures.length });
  });
  target.mount(app);
  const origin = `http://localhost:${env.DORKOS_PORT}`,
    host = `localhost:${env.DORKOS_PORT}`;
  const email = 'view-owner' + '@' + 'dork.test',
    password = 'fictitious-view-password';
  const signed = await request(target.server)
    .post('/api/auth/sign-up/email')
    .set('Origin', origin)
    .set('Host', host)
    .send({ email, password, name: 'Fixture owner' });
  expect(signed.status).toBe(200);
  const ownerRow = db.select().from(user).get()!;
  const credentialRow = db.select().from(account).get()!;
  // Registration remains single-account in production. Seed a fictitious second fixture account,
  // then authenticate its actual password through Better Auth HTTP. No RequestUser is fabricated.
  const viewerUser = 'fixture-second-view-user';
  db.insert(user)
    .values({
      id: viewerUser,
      name: 'Fixture viewer',
      email: 'view-recipient' + '@' + 'dork.test',
      emailVerified: false,
      createdAt: new Date(ownerRow.createdAt.getTime() + 1000),
      updatedAt: new Date(),
    })
    .run();
  db.insert(account)
    .values({
      ...credentialRow,
      id: 'fixture-view-account',
      userId: viewerUser,
      accountId: viewerUser,
    })
    .run();
  const signIn = async (email: string) => {
    const response = await request(target.server)
      .post('/api/auth/sign-in/email')
      .set('Origin', origin)
      .set('Host', host)
      .send({ email, password });
    expect(response.status).toBe(200);
    return cookies(response);
  };
  const cookieOwner = await signIn(email),
    cookieViewer = await signIn('view-recipient' + '@' + 'dork.test'),
    cookieOtherViewer = await signIn('view-recipient' + '@' + 'dork.test');
  configManager.set('auth', { enabled: true });
  const rooms = createRoomHarness({
    db,
    agents: agentLookupFor({}),
    ownerUserId: ownerRow.id,
  });
  setRoomService(rooms.service);
  const owner = rooms.human,
    recipient = rooms.authors.human(viewerUser).id;
  const room = rooms.service.createRoom(
    { kind: 'channel', title: 'Fixture scope', members: [], agentPaths: [] },
    owner
  );
  rooms.service.addMember(room.id, owner, { authorId: recipient });
  const capture = async (
    cookie: string,
    requestedOrigin: string | null = origin,
    requestedHost = host
  ) => {
    let incoming = request(target.server)
      .post('/api/capture')
      .set('Cookie', cookie)
      .set('Host', requestedHost);
    if (requestedOrigin !== null) incoming = incoming.set('Origin', requestedOrigin);
    const result = await incoming.send({});
    expect(result.status).toBe(200);
    return captures.at(-1)!;
  };
  const ownerRequest = await capture(cookieOwner),
    recipientRequest = await capture(cookieViewer);
  expect(resolveCaller(ownerRequest.req, ownerRequest.res).id).toBe(owner);
  expect(resolveCaller(recipientRequest.req, recipientRequest.res).id).toBe(recipient);
  const page = fakePage(),
    callbacks = new Map<string, (...values: unknown[]) => void>();
  let contextClosed = false;
  source.launch.mockResolvedValue({
    pages: () => [page.page],
    newPage: async () => page.page,
    on: (name: string, callback: (...values: unknown[]) => void) => callbacks.set(name, callback),
    close: async () => {
      contextClosed = true;
      callbacks.get('close')?.();
    },
  });
  const config = configuration();
  config.dataDir = path.join(home, 'browser');
  config.processes.observe = async () => ({
    status: contextClosed ? 'dead' : 'alive',
  });
  const registry = new BrowserRegistry(
    new BrowserRegistryStore(db, 'input-route-composition'),
    () => true
  );
  const requireMembership = rooms.service.requireMembership.bind(rooms.service);
  const grants = (originals.grants = new OwnedBrowserGrants(
    registry,
    (actor, attachment) => {
      if (attachment.kind !== 'room') return false;
      try {
        requireMembership(attachment.roomId, actor);
        return true;
      } catch {
        return false;
      }
    },
    () => true
  ));
  const input = (originals.input = new BrowserControllerInput());
  const engine: BrowserLifecycleEngine = (originals.engine = constructOwnedBrowserEngine(
    config,
    Object.freeze({
      ...grants.birthOwner(owner, { mode: 'ephemeral' }, undefined, input.owner),
      ...(navigation ? { navigation: navigation.owner } : {}),
    })
  ));
  const originalListTabs = engine.listTabs.bind(engine);
  grants.bindEngine(engine);
  const identities = (originals.identities = new BrowserControllerIdentities());
  let originalResetEntered: (() => void) | undefined;
  const resetInput = engine.resetInput.bind(engine);
  const controllerEngine = Object.freeze({
    listTabs: originalListTabs,
    resetInput: (...args: Parameters<typeof resetInput>) => {
      const original = resetInput(...args);
      // Observe the original producer after its synchronous barrier/counter publication.
      originalResetEntered?.();
      return original;
    },
  });
  const controller = new OwnedBrowserController(registry, controllerEngine, () => enabled, grants);
  grants.bindController(controller);
  const control = new BrowserControllerHost(controller, identities, grants);
  input.bindHost(control);
  // Scalar causal evidence only; every check and producer remains the captured original.
  const admission: string[] = [];
  const settledInput: Array<{
    outcome: string;
    reason: string | null;
    bindingChanged: boolean;
    mouseCalls: number;
  }> = [];
  const refusal = (error: unknown) =>
    error instanceof BrowserApiRefusal ? error.reason : 'unexpected';
  let callerSignal: AbortSignal | undefined;
  const publications: Promise<void>[] = [];
  let afterInput: (() => void) | undefined;
  const originalCapture = input.capture.bind(input);
  input.capture = (...args: Parameters<typeof originalCapture>) => {
    admission.push('input-capture');
    const publication = args[3]?.();
    if (publication) {
      publications.push(publication);
      void publication.catch(() => {});
    }
    const actual = originalCapture(...args),
      originalInput = actual.input.bind(actual);
    const originalRequest = authenticationPhase.getStore();
    if (originalRequest) originalRequest.inputCaptured = true;
    return Object.freeze({
      input: (...inputArgs: Parameters<typeof originalInput>) => {
        callerSignal = inputArgs[3];
        admission.push('original-input-enter');
        return originalInput(...inputArgs).then(
          (result) => {
            admission.push('original-input-return');
            const callback = afterInput;
            afterInput = undefined;
            callback?.();
            originalInputUncertain ||= result.outcome === 'uncertain';
            const command = BrowserInputRequestSchema.parse(inputArgs[0]);
            settledInput.push({
              outcome: result.outcome,
              reason: 'reason' in result ? (result.reason ?? null) : null,
              bindingChanged: (Object.keys(command.binding) as (keyof BrowserBinding)[]).some(
                (key) => result.binding[key] !== command.binding[key]
              ),
              mouseCalls: page.raw.mouse.move.mock.calls.length,
            });
            return result;
          },
          (error: unknown) => {
            admission.push('original-input-refusal:' + refusal(error));
            throw error;
          }
        );
      },
    });
  };
  const responses: Response[] = [];
  let originalEndEntries = 0;
  let originalEndStatus: number | undefined;
  let finishRemovalEntries = 0;
  let finishRemovalFailure: Readonly<{ value: unknown }> | undefined;
  let nextPolicy: (() => void) | undefined;
  let reentrantClose: Promise<void> | undefined;
  let destroyFailure: Readonly<{ value: unknown }> | undefined;
  let beforePublish: ((req: Request, res: Response) => void) | undefined;
  app.use('/api/private-browser-input', (req, res, next) => {
    responses.push(res);
    const off = res.off.bind(res);
    res.off = new Proxy(res.off, {
      apply(_target, _receiver, args) {
        const returned = Reflect.apply(off, undefined, args);
        if (args[0] === 'finish') {
          finishRemovalEntries++;
          if (finishRemovalFailure) {
            const failure = finishRemovalFailure;
            finishRemovalFailure = undefined;
            throw failure.value;
          }
        }
        return returned;
      },
    });
    const end = res.end.bind(res);
    res.end = new Proxy(res.end, {
      apply(_target, _receiver, args) {
        originalEndEntries++;
        if (originalEndStatus !== undefined) {
          res.statusCode = originalEndStatus;
          originalEndStatus = undefined;
        }
        return Reflect.apply(end, undefined, args);
      },
    });
    const destroy = res.destroy.bind(res);
    res.destroy = new Proxy(res.destroy, {
      apply(_target, _receiver, args) {
        const result = Reflect.apply(destroy, undefined, args);
        if (destroyFailure) {
          const original = destroyFailure;
          destroyFailure = undefined;
          throw original.value;
        }
        return result;
      },
    });
    const header = res.setHeader.bind(res);
    res.setHeader = new Proxy(res.setHeader, {
      apply(_target, _receiver, args) {
        const returned = Reflect.apply(header, undefined, args);
        if (args[0] === 'Content-Length' && beforePublish) {
          const mutate = beforePublish;
          beforePublish = undefined;
          mutate(req, res);
        }
        return returned;
      },
    });
    next();
  });
  const routes = (originals.routes = new BrowserInputRoutes(input, control, () => {
    admission.push('origin-policy-availability');
    const callback = nextPolicy;
    nextPolicy = undefined;
    callback?.();
    return enabled;
  }));
  app.use('/api/private-browser-input', routes.router);
  const opened: Extract<BrowserResult, { kind: 'opened' }> = await engine.open({
    kind: 'open',
    requestId,
    mode: 'ephemeral',
  });
  // Actual original owner takes control out of band; /input never mints a controller or grant.
  const seat = await control.capture(ownerRequest.req, ownerRequest.res).takeover(opened.tab);
  expect(seat.status).toBe('ready');
  const ownerAuth = identities.capture(ownerRequest.req, ownerRequest.res);
  await ownerAuth.refresh();
  const issueGrant = (
    permissions: Parameters<OwnedBrowserGrants['issue']>[4],
    binding: BrowserBinding = seat.binding
  ) =>
    grants.issue(
      ownerAuth.current,
      binding,
      recipient,
      { kind: 'room', roomId: room.id },
      permissions,
      new Date(Date.now() + 60000).toISOString()
    );
  // The original fake Page owns a 100×80 CSS viewport; keep entered input inside it.
  const command = (steps: unknown = [{ kind: 'mouseMove', x: 32, y: 36 }]) => ({
    kind: 'input',
    requestId,
    binding: seat.binding,
    steps,
  });
  const send = (
    body: unknown,
    cookie = cookieOwner,
    requestedOrigin: string | null = origin,
    requestedHost = host
  ) => {
    let call = request(target.server)
      .post('/api/private-browser-input/input')
      .set('Cookie', cookie)
      .set('Host', requestedHost);
    if (requestedOrigin !== null) call = call.set('Origin', requestedOrigin);
    // Negative fixtures intentionally pass unvalidated bodies through the real HTTP client.
    return call.send(body as Parameters<typeof call.send>[0]);
  };
  const holdFreshAuth = () => {
    const auth = getAuth()!,
      original = auth.api.getSession;
    let release!: () => void,
      entered = 0,
      beforeRouteEntered = 0,
      sixteen!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered16 = new Promise<void>((resolve) => {
      sixteen = resolve;
    });
    releases.push(release);
    const delayed = new Proxy(original, {
      apply(target, receiver, args) {
        const originalResult = Reflect.apply(target, receiver, args);
        if (args[0]?.query?.disableCookieCache !== true) return originalResult;
        // A mutating POST must complete its genuine server-store session gate before
        // the input router can reserve capacity. Only route-owned originals are held.
        if (!authenticationPhase.getStore()?.inputCaptured) {
          beforeRouteEntered++;
          return originalResult;
        }
        return Promise.resolve(originalResult).then(async (actual) => {
          entered++;
          if (entered === 16) sixteen();
          await held;
          return actual;
        });
      },
    });
    const observer = vi.spyOn(auth.api, 'getSession').mockImplementation(delayed);
    restores.push(() => observer.mockRestore());
    return {
      release,
      entered16,
      entered: () => entered,
      beforeRouteEntered: () => beforeRouteEntered,
    };
  };
  const canvasScope: {
    db: Db;
    roomId: string;
    owner: string;
    recipient: string;
    authors: ReturnType<typeof createRoomHarness>['authors'];
  } = { db, roomId: room.id, owner, recipient, authors: rooms.authors };
  return {
    canvasScope,
    canvasHttp: { app, server: target.server },
    admission,
    publications,
    afterOriginalInput: (callback: () => void) => {
      afterInput = callback;
    },
    settledInput,
    routes,
    input,
    engine,
    controller,
    onOriginalReset: (callback: (() => void) | undefined) => {
      originalResetEntered = callback;
    },
    registry,
    identities,
    control,
    page,
    opened,
    seat,
    command,
    send,
    cookieOwner,
    cookieViewer,
    cookieOtherViewer,
    origin,
    host,
    responses,
    releases,
    ownerAuth,
    ownerRequest,
    issueGrant,
    grants,
    recipientRequest,
    holdFreshAuth,
    originalEndEntries: () => originalEndEntries,
    respondWithOriginalEndStatus: (status: number) => {
      originalEndStatus = status;
    },
    finishRemovalEntries: () => finishRemovalEntries,
    refuseFinishRemoval: (value: unknown) => {
      finishRemovalFailure = Object.freeze({ value });
    },
    closeDuringNextPolicy: () => {
      nextPolicy = () => {
        reentrantClose = routes.close();
        // Observe immediately because the original can reject before HTTP returns;
        // retain its exact Promise for the body's identity assertion and finalizer.
        void reentrantClose.catch(() => undefined);
      };
    },
    reentrantClose: () => reentrantClose,
    expectRetiredControllerInputCleanup: () => {
      // Require actual started native uncertainty and its original stopped-engine fence.
      if (!originalInputUncertain || page.raw.mouse.move.mock.calls.length !== 1)
        throw new Error('expected-original-input-uncertainty-not-observed');
      try {
        originalListTabs(opened.browserId, opened.browserGeneration);
      } catch (error) {
        if (error instanceof BrowserLifecycleError && error.code === 'BROWSER_STOPPED') {
          expectedTerminal = 'retired-controller-input';
          return;
        }
        throw error;
      }
      throw new Error('expected-original-terminal-fence-not-observed');
    },
    acceptFailure: (value: unknown) => acceptedFailures.add(value),
    refuseAbort: (value: unknown) => {
      const original = AbortController.prototype.abort;
      const observer = vi.spyOn(AbortController.prototype, 'abort').mockImplementation(function (
        this: AbortController,
        reason?: unknown
      ) {
        const result = Reflect.apply(original, this, [reason]);
        if (this.signal === callerSignal) throw value;
        return result;
      });
      restores.push(() => observer.mockRestore());
    },
    refuseDestroy: (value: unknown) => {
      destroyFailure = Object.freeze({ value });
    },
    mutateBeforePublish: (mutate: (req: Request, res: Response) => void) => {
      beforePublish = mutate;
    },
    disable: () => {
      enabled = false;
    },
  };
}

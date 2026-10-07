import { mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import type { Request, Response as ExpressResponse } from 'express';
import { createProductionBrowserRuntimeRoutes } from '../runtime-routes.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, session, authors, browserProfiles } from '@dorkos/db';
import { eq } from 'drizzle-orm';
import { AuthorRegistry } from '../../../rooms/author-registry.js';
import { findOwnerAccount } from '../../../core/auth/accounts.js';
import { BrowserProductionOpenRequestSchema } from '@dorkos/shared/browser-schemas';
import { expect, it, onTestFinished, vi } from 'vitest';
import { createAuth } from '../../../core/auth/index.js';
import { ConfigManager } from '../../../core/config-manager.js';
import { createActivationAuthentication } from '../activation/activation-auth.js';
import { mintProductionBrowserEnablePermit } from '../activation/activation-permit.js';
import { BrowserRegistryStore } from '../../registry/store.js';
import { createProductionBrowserStartupMode, isOriginalStartupRefusal } from '../startup-mode.js';

function fixture() {
  type Result = {
    config: ConfigManager;
    db: ReturnType<typeof createDb>;
    auth: ReturnType<typeof createAuth>;
    cookie: string;
    beforeDispose(duty: () => Promise<unknown> | void): void;
  };
  const originals: {
    home?: string;
    acquisition?: Promise<string>;
    db?: ReturnType<typeof createDb>;
    setup?: Promise<Result>;
    signup?: Promise<Response>;
  } = {};
  const participants: Array<() => Promise<unknown> | void> = [];
  let closed = false;
  const admissionClosed = new Error('FIXTURE_ADMISSION_CLOSED');
  const guard = () => {
    if (closed) throw admissionClosed;
  };
  onTestFinished(async () => {
    closed = true;
    let failure: Readonly<{ value: unknown }> | undefined;
    const setup = originals.setup,
      signup = originals.signup,
      acquisition = originals.acquisition;
    const joined = await Promise.allSettled([
      ...(setup ? [setup] : []),
      ...(signup ? [signup] : []),
      ...(acquisition ? [acquisition] : []),
    ]);
    for (const result of joined)
      if (result.status === 'rejected' && result.reason !== admissionClosed)
        failure ??= { value: result.reason };
    // Participant mode/auth/schema originals return before SQLite/home disposal, regardless of
    // Vitest finalizer ordering. Admission is already closed, so no late participant can enter.
    for (const duty of participants) {
      try {
        await duty();
      } catch (value) {
        failure ??= { value };
      }
    }
    try {
      originals.db?.$client.close();
    } catch (value) {
      failure ??= { value };
    }
    try {
      if (originals.acquisition) originals.home ??= await originals.acquisition;
      if (originals.home) await rm(originals.home, { recursive: true, force: true });
    } catch (value) {
      failure ??= { value };
    }
    if (failure) throw failure.value;
  });
  // The whole setup is admitted before any filesystem/auth producer can enter.
  originals.setup = Promise.resolve().then(async () => {
    guard();
    originals.acquisition = mkdtemp(join(tmpdir(), 'browser-activation-auth-'));
    originals.home = await originals.acquisition;
    guard();
    const config = new ConfigManager(originals.home);
    config.set('auth', { enabled: true });
    guard();
    originals.db = createDb(join(originals.home, 'fixture.db'));
    const db = originals.db;
    runMigrations(db);
    guard();
    const auth = createAuth(db, originals.home);
    guard();
    originals.signup = auth.api.signUpEmail({
      body: {
        name: 'Fixture owner',
        email: 'fixture@dork.test',
        password: 'fixture-password-not-personal',
      },
      asResponse: true,
    });
    const response = await originals.signup;
    guard();
    expect(response.status).toBe(200);
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    guard();
    return {
      config,
      db,
      auth,
      cookie,
      beforeDispose(duty: () => Promise<unknown> | void) {
        guard();
        participants.push(duty);
      },
    };
  });
  return originals.setup;
}

it('original configuration getter revocation precedes final actual SQLite credential observation', async () => {
  const f = await fixture(),
    originalGet = f.config.get.bind(f.config);
  let revoke = false;
  const spy = vi.spyOn(f.config, 'get').mockImplementation(((
    key: Parameters<ConfigManager['get']>[0]
  ) => {
    const value = originalGet(key);
    if (key === 'auth' && revoke) f.db.delete(session).run();
    return value;
  }) as ConfigManager['get']);
  f.beforeDispose(() => spy.mockRestore());
  const authenticate = createActivationAuthentication(
    f.db,
    f.config,
    () => f.auth,
    () => true
  );
  const current = await authenticate(f.cookie, new AbortController().signal);
  expect(current()).toBe(true);
  revoke = true;
  expect(current()).toBe(false);
  expect(f.db.select().from(session).all()).toHaveLength(0);
});

it.each(['close', 'abort'] as const)(
  'does not enter unstarted original auth producer after immediate %s',
  async (choice) => {
    const f = await fixture(),
      originalGetSession = f.auth.api.getSession.bind(f.auth.api);
    const getSession = vi.spyOn(f.auth.api, 'getSession').mockImplementation(originalGetSession);
    f.beforeDispose(() => getSession.mockRestore());
    const mode = createProductionBrowserStartupMode({
      db: f.db,
      auth: f.auth,
      config: f.config,
      inventory: {} as Parameters<typeof createProductionBrowserStartupMode>[0]['inventory'],
    });
    const originals: { capture?: Promise<unknown>; close?: Promise<void> } = {};
    f.beforeDispose(async () => {
      originals.close ??= mode.close();
      const results = await Promise.allSettled(Object.values(originals));
      for (const result of results)
        if (result.status === 'rejected' && !isOriginalStartupRefusal(result.reason))
          throw result.reason;
    });
    const controller = new AbortController();
    originals.capture = mode.captureOwner({ cookie: f.cookie }, controller.signal);
    void originals.capture.catch(() => {});
    if (choice === 'close') originals.close = mode.close();
    else controller.abort();
    const result = await Promise.allSettled([originals.capture]);
    expect(result[0]!.status).toBe('rejected');
    expect(getSession).not.toHaveBeenCalled();
    originals.close ??= mode.close();
    await originals.close;
  }
);

it('original auth configuration getter can close inside the producer fence without sending auth', async () => {
  const f = await fixture(),
    originalGet = f.config.get.bind(f.config),
    originalGetSession = f.auth.api.getSession.bind(f.auth.api);
  const originals: { capture?: Promise<unknown>; close?: Promise<void> } = {};
  const owners: { mode?: ReturnType<typeof createProductionBrowserStartupMode> } = {};
  let armed = false,
    authReads = 0;
  const getSession = vi.spyOn(f.auth.api, 'getSession').mockImplementation(originalGetSession);
  const getter = vi.spyOn(f.config, 'get').mockImplementation(((
    key: Parameters<ConfigManager['get']>[0]
  ) => {
    const value = originalGet(key);
    if (armed && key === 'auth' && ++authReads === 2) {
      originals.close = owners.mode!.close();
      void originals.close.catch(() => {});
    }
    return value;
  }) as ConfigManager['get']);
  f.beforeDispose(async () => {
    let failure: Readonly<{ value: unknown }> | undefined;
    if (owners.mode) originals.close ??= owners.mode.close();
    const results = await Promise.allSettled(Object.values(originals));
    for (const result of results)
      if (result.status === 'rejected' && !isOriginalStartupRefusal(result.reason))
        failure ??= { value: result.reason };
    for (const restore of [() => getter.mockRestore(), () => getSession.mockRestore()]) {
      try {
        restore();
      } catch (value) {
        failure ??= { value };
      }
    }
    if (failure) throw failure.value;
  });
  owners.mode = createProductionBrowserStartupMode({
    db: f.db,
    auth: f.auth,
    config: f.config,
    inventory: {} as Parameters<typeof createProductionBrowserStartupMode>[0]['inventory'],
  });
  armed = true;
  originals.capture = owners.mode.captureOwner({ cookie: f.cookie }, new AbortController().signal);
  void originals.capture.catch(() => {});
  const result = await Promise.allSettled([originals.capture]);
  expect(authReads).toBe(2);
  expect(result[0]!.status).toBe('rejected');
  expect(getSession).not.toHaveBeenCalled();
  expect(originals.close).toBeDefined();
  await originals.close;
});

it('creates exact authenticated owner metadata without a browser birth and refuses a revoked session', async () => {
  const f = await fixture();
  const owners: { mode?: ReturnType<typeof createProductionBrowserStartupMode> } = {};
  const originals: {
    created?: Promise<unknown>;
    actor?: Promise<unknown>;
    revoked?: Promise<unknown>;
    close?: Promise<void>;
  } = {};
  f.beforeDispose(async () => {
    if (owners.mode) originals.close ??= owners.mode.close();
    const results = await Promise.allSettled(Object.values(originals));
    for (const result of results)
      if (result.status === 'rejected' && !isOriginalStartupRefusal(result.reason))
        throw result.reason;
  });
  const localAuthor = new AuthorRegistry(f.db).localHuman(),
    account = findOwnerAccount(f.db);
  if (!account) throw new Error('FIXTURE_ORIGINAL_OWNER_MISSING');
  f.config.enableOwnedBrowser(mintProductionBrowserEnablePermit(f.config, () => true));
  owners.mode = createProductionBrowserStartupMode({
    db: f.db,
    auth: f.auth,
    config: f.config,
    inventory: {} as Parameters<typeof createProductionBrowserStartupMode>[0]['inventory'],
  });
  const request = { requestId: 'request_profile_create_0000001', label: 'Work account' };
  originals.created = owners.mode.createProfile(
    { cookie: f.cookie },
    request,
    new AbortController().signal
  );
  const receipt = (await originals.created) as Awaited<
    ReturnType<typeof owners.mode.createProfile>
  >;
  originals.actor = owners.mode.captureOwner({ cookie: f.cookie }, new AbortController().signal);
  const actor = (await originals.actor) as Awaited<
    ReturnType<NonNullable<typeof owners.mode>['captureOwner']>
  >;
  expect(receipt.requestId).toBe(request.requestId);
  expect(actor.ownerId).toBe(localAuthor.id);
  expect(actor.ownerId).not.toBe(account.id);
  expect(new AuthorRegistry(f.db).isOwner(actor.ownerId, account.id)).toBe(true);
  expect(f.db.select().from(browserProfiles).get()?.ownerAuthorId).toBe(actor.ownerId);
  expect(owners.mode.store.profiles(account.id)).toEqual([]);
  const persistent = {
    workspaceId: 'workspace_reference_000000001',
    request: {
      requestId: 'request_profile_open_00000001',
      mode: 'persistent' as const,
      profileId: receipt.profile.profileId,
    },
  };
  expect(BrowserProductionOpenRequestSchema.parse(persistent)).toEqual(persistent);
  expect(() =>
    BrowserProductionOpenRequestSchema.parse({
      ...persistent,
      request: { ...persistent.request, path: '/caller-owned-path' },
    })
  ).toThrow();
  expect(owners.mode.store.profiles(actor.ownerId)).toEqual([receipt.profile]);
  expect(owners.mode.store.rows()).toEqual([]);
  const originalAuthor = f.db.select().from(authors).where(eq(authors.id, actor.ownerId)).get();
  if (!originalAuthor) throw new Error('FIXTURE_ORIGINAL_AUTHOR_MISSING');
  f.db
    .update(authors)
    .set({ naturalKey: 'foreign-owner-mapping' })
    .where(eq(authors.id, actor.ownerId))
    .run();
  expect(actor()).toBe(false);
  f.db.delete(session).run();
  originals.revoked = owners.mode.createProfile(
    { cookie: f.cookie },
    { ...request, requestId: 'request_profile_revoke_0000001' },
    new AbortController().signal
  );
  const result = await Promise.allSettled([originals.revoked]);
  expect(result[0]!.status).toBe('rejected');
  expect(owners.mode.store.profiles(actor.ownerId)).toHaveLength(1);
  originals.close = owners.mode.close();
  await originals.close;
});

it.each([undefined, false])(
  'joins original metadata insertion failure %s and preserves it through mode close',
  async (reason) => {
    const f = await fixture();
    const originalCreate = BrowserRegistryStore.prototype.createProfile;
    const originals: { create?: Promise<unknown>; close?: Promise<void> } = {};
    const owners: {
      mode?: ReturnType<typeof createProductionBrowserStartupMode>;
      restore?: () => void;
    } = {};
    f.beforeDispose(async () => {
      let failure: Readonly<{ value: unknown }> | undefined;
      try {
        if (owners.mode) originals.close ??= owners.mode.close();
        const results = await Promise.allSettled(Object.values(originals));
        for (const result of results)
          if (result.status === 'rejected' && !Object.is(result.reason, reason))
            failure ??= { value: result.reason };
      } catch (value) {
        if (!Object.is(value, reason)) failure ??= { value };
      }
      try {
        owners.restore?.();
      } catch (value) {
        failure ??= { value };
      }
      if (failure) throw failure.value;
    });
    f.config.enableOwnedBrowser(mintProductionBrowserEnablePermit(f.config, () => true));
    const insertion = vi
      .spyOn(BrowserRegistryStore.prototype, 'createProfile')
      .mockImplementation(function (this: BrowserRegistryStore, owner, label) {
        Reflect.apply(originalCreate, this, [owner, label]);
        throw reason;
      });
    owners.restore = () => insertion.mockRestore();
    owners.mode = createProductionBrowserStartupMode({
      db: f.db,
      auth: f.auth,
      config: f.config,
      inventory: {} as Parameters<typeof createProductionBrowserStartupMode>[0]['inventory'],
    });
    originals.create = owners.mode.createProfile(
      { cookie: f.cookie },
      { requestId: 'request_profile_create_0000001', label: 'Work account' },
      new AbortController().signal
    );
    void originals.create.catch(() => {});
    await expect(originals.create).rejects.toBe(reason);
    expect(insertion).toHaveBeenCalledOnce();
    originals.close = owners.mode.close();
    await expect(originals.close).rejects.toBe(reason);
    expect(owners.mode.store.rows()).toEqual([]);
  }
);

// Consume the actual mode's WeakSet-minted refusals and actual mounted route handlers.
// SQLite/auth/profile effects remain real; no browser/native acquisition is needed.
it.each(['unknown-binding', 'stale-generation', 'profile-capacity'] as const)(
  'a genuine %s refusal leaves the next valid profile request available',
  async (scenario) => {
    const f = await fixture();
    f.config.enableOwnedBrowser(mintProductionBrowserEnablePermit(f.config, () => true));
    const mode = createProductionBrowserStartupMode({
      db: f.db,
      auth: f.auth,
      config: f.config,
      inventory: {} as Parameters<typeof createProductionBrowserStartupMode>[0]['inventory'],
    });
    const routes = createProductionBrowserRuntimeRoutes(mode);
    f.beforeDispose(() => routes.close());
    const actor = await mode.captureOwner({ cookie: f.cookie }, new AbortController().signal);
    let removable: string | undefined;
    if (scenario === 'profile-capacity') {
      for (let i = 0; i < 64; i++)
        removable = mode.store.createProfile(actor.ownerId, `Profile ${i}`).profileId;
    }
    const submit = (path: string, body: unknown) => {
      const layer = routes.router.stack.find((entry) => entry.route?.path === path)!;
      const handler = layer.route!.stack[0]!.handle;
      const req = Object.assign(new EventEmitter(), {
        headers: { cookie: f.cookie, host: 'localhost:4242', origin: 'http://localhost:4242' },
        socket: { encrypted: false },
        method: 'POST',
        body,
        aborted: false,
      });
      let returned!: (value: { status: number; body: Record<string, unknown> }) => void;
      const published = new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve) => {
          returned = resolve;
        }
      );
      const res = Object.assign(new EventEmitter(), {
        destroyed: false,
        writableEnded: false,
        writableFinished: false,
        finished: false,
        writable: true,
        statusCode: 200,
        status(code: number) {
          this.statusCode = code;
          return this;
        },
        type() {
          return this;
        },
        destroy() {
          this.destroyed = true;
          return this;
        },
        end(bytes: Buffer, done: (reason?: unknown) => void) {
          const body = JSON.parse(bytes.toString()) as Record<string, unknown>;
          done();
          returned({ status: this.statusCode, body });
          return this;
        },
      });
      handler(req as unknown as Request, res as unknown as ExpressResponse, () => {});
      return published;
    };
    const profileRequest = {
      requestId: 'request_profile_refusal_00001',
      label: 'Valid after refusal',
    };
    const refusal =
      scenario === 'profile-capacity'
        ? await submit('/runtime/profiles', profileRequest)
        : await submit('/runtime/navigate', {
            controllerId: 'controller_reference_0000001',
            command: {
              requestId: 'request_navigate_refusal_0001',
              kind: 'navigate',
              url: 'https://example.com',
              binding: {
                browserId: 'browser_reference_missing001',
                browserGeneration: scenario === 'stale-generation' ? 1 : 0,
                tabId: 'tab_reference_missing_000001',
                navigationGeneration: 0,
                viewportVersion: 0,
                epoch: 0,
                inputGeneration: 0,
              },
            },
          });
    expect(refusal.status).toBe(503);
    expect(refusal.body).toHaveProperty('error');
    if (removable)
      f.db.delete(browserProfiles).where(eq(browserProfiles.profileId, removable)).run();
    const successful = await submit('/runtime/profiles', profileRequest);
    expect(successful.status).toBe(200);
    expect(successful.body.requestId).toBe(profileRequest.requestId);
    expect(successful.body.profile).toMatchObject({ label: profileRequest.label });
    expect(await mode.captureOwner({ cookie: f.cookie }, new AbortController().signal)).toEqual(
      expect.any(Function)
    );
  }
);

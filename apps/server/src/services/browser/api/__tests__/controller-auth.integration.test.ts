import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Request, Response } from 'express';
import { createDb, runMigrations, session, eq } from '@dorkos/db';
import { expect, it, onTestFinished, vi } from 'vitest';
import { initAuth } from '../../../core/auth/index.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { verifyRequestAuth } from '../../../core/auth/session-gate.js';
import { AuthSessionRemovals, authSessionRemovals } from '../../../core/auth/session-removals.js';
import { BrowserControllerIdentities } from '../controller-auth.js';
import { BrowserApiRefusal } from '../service.js';

// Author resolution is unrelated to session custody; use the verified account as the author.
vi.mock('../../../../routes/room-caller.js', () => ({
  resolveCaller: (_req: unknown, res: Response) => ({
    kind: 'human',
    id: res.locals.user.userId,
  }),
}));

it('actual sign-out revokes only its retained identity and close joins the original held loss', async () => {
  const home = await mkdtemp(join(tmpdir(), 'browser-controller-auth-'));
  const db = createDb(join(home, 'auth.db'));
  runMigrations(db);
  const config = initConfigManager(home);
  config.set('auth', { enabled: true });
  const auth = initAuth(db, home);
  const identities = new BrowserControllerIdentities();
  onTestFinished(async () => {
    try {
      await identities.close();
    } finally {
      db.$client.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  const signup = await auth.api.signUpEmail({
    body: {
      email: 'controller@dork.test',
      name: 'Owner',
      password: 'fixture-password-only',
    },
    asResponse: true,
  });
  expect(signup.status).toBe(200);
  const cookie = (response: globalThis.Response) =>
    response.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
  const firstCookie = cookie(signup);
  const other = await auth.api.signInEmail({
    body: { email: 'controller@dork.test', password: 'fixture-password-only' },
    asResponse: true,
  });
  const secondCookie = cookie(other);
  const capture = async (value: string) => {
    const req = { headers: { cookie: value }, ip: '127.0.0.1' } as Request;
    const user = await verifyRequestAuth(req, {
      sessionFreshness: 'server-store',
      sessionFailure: 'propagate',
    });
    expect(user).toBeDefined();
    // This fixture supplies only the locals read by the identity capture.
    const result = identities.capture(req, {
      locals: { user },
    } as unknown as Response);
    return { result, actor: await result.refresh() };
  };
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const revoke = vi.fn(() => held);
  identities.bindController({ revokeController: revoke });
  const first = await capture(firstCookie),
    second = await capture(secondCookie);
  expect(first.actor.controllerIdentity).not.toBe(second.actor.controllerIdentity);
  const removals: Array<{ sessionId: string; userId: string }> = [];
  const unsubscribe = authSessionRemovals.subscribe((value) => {
    expect(db.select().from(session).where(eq(session.id, value.sessionId)).get()).toBeUndefined();
    removals.push(value);
  });
  try {
    await auth.api.signOut({ headers: new Headers({ cookie: firstCookie }) });
    expect(removals).toHaveLength(1);
    expect(first.result.current()).toBeUndefined();
    expect(second.result.current()).toBe(second.actor);
    expect(revoke).toHaveBeenCalledExactlyOnceWith(first.actor.controllerIdentity);
    expect(identities.pendingLosses()).toBe(1);
    await expect(first.result.refresh()).rejects.toMatchObject({
      reason: 'unauthenticated',
    });
    let closed = false;
    const closing = identities.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
  } finally {
    release();
    unsubscribe();
  }
});

it.each([undefined, false])(
  'private removal drains subscribers and preserves original %s failure',
  (original) => {
    const bus = new AuthSessionRemovals(),
      later = vi.fn();
    bus.subscribe(() => {
      throw original;
    });
    bus.subscribe(later);
    let caught = false,
      failure: unknown;
    try {
      bus.remove({ sessionId: 'private-session', userId: 'private-owner' });
    } catch (value) {
      caught = true;
      failure = value;
    }
    expect(caught).toBe(true);
    expect(failure).toBe(original);
    expect(later).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'private-session',
      userId: 'private-owner',
    });
  }
);

it.each(['returned', 'undefined', 'false', 'typed-producer'] as const)(
  'joins a held original session producer during identity closure: %s',
  async (outcome) => {
    const home = await mkdtemp(join(tmpdir(), 'browser-controller-close-auth-'));
    const db = createDb(join(home, 'auth.db'));
    runMigrations(db);
    initConfigManager(home).set('auth', { enabled: true });
    const auth = initAuth(db, home);
    const identities = new BrowserControllerIdentities(new AuthSessionRemovals());
    const producerFailure =
      outcome === 'undefined'
        ? undefined
        : outcome === 'false'
          ? false
          : new BrowserApiRefusal('unauthenticated');
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const cleanup: { restore?: () => void } = {};
    onTestFinished(async () => {
      release();
      try {
        await identities.close();
      } catch (value) {
        if (outcome === 'returned' || !Object.is(value, producerFailure)) throw value;
      } finally {
        cleanup.restore?.();
        db.$client.close();
        await rm(home, { recursive: true, force: true });
      }
    });
    const signed = await auth.api.signUpEmail({
      body: {
        email: 'close-controller@dork.test',
        name: 'Owner',
        password: 'fixture-password-only',
      },
      asResponse: true,
    });
    expect(signed.status).toBe(200);
    const cookie = signed.headers
      .getSetCookie()
      .map((value) => value.split(';')[0])
      .join('; ');
    const req = { headers: { cookie }, ip: '127.0.0.1' } as Request;
    const user = await verifyRequestAuth(req, {
      sessionFreshness: 'server-store',
      sessionFailure: 'propagate',
    });
    expect(user).not.toBeNull();
    const captured = identities.capture(req, {
      locals: { user },
    } as unknown as Response);
    const original = auth.api.getSession;
    const delayed = new Proxy(original, {
      apply(target, receiver, args) {
        const originalResult = Reflect.apply(target, receiver, args);
        return Promise.resolve(originalResult).then(async (actual) => {
          entered();
          await held;
          if (outcome !== 'returned') throw producerFailure;
          return actual;
        });
      },
    });
    const observer = vi.spyOn(auth.api, 'getSession').mockImplementation(delayed);
    cleanup.restore = () => observer.mockRestore();
    const checking = captured.refresh();
    void checking.catch(() => {});
    await started;
    let settled = false;
    const closing = identities.close();
    void closing.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(captured.current()).toBeUndefined();
    release();
    if (outcome === 'returned') {
      await expect(checking).rejects.toMatchObject({
        reason: 'unauthenticated',
      });
      await expect(closing).resolves.toBeUndefined();
    } else {
      await expect(checking).rejects.toBe(producerFailure);
      await expect(closing).rejects.toBe(producerFailure);
    }
    expect(captured.current()).toBeUndefined();
  }
);

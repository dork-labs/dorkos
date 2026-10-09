import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, runMigrations, session, eq } from '@dorkos/db';
import { expect, it } from 'vitest';
import { createAuth } from '../../../core/auth/index.js';
import { initConfigManager } from '../../../core/config-manager.js';
import { createServerInventory } from '../../egress/broker/server-inventory.js';
import { createProductionBrowserStartupMode } from '../startup-mode.js';

// Actual Better Auth/SQLite and original production captureOwner, with no installed/native/browser
// setup. These controls qualify only the account-read predicate, never browser readiness or auth UI.
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

it.each(['sql-mutation', 'request-abort', 'refresh-eligible'] as const)(
  'original account capture survives repeated actual reads and refuses %s',
  async (change) => {
    const home = await mkdtemp(join(tmpdir(), 'browser-owner-auth-read-'));
    let db: ReturnType<typeof createDb> | undefined;
    let mode: ReturnType<typeof createProductionBrowserStartupMode> | undefined;
    let first: Readonly<{ value: unknown }> | undefined;
    try {
      const config = initConfigManager(home);
      config.set('auth', { enabled: true });
      db = createDb(join(home, 'dork.db'));
      runMigrations(db);
      const auth = createAuth(db, home);
      const email = ['original-owner', 'dork.test'].join('@');
      const password = 'controlled-original-owner-password';
      const signup = await auth.api.signUpEmail({
        body: { name: 'Original account fixture', email, password },
        asResponse: true,
      });
      expect(signup.status).toBe(200);
      await signup.arrayBuffer();
      const signin = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      expect(signin.status).toBe(200);
      const cookie = signin.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; ');
      await signin.arrayBuffer();
      expect(cookie).not.toBe('');
      // A real declared inventory object is sufficient for constructor composition. Nothing
      // acquires or samples a listener, enters installation, or supplies a native custody proof.
      const inventory = createServerInventory({
        instances: [{ id: 'original-owner-fixture', listeners: ['http'] }],
        adminAuthorities: [],
        now: Date.now,
      });
      mode = createProductionBrowserStartupMode({ db, auth, config, inventory });
      const authenticated = await auth.api.getSession({
        headers: new Headers({ cookie }),
        query: { disableCookieCache: true, disableRefresh: true },
      });
      expect(authenticated?.session.id).toBeDefined();
      const id = authenticated!.session.id;
      if (change === 'refresh-eligible') {
        const {
          sessionConfig: { expiresIn, updateAge },
        } = await auth.$context;
        expect(expiresIn).toBeGreaterThan(updateAge);
        const now = Date.now();
        const dueExpiry = new Date(now + (expiresIn - updateAge) * 1000 - 1000);
        expect(dueExpiry.getTime()).toBeGreaterThan(now);
        // Actual SDK refresh predicate, no fake clock or query/credential substitution.
        db.update(session)
          .set({ expiresAt: dueExpiry, updatedAt: new Date(now - updateAge * 1000 - 1000) })
          .where(eq(session.id, id))
          .run();
        expect(dueExpiry.getTime() - expiresIn * 1000 + updateAge * 1000).toBeLessThanOrEqual(now);
      }
      const before = db.select().from(session).where(eq(session.id, id)).get();
      const controller = new AbortController();
      const original = await mode.captureOwner({ cookie }, controller.signal);
      expect(original()).toBe(true);
      expect(before).toBeDefined();
      const originalDigest = digest(before);
      for (let index = 0; index < 3; index++) {
        const next = await mode.captureOwner({ cookie }, new AbortController().signal);
        expect(next()).toBe(true);
        expect(next.ownerId).toBe(original.ownerId);
        expect(original()).toBe(true);
        expect(digest(db.select().from(session).where(eq(session.id, id)).get())).toBe(
          originalDigest
        );
        expect(controller.signal.aborted).toBe(false);
      }
      if (change === 'refresh-eligible') {
        const ordinary = await auth.api.getSession({
          headers: new Headers({ cookie }),
          query: { disableCookieCache: true },
        });
        expect(ordinary?.session.id).toBe(id);
        const after = db.select().from(session).where(eq(session.id, id)).get();
        expect(after?.id).toBe(before!.id);
        expect(after!.expiresAt.getTime()).toBeGreaterThan(before!.expiresAt.getTime());
        expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
        expect(digest(after)).not.toBe(originalDigest);
      } else if (change === 'sql-mutation') {
        db.update(session)
          .set({ updatedAt: new Date(before!.updatedAt.getTime() + 1000) })
          .where(eq(session.id, id))
          .run();
        expect(digest(db.select().from(session).where(eq(session.id, id)).get())).not.toBe(
          originalDigest
        );
      } else controller.abort();
      expect(original()).toBe(false);
    } catch (value) {
      first = { value };
    } finally {
      try {
        await mode?.close();
      } catch (value) {
        first ??= { value };
      }
      try {
        db?.$client.close();
      } catch (value) {
        first ??= { value };
      }
      try {
        await rm(home, { recursive: true, force: true });
      } catch (value) {
        first ??= { value };
      }
    }
    if (first) throw first.value;
  }
);

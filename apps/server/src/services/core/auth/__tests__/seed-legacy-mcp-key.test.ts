/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createDb, runMigrations, user, apikey, eq, type Db } from '@dorkos/db';
import { getAuth, initAuth, toNodeHandler, seedLegacyMcpApiKey } from '../index.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';

const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const LEGACY_KEY = 'dork_mcp_legacy_value_1234567890';

/** Store a legacy global key at `config.mcp.apiKey`, preserving the rest of the block. */
function setLegacyKey(value: string | null): void {
  configManager.set('mcp', {
    enabled: true,
    apiKey: value,
    rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
  });
}

/** Mount the Better Auth handler as `app.ts` does, so HTTP sign-up fires its hooks. */
function buildApp(): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json({ limit: '1mb' }));
  return app;
}

describe('seedLegacyMcpApiKey — legacy MCP key migration (task 1.4)', () => {
  let tmpDir: string;
  let db: Db;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-seed-'));
    initConfigManager(tmpDir);
    db = createDb(path.join(tmpDir, 'seed-test.db'));
    runMigrations(db);
    initAuth(db, tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create the owner directly so tests that are not about the HTTP hook stay simple. */
  async function createOwner(): Promise<string> {
    const app = buildApp();
    const res = await request(app)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME });
    expect(res.status).toBe(200);
    return db.select().from(user).get()!.id;
  }

  it('is a no-op when there is no legacy key', async () => {
    await createOwner();
    setLegacyKey(null);
    await seedLegacyMcpApiKey(db);
    expect(db.select().from(apikey).all()).toHaveLength(0);
  });

  it('is a no-op when no owner exists (keeps the legacy key for the compat window)', async () => {
    setLegacyKey(LEGACY_KEY);
    await seedLegacyMcpApiKey(db);
    // No owner to own the key: nothing seeded and the legacy value is preserved.
    expect(db.select().from(apikey).all()).toHaveLength(0);
    expect(configManager.get('mcp')?.apiKey).toBe(LEGACY_KEY);
  });

  it('seeds the legacy key as an owner-owned Better Auth key and clears config', async () => {
    const ownerId = await createOwner();
    setLegacyKey(LEGACY_KEY);

    await seedLegacyMcpApiKey(db);

    // The exact legacy value now verifies as an owner-owned key.
    const verified = await getAuth()!.api.verifyApiKey({ body: { key: LEGACY_KEY } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(ownerId);

    // The legacy config value is cleared in the same operation.
    expect(configManager.get('mcp')?.apiKey).toBeNull();

    // Exactly one row was created for the owner.
    expect(db.select().from(apikey).where(eq(apikey.referenceId, ownerId)).all()).toHaveLength(1);
  });

  it('creates no duplicate when the seed runs twice for the same key', async () => {
    const ownerId = await createOwner();
    setLegacyKey(LEGACY_KEY);

    await seedLegacyMcpApiKey(db);
    // Re-arm the legacy value to force a second attempt: the hashed-key guard must
    // skip the insert even though config was reset back to the same value.
    setLegacyKey(LEGACY_KEY);
    await seedLegacyMcpApiKey(db);

    expect(db.select().from(apikey).where(eq(apikey.referenceId, ownerId)).all()).toHaveLength(1);
    expect(configManager.get('mcp')?.apiKey).toBeNull();
  });

  it('seeds automatically when the owner is created (owner-creation hook)', async () => {
    // Legacy key present before any owner exists (the upgrade-then-enable-login case).
    setLegacyKey(LEGACY_KEY);

    // Creating the owner via the real sign-up endpoint fires the after-hook.
    const ownerId = await createOwner();

    const verified = await getAuth()!.api.verifyApiKey({ body: { key: LEGACY_KEY } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.referenceId).toBe(ownerId);
    expect(configManager.get('mcp')?.apiKey).toBeNull();
  });
});

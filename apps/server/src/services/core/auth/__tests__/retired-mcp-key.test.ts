/**
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import { createDb, runMigrations, user, apikey, type Db } from '@dorkos/db';
import { getAuth, initAuth, toNodeHandler } from '../index.js';
import { configManager, initConfigManager } from '../../config-manager.js';
import { env } from '../../../../env.js';

const DOMAIN = 'dork.test';
const OWNER_EMAIL = 'owner' + '@' + DOMAIN;
const OWNER_PASSWORD = 'correct-horse-battery-staple';
const OWNER_NAME = 'Owner';
const ORIGIN = `http://localhost:${env.DORKOS_PORT}`;
const LEGACY_KEY = 'dork_mcp_legacy_value_1234567890';
const requestTarget = swappableServer();

/** Store a legacy global key at `config.mcp.apiKey`, preserving the rest of the block. */
function setLegacyKey(value: string | null): void {
  const leftover = {
    enabled: true,
    apiKey: value,
    rateLimit: { enabled: true, maxPerWindow: 60, windowSecs: 60 },
  };
  configManager.set('mcp', leftover);
}

/** Mount the Better Auth handler as `app.ts` does, so HTTP sign-up fires its hooks. */
function buildApp(): express.Express {
  const app = express();
  app.all('/api/auth/*splat', toNodeHandler(getAuth()!));
  app.use(express.json({ limit: '1mb' }));
  return app;
}

describe('retired global MCP keys', () => {
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
    db.$client.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Create the owner directly so tests that are not about the HTTP hook stay simple. */
  async function createOwner(): Promise<string> {
    const app = buildApp();
    requestTarget.mount(app);
    const res = await request(requestTarget.server)
      .post('/api/auth/sign-up/email')
      .set('Origin', ORIGIN)
      .send({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME });
    expect(res.status).toBe(200);
    return db.select().from(user).get()!.id;
  }

  it('never turns a leftover global key into an owner-owned credential', async () => {
    // Simulate a leftover value after boot. Startup itself refuses such files;
    // the owner-creation seam must independently leave this credential inert.
    setLegacyKey(LEGACY_KEY);
    await createOwner();
    expect(db.select().from(apikey).all()).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'config.json'), 'utf8')).mcp.apiKey).toBe(
      LEGACY_KEY
    );
    const verified = await getAuth()!.api.verifyApiKey({ body: { key: LEGACY_KEY } });
    expect(verified.valid).toBe(false);
  });
});

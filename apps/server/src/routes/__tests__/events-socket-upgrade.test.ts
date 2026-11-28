/**
 * The `/api/events` socket through the real upgrade path: `attachUpgradeRouter`,
 * its credential gate (`authorizeStreamUpgrade`, with a real sign-in store and
 * a real API key) and `upgradeRequestFacts`, then the person bar the route
 * runs. Nothing is stubbed between the handshake and the bar, so the facts the
 * bar reads are the ones the gate resolved (DOR-4986).
 */
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { STREAM_CLOSE_CODE_BASE } from '@dorkos/shared/stream-socket';
import { createDb, runMigrations, user } from '@dorkos/db';
import { initAuth } from '../../services/core/auth/index.js';
import { configManager, initConfigManager } from '../../services/core/config-manager.js';
import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
import { attachUpgradeRouter } from '../../services/core/streams/upgrade-router.js';
import { upgradeGuards } from '../../startup/upgrade-guards.js';
import { globalEventsRoute } from '../events-socket.js';

let home: string;
let server: Server;
let port = 0;
let apiKey = '';

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-events-upgrade-')));
  initConfigManager(home);
  const db = createDb(path.join(home, 'auth.db'));
  runMigrations(db);
  const auth = initAuth(db, home);
  const account = { email: 'owner' + '@' + 'dork.test', password: 'correct-horse-battery-staple' };
  await auth.api.signUpEmail({ body: { ...account, name: 'Owner' } });
  const ownerId = db.select().from(user).get()!.id;
  apiKey = (await auth.api.createApiKey({ body: { userId: ownerId, name: 'events' } })).key;
  server = createServer((_req, res) => res.end('ok'));
  attachUpgradeRouter(server, [globalEventsRoute], new MainRequestAdmission(), upgradeGuards);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(home, { recursive: true, force: true });
});
beforeEach(() => configManager.set('auth', { enabled: false }));

/** Open the socket from this computer; the close code and reason it ended with. */
function closeOf(headers: Record<string, string>): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/events`, { headers });
    ws.on('close', (code, reason) => resolve({ code, reason: reason.toString('utf8') }));
    ws.on('error', reject);
  });
}

describe('the /api/events socket, through the real upgrade path', () => {
  it('refuses an agent header with the bar’s close frame', async () => {
    expect(await closeOf({ 'x-dorkos-agent': 'dork_agent_resolves-to-nothing' })).toEqual({
      code: STREAM_CLOSE_CODE_BASE + 403,
      reason: 'Only a person can open the app’s live updates. Agents use their own tools.',
    });
  });

  it('refuses a key-only caller with login on, past a gate that accepted the key', async () => {
    configManager.set('auth', { enabled: true });
    const closed = await closeOf({ authorization: `Bearer ${apiKey}` });
    expect(closed.code).toBe(STREAM_CLOSE_CODE_BASE + 403);
    expect(closed.reason).toMatch(/^Only a person signed in to DorkOS/);
  });
});

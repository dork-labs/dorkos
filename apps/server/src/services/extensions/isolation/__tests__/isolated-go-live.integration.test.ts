/**
 * An isolated extension through DorkOS's real start and stop paths (DOR-2686
 * task 5.3): real discovery, the real esbuild compile of `server.ts`, the
 * real server lifecycle, a real forked child with the real flags, and its
 * router reached through DorkOS's own `/api/ext/:id` middleware. Only the
 * config store, the logger, and the agent-send and inbox services (fakes
 * that record what the lifecycle told them) are stand-ins.
 *
 * The properties: an approved isolated extension serves and uses ctx over
 * the boundary; a crash leaves the rest of DorkOS serving and restarts it on
 * the backoff, telling agent-send and the inbox it stopped (so a message it
 * was holding never goes out); too many crashes leave it stopped with its
 * card's words, which a page load does not undo and a reload does; a hang
 * is stopped as unresponsive; turning it off ends its process; a new
 * `server.ts` is served after a reload; a manifest that asks for more waits
 * for a person.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtensionsConfig } from '../../extension-enable-resolution.js';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const stored = vi.hoisted(() => ({ value: {} as ExtensionsConfig }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? stored.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') stored.value = value as ExtensionsConfig;
    },
  },
}));

import { ExtensionManager } from '../../extension-manager.js';
import { createExtensionRoutesMiddleware } from '../../../../middleware/extension-routes.js';
import { setAgentSendService, type AgentSendService } from '../../agent-send/agent-send.js';
import { setExtensionInbox, type ExtensionInboxService } from '../../inbox/extension-inbox.js';

const ID = 'iso-live';
const NAME = 'Iso Live';

/** The extension's server half: routes that report, use ctx, crash and hang. */
function serverSource(version: string): string {
  return `
export default function register(router: any, ctx: any) {
  router.get('/ping', (_req: any, res: any) => res.json({ pid: process.pid, version: '${version}' }));
  router.post('/store', async (req: any, res: any) => {
    await ctx.storage.saveData({ n: req.body.n });
    res.json(await ctx.storage.loadData());
  });
  router.post('/crash', (_req: any, res: any) => {
    res.json({ ok: true });
    setTimeout(() => process.abort(), 50);
  });
  router.post('/hang', (_req: any, res: any) => {
    res.json({ ok: true });
    setTimeout(() => { for (;;) {} }, 50);
  });
  router.post('/send', (_req: any, res: any) => {
    ctx.agent.send({ to: 'agent-1', text: 'hello', idempotencyKey: 'k1' }).then(
      () => undefined,
      () => undefined
    );
    res.json({ sent: true });
  });
}
`;
}

let dorkHome: string;
let extDir: string;
let manager: ExtensionManager;
let server: http.Server;
let base: string;
let announced: string[];

/** What the fake agent-send service was told, and the message it holds. */
const sends = {
  held: [] as { extensionId: string; failed: string | null }[],
  stopped: [] as string[],
  started: [] as string[],
  delivered: 0,
};
const inbox = { stopped: [] as string[], running: [] as string[] };

/** Write the extension's files; `allow` widens or narrows what it declares. */
async function install(version = 'v1', net: string[] = []): Promise<void> {
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(
    path.join(extDir, 'extension.json'),
    JSON.stringify({
      id: ID,
      name: NAME,
      version: '1.0.0',
      description: 'An isolated extension for the go-live test.',
      serverCapabilities: {
        serverEntry: './server.ts',
        runtime: 'subprocess',
        allow: { net, run: [], agents: true },
      },
    })
  );
  await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() {}\n');
  await fs.writeFile(path.join(extDir, 'server.ts'), serverSource(version));
}

/** Boot the manager the way `index.ts` does, with short restart and watchdog timings. */
async function boot(budget = 3): Promise<void> {
  manager = new ExtensionManager(dorkHome, [], {
    dorkosPort: 1,
    restartPolicy: { delays: [300, 300, 300], budget },
    isolatedTimings: { pingIntervalMs: 200, pongTimeoutMs: 1_500 },
  });
  manager.followProjects(
    { roots: async () => [], onChange: () => () => undefined },
    { announce: (ids) => announced.push(...ids) }
  );
  await manager.initialize(null);
}

/** Wait until `check` is true, or fail after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const began = Date.now();
  while (!(await check())) {
    if (Date.now() - began > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The public record, as the app reads it. */
function card() {
  return manager.listPublic().find((r) => r.id === ID)!;
}

/** Whether a process with this id exists (signal 0 checks, never signals). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** GET a route through DorkOS. */
async function get(route: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** POST a JSON body through DorkOS. */
async function post(route: string, body: unknown = {}) {
  const res = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2686-live-')));
  extDir = path.join(dorkHome, 'extensions', ID);
  announced = [];
  sends.held = [];
  sends.stopped = [];
  sends.started = [];
  sends.delivered = 0;
  inbox.stopped = [];
  inbox.running = [];
  stored.value = {
    enabled: [ID],
    disabled: [],
    approvedToRun: [ID],
    approvedSources: { [ID]: { path: extDir } },
    approvedPermissions: { [ID]: { runtime: 'subprocess', net: [], run: [], agents: true } },
  };
  // A held message fails when its extension stops, as the real service does;
  // one that was never failed would be delivered.
  setAgentSendService({
    send: (extensionId: string) => {
      const row = { extensionId, failed: null as string | null };
      sends.held.push(row);
      return new Promise(() => undefined);
    },
    subscribe: () => () => undefined,
    extensionStopped: (extensionId: string) => {
      sends.stopped.push(extensionId);
      for (const row of sends.held) if (row.extensionId === extensionId) row.failed ??= 'stopped';
    },
    extensionStarted: (extensionId: string) => sends.started.push(extensionId),
  } as unknown as AgentSendService);
  setExtensionInbox({
    markStopped: (id: string) => inbox.stopped.push(id),
    markRunning: (id: string) => inbox.running.push(id),
    stop: () => undefined,
    openProjectCount: () => 0,
  } as unknown as ExtensionInboxService);

  // DorkOS's own order: the app-wide JSON parser, then the extension mount.
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api/ext/:id', (req, res, next) =>
    createExtensionRoutesMiddleware(manager)(req, res, next)
  );
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await manager?.shutdownServer(ID);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  setAgentSendService(undefined);
  setExtensionInbox(null);
  await fs.rm(dorkHome, { recursive: true, force: true });
});

describe('an isolated extension goes live through the real lifecycle', () => {
  // Purpose: approved and started, it answers through DorkOS from its own
  // process (not this one), and ctx crosses the boundary to the real store.
  it('serves its router from its own process and uses ctx', async () => {
    await install();
    await boot();
    const ping = await get(`/api/ext/${ID}/ping`);
    expect(ping.status).toBe(200);
    expect(ping.body.version).toBe('v1');
    expect(ping.body.pid).not.toBe(process.pid);
    expect(manager.getServerRouter(ID)).not.toBeNull();
    const pid = ping.body.pid as number;
    expect(alive(pid)).toBe(true);

    const storedBack = await post(`/api/ext/${ID}/store`, { n: 7 });
    expect(storedBack.body).toEqual({ n: 7 });
    // The real ctx wrote it, under DorkOS's data directory, not the child's.
    const files = await fs.readdir(path.join(dorkHome, 'extension-data', ID));
    expect(files.length).toBeGreaterThan(0);
    expect(inbox.running).toContain(ID);
    expect(card().serverError).toBeUndefined();

    // A clean stop ends its process and leaves nothing to restart.
    await manager.shutdownServer(ID);
    expect(alive(pid)).toBe(false);
    expect(manager.getServerRouter(ID)).toBeNull();
    await new Promise((r) => setTimeout(r, 600));
    expect(manager.getServerRouter(ID)).toBeNull();
  }, 60_000);

  // Purpose: a crash leaves DorkOS serving, runs the stop bookkeeping (the
  // message it was holding is failed, never delivered), shows "Restarting",
  // and a fresh process takes over on the backoff.
  it('restarts after a crash, failing the message it was holding', async () => {
    await install();
    await boot();
    const first = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
    await post(`/api/ext/${ID}/send`);
    await until(() => sends.held.length === 1);
    expect(sends.held[0]!.failed).toBeNull();

    await post(`/api/ext/${ID}/crash`);
    await until(() => !alive(first));
    expect((await get('/api/health')).body).toEqual({ ok: true });
    await until(() => sends.stopped.includes(ID) && inbox.stopped.includes(ID));
    expect(sends.held[0]!.failed).toBe('stopped');
    expect(sends.delivered).toBe(0);
    expect(card().restartingAt).toEqual(expect.any(String));
    expect(announced).toContain(ID);

    await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
    const second = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
    expect(second).not.toBe(first);
    expect(card().restartingAt).toBeNull();
    expect(card().serverError).toBeUndefined();
  }, 60_000);

  // Purpose: the third crash inside the window leaves it stopped with the
  // card's words; a page load's init does not start it again; a reload
  // does, with a fresh crash budget.
  it('stays stopped after three crashes until it is reloaded', async () => {
    await install();
    await boot();
    for (let crash = 1; crash <= 3; crash++) {
      await until(async () => (await get(`/api/ext/${ID}/ping`)).status === 200);
      const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
      await post(`/api/ext/${ID}/crash`);
      await until(() => !alive(pid));
      await until(() => manager.getServerRouter(ID) === null);
    }
    await until(() => card().serverError?.code === 'server_crashed');
    expect(card().serverError?.message).toBe(
      `${NAME} stopped unexpectedly 3 times. Reload it to try again.`
    );
    await new Promise((r) => setTimeout(r, 700));
    expect(manager.getServerRouter(ID)).toBeNull();
    expect((await get(`/api/ext/${ID}/ping`)).status).toBe(404);

    // What every page load asks for: refused, still stopped.
    const init = await manager.initializeServer(ID);
    expect(init.ok).toBe(false);
    expect(manager.getServerRouter(ID)).toBeNull();

    await manager.reloadExtension(ID);
    expect((await get(`/api/ext/${ID}/ping`)).status).toBe(200);
    expect(card().serverError).toBeUndefined();
  }, 90_000);

  // Purpose: a stuck event loop is stopped by the watchdog and reported as
  // unresponsive (budget 1 here, so the first stop is the last).
  it('stops a hung extension as unresponsive', async () => {
    await install();
    await boot(1);
    const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
    await post(`/api/ext/${ID}/hang`);
    await until(() => card().serverError?.code === 'server_unresponsive', 15_000);
    expect(card().serverError?.message).toBe(`${NAME} stopped responding, so DorkOS stopped it.`);
    expect(alive(pid)).toBe(false);
    expect((await get('/api/health')).status).toBe(200);
  }, 30_000);

  // Purpose: turning it off ends its process, and nothing restarts it.
  it('ends its process when it is turned off', async () => {
    await install();
    await boot();
    const pid = (await get(`/api/ext/${ID}/ping`)).body.pid as number;
    await manager.disable(ID);
    expect(alive(pid)).toBe(false);
    await new Promise((r) => setTimeout(r, 600));
    expect(manager.getServerRouter(ID)).toBeNull();
    expect(sends.stopped).toContain(ID);
  }, 60_000);

  // Purpose: the dev loop. A new server.ts is served by a new process after
  // a reload (what a dev link's save calls); a manifest that asks for a new
  // host waits for a person, and one that asks for less runs without asking.
  it('serves new code after a reload, and waits for a person when it asks for more', async () => {
    await install('v1');
    await boot();
    const first = (await get(`/api/ext/${ID}/ping`)).body.pid as number;

    await install('v2');
    await manager.reloadExtension(ID);
    const v2 = await get(`/api/ext/${ID}/ping`);
    expect(v2.body.version).toBe('v2');
    expect(v2.body.pid).not.toBe(first);
    expect(alive(first)).toBe(false);

    await install('v2', ['api.example.com']);
    await manager.reload();
    expect(manager.getServerRouter(ID)).toBeNull();
    expect(card().approvedToRun).toBe(false);
    expect(alive(v2.body.pid as number)).toBe(false);

    await install('v2', []);
    await manager.reload();
    expect(card().approvedToRun).toBe(true);
    expect((await get(`/api/ext/${ID}/ping`)).status).toBe(200);
  }, 90_000);
});

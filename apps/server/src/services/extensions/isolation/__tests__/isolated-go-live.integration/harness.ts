/**
 * Shared setup for the isolated-go-live.integration suites: everything the original file declared or
 * registered outside its tests.
 */
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ExtensionsConfig } from '../../../extension-enable-resolution.js';
import { IsolatedExtensionHost } from '../../isolated-host.js';
import type { McpToolDeps } from '../../../../runtimes/claude-code/mcp-tools/types.js';
import { createGetExtensionErrorsHandler } from '../../../../runtimes/claude-code/mcp-tools/extension-tools.js';
import { logger } from '../../../../../lib/logger.js';
import { ExtensionManager } from '../../../extension-manager.js';
import { grantsDigestOf } from '../../../pin/extension-path-trust.js';
import { liveDigestOf } from '../../../pin/extension-content-pin.js';
import { noteScaffoldTrusted } from '../../../pin/path-trust-edits.js';
import {
  noteWriteDone,
  noteWriteStarting,
  resetPathTrustWriters,
} from '../../../pin/path-trust-writers.js';
import { createExtensionApiRoutes } from '../../../../../routes/extension-api.js';
import { honoGroupListener } from '../../../../../http/__tests__/hono-group-listener.js';
import type { ApiEnv } from '../../../../../http/api-chain.js';
import { setAgentSendService, type AgentSendService } from '../../../agent-send/agent-send.js';
import { setExtensionInbox, type ExtensionInboxService } from '../../../inbox/extension-inbox.js';
import { createDb, runMigrations } from '@dorkos/db';
import type { NotificationDTO } from '@dorkos/shared/notification-schemas';
import { NotificationStore } from '../../../../notifications/notification-store.js';
import {
  NotificationService,
  setNotificationService,
} from '../../../../notifications/notification-service.js';

/** What each test runs against; the hooks below reset it. */
export const st = {
  dorkHome: undefined as unknown as string,
  extDir: undefined as unknown as string,
  agentHome: undefined as unknown as string,
  manager: undefined as unknown as ExtensionManager,
  server: undefined as unknown as http.Server,
  base: undefined as unknown as string,
  announced: undefined as unknown as string[],
  shownAtBroadcast: undefined as unknown as {
    restartingAt: string | null;
    serverError?: { code: string };
  }[],
  notifications: undefined as unknown as NotificationStore,
  writeCall: 0,
};

vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const storedHoisted = vi.hoisted(() => ({ value: {} as ExtensionsConfig }));

vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: (key: string) => (key === 'extensions' ? storedHoisted.value : undefined),
    set: (key: string, value: unknown) => {
      if (key === 'extensions') storedHoisted.value = value as ExtensionsConfig;
    },
  },
}));

// The agent that made it is at Full, so its edits run (`path-trust-edits.ts`).
const agentLevelHoisted = vi.hoisted(() => ({ mode: 'bypassPermissions' }));

vi.mock('../../../../session/resolution/agent-launch-level.js', () => ({
  resolveAgentLaunchLevel: async () => ({ mode: agentLevelHoisted.mode }),
}));

vi.mock('../../../../core/runtime-registry.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../../core/runtime-registry.js')>();
  const { CLAUDE_CODE_CAPABILITIES } =
    await import('../../../../runtimes/claude-code/runtime-constants.js');
  return {
    ...original,
    runtimeRegistry: {
      getDefaultType: () => 'claude-code',
      getAllCapabilities: () => ({ 'claude-code': CLAUDE_CODE_CAPABILITIES }),
    },
  };
});

// Login off: the chain's session gate lets every request through.
vi.mock('../../../../core/auth/session-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../core/auth/session-gate.js')>()),
  decideSessionGate: vi.fn(async () => ({ allowed: true })),
}));

export const ID = 'iso-live';

export const NAME = 'Iso Live';

/** The extension's server half: routes that report, use ctx, crash and hang. */
export function serverSource(version: string): string {
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

/** What the fake agent-send service was told, and the message it holds. */
export const sends = {
  held: [] as { extensionId: string; failed: string | null }[],
  stopped: [] as string[],
  started: [] as string[],
};

export const inbox = { stopped: [] as string[], running: [] as string[] };

/** What the person was told about this extension stopping, newest first. */
export function stoppedNotices(): NotificationDTO[] {
  return st.notifications.list({ limit: 50, unread: false, kind: ['extension.stopped'] })
    .notifications;
}

/**
 * Write the extension's files; `allow` widens or narrows what it declares. Each write is noted as
 * its author's own unheld one, as the agent's file tools note it (DOR-4528).
 */
export async function install(version = 'v1', net: string[] = []): Promise<void> {
  await fs.mkdir(st.extDir, { recursive: true });
  const manifest = JSON.stringify({
    id: ID,
    name: NAME,
    version: '1.0.0',
    description: 'An isolated extension for the go-live test.',
    serverCapabilities: {
      serverEntry: './server.ts',
      runtime: 'subprocess',
      allow: { net, run: [], agents: true },
    },
  });
  await authorWrite('extension.json', manifest);
  await authorWrite('index.ts', 'export function activate() {}\n');
  await authorWrite('server.ts', serverSource(version));
}

/** One write by the author's file tool: noted, written as asked, completed. */
export async function authorWrite(name: string, text: string): Promise<void> {
  const file = path.join(st.extDir, name);
  const id = `write-${++st.writeCall}`;
  await noteWriteStarting(id, { file, agentHome: st.agentHome, held: false }, () =>
    Buffer.from(text)
  );
  await fs.writeFile(file, text);
  await noteWriteDone(id);
}

/**
 * How long any one wait may take. Generous on purpose: the merge queue runs
 * this beside other heavy shards, where forking and compiling a child can
 * take seconds. A wait that passes returns as soon as its condition holds.
 */
export const WAIT_MS = 60_000;

/** A test's own timeout: room for several waits on a loaded runner. */
export const TEST_MS = 240_000;

/**
 * Boot the manager the way `index.ts` does. The restart backoff is a
 * test-only 10/20/40 ms (the production 1 s / 5 s / 30 s is unchanged), so a
 * test never waits on real backoff. The watchdog keeps a long pong timeout,
 * so a loaded runner can't turn a crash test's exits into "unresponsive"
 * ones; only the hang test shortens it.
 */
export async function boot(
  budget = 3,
  watchdog: { pingIntervalMs: number; pongTimeoutMs: number } = {
    pingIntervalMs: 1_000,
    pongTimeoutMs: 30_000,
  },
  delays = [10, 20, 40]
): Promise<void> {
  // These lifecycle cases start with an approved scaffold. Record its exact initial files;
  // later installs remain edits and must pass the real tracing checks.
  expect(
    await noteScaffoldTrusted(st.dorkHome, ID, {
      targetDir: st.extDir,
      digest: await liveDigestOf({ path: st.extDir }),
    })
  ).toBe(true);
  st.manager = new ExtensionManager(st.dorkHome, [], {
    dorkosPort: 1,
    restartPolicy: { delays, budget },
    isolatedTimings: watchdog,
  });
  st.manager.followProjects(
    { roots: async () => [st.agentHome], onChange: () => () => undefined },
    {
      announce: (ids) => {
        st.announced.push(...ids);
        const shown = st.manager.listPublic().find((r) => r.id === ID);
        st.shownAtBroadcast.push({
          restartingAt: shown?.restartingAt ?? null,
          serverError: shown?.serverError,
        });
      },
    }
  );
  await st.manager.initialize(null);
}

/** Wait until `check` is true, or fail after `ms`, saying what the card showed. */
export async function until(check: () => boolean | Promise<boolean>, ms = WAIT_MS): Promise<void> {
  const began = Date.now();
  while (!(await check())) {
    if (Date.now() - began > ms) {
      const shown = st.manager?.listPublic().find((r) => r.id === ID);
      throw new Error(
        `timed out waiting; card: ${JSON.stringify({
          serverError: shown?.serverError,
          restartingAt: shown?.restartingAt,
        })}`
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** How many times the extension stopped on its own so far (each broadcasts its card). */
export function unexpectedStops(): number {
  return st.shownAtBroadcast.filter((c) => c.restartingAt !== null || c.serverError).length;
}

/** The public record, as the app reads it. */
export function card() {
  return st.manager.listPublic().find((r) => r.id === ID)!;
}

/** Refuse selected starts through the real child's permission self-check. */
export function refuseStarts(refuse: (attempt: number) => boolean) {
  const realStart = IsolatedExtensionHost.prototype.start;
  let attempts = 0;
  vi.spyOn(IsolatedExtensionHost.prototype, 'start').mockImplementation(function (
    this: IsolatedExtensionHost
  ) {
    attempts++;
    if (refuse(attempts)) this['options'].testSeams = { omitPermission: true };
    return realStart.call(this);
  });
  return () => attempts;
}

/** Diagnose through the real manager and MCP handler. */
export async function extensionErrors() {
  const result = await createGetExtensionErrorsHandler({
    extensionManager: st.manager,
  } as McpToolDeps)();
  return JSON.parse(result.content[0].text);
}

/** Whether a process with this id exists (signal 0 checks, never signals). */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** GET a route through DorkOS. */
export async function get(
  route: string
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${st.base}${route}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** POST a JSON body through DorkOS. */
export async function post(route: string, body: unknown = {}) {
  const res = await fetch(`${st.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  st.dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2686-live-')));
  // The agent's own extension, in its own folder, running separately: the one
  // kind whose server edits keep running without a person (path trust, DOR-3068).
  st.agentHome = path.join(st.dorkHome, 'agents', 'live-agent');
  st.extDir = path.join(st.agentHome, '.dork', 'extensions', ID);
  resetPathTrustWriters();
  st.announced = [];
  st.shownAtBroadcast = [];
  sends.held = [];
  sends.stopped = [];
  sends.started = [];
  inbox.stopped = [];
  inbox.running = [];
  const db = createDb(':memory:');
  runMigrations(db);
  st.notifications = new NotificationStore(db);
  setNotificationService(new NotificationService(st.notifications));
  storedHoisted.value = {
    enabled: [ID],
    disabled: [],
    approvedToRun: [ID],
    approvedSources: {
      [ID]: {
        path: st.extDir,
        authorHome: st.agentHome,
        grants: grantsDigestOf({
          id: ID,
          name: NAME,
          version: '1.0.0',
          serverCapabilities: {
            serverEntry: './server.ts',
            runtime: 'subprocess',
            allow: { net: [], run: [], agents: true },
          },
        }),
      },
    },
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

  // DorkOS's own order: the `/api` chain, then the extension mount.
  const health = new Hono<ApiEnv>().get('/', (c) => c.json({ ok: true }));
  st.server = http.createServer(
    honoGroupListener([
      { path: '/api/health', routes: health },
      {
        path: '/api/ext',
        // Read when a request arrives: `boot()` creates the manager later.
        routes: createExtensionApiRoutes({
          getServerHandler: (id) => st.manager.getServerHandler(id),
        }),
      },
    ])
  );
  await new Promise<void>((resolve) => st.server.listen(0, '127.0.0.1', resolve));
  st.base = `http://127.0.0.1:${(st.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  // A reload by id that finds files changed since the last scan asks for a
  // background scan (DOR-4282). It compiles and writes snapshots under
  // `cache/extensions`, so let it and the skills ledger finish before the
  // server stops and the folder goes; a scan still writing made `rm` fail
  // with ENOTEMPTY.
  await st.manager?.whenIdle();
  await st.manager?.whenSkillsSettled();
  await st.manager?.shutdownServer(ID);
  vi.restoreAllMocks();
  st.server.closeAllConnections();
  await new Promise((resolve) => st.server.close(resolve));
  setAgentSendService(undefined);
  setExtensionInbox(null);
  setNotificationService(null);
  await fs.rm(st.dorkHome, { recursive: true, force: true });
});

/** Exported view of the hoisted `stored` (vitest refuses to export a hoisted binding). */
export const stored = storedHoisted;
/** Exported view of the hoisted `agentLevel` (vitest refuses to export a hoisted binding). */
export const agentLevel = agentLevelHoisted;

/**
 * Agent tools from an isolated extension, through DorkOS's real paths
 * (DOR-2686 task 6.1): real discovery, the real esbuild compile of
 * `server.ts`, the real server lifecycle, a real forked child with the real
 * flags, a real capability registry, and the real tier and permission gates.
 * Only the config store, the logger, and the agent-send and inbox services
 * are stand-ins.
 *
 * The properties: an agent's call reaches the child only through the
 * unchanged gate and comes back through the host wrapper's checks; the
 * deadline abort reaches the child's `call.signal`; a result over 256 KB is
 * refused; a crash or a hang removes the tool from the registry before the
 * call still running fails as stopped, and a restart offers the tools again.
 * Every child a test starts is stopped by the test's own `shutdownServer`
 * (or was already killed by DorkOS), and the test checks it is gone.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { AgentPermissions, PermissionPreset } from '@dorkos/shared/permissions';
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
import { composeRegistry, type CapabilityRegistry } from '../../../core/capabilities/registry.js';
import { CapabilityToolError } from '../../../core/capabilities/mcp-envelope.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../../core/approvals/index.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { permissionActions } from '../../../core/permissions/index.js';
import type { AgentIdentity } from '../../../core/agent-identity/agent-identity-service.js';
import { setAgentSendService, type AgentSendService } from '../../agent-send/agent-send.js';
import { setExtensionInbox, type ExtensionInboxService } from '../../inbox/extension-inbox.js';
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import { checkDeclaredTools } from '@dorkos/extension-api/tool-check';
import { createDataProviderContext } from '../../extension-server-api-factory.js';
import { cleanup, createHarness, makeHost, startOk, type Harness } from './isolation-harness.js';
import { CtxDispatcher } from '../ctx-dispatcher.js';

const ID = 'iso-tools';
const NAME = 'Iso Tools';
const DOMAIN = 'ext_iso_tools';

const AGENT: AgentIdentity = {
  agentPath: '/agents/mailer',
  displayName: 'Mailer',
  createdAt: new Date().toISOString(),
};

/** One declared tool, observe unless said otherwise. */
function tool(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: `Tool ${name}`,
    description: `The ${name} test tool.`,
    tier: 'observe',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', maxLength: 200 } },
      additionalProperties: false,
    },
    ...extra,
  };
}

/**
 * The extension's server half. Every handler counts its calls in the child,
 * and `stats` reports them, so a test can prove what reached the child.
 */
const SERVER = `
export default function register(_router: any, ctx: any) {
  const stats = { calls: 0, aborts: 0, deleted: 0 };
  ctx.tools.handle('echo', (input: any, call: any) => {
    stats.calls++;
    return { message: input.message, pid: process.pid, agentId: call.agentId };
  });
  ctx.tools.handle('stats', () => ({ ...stats, pid: process.pid, sendType: typeof process.send }));
  // Forge a binding for a declared tool after register() returned, on the
  // raw channel if this code can still reach it.
  setImmediate(() => {
    try {
      (process as any).send({ type: 'expose', id: 9001, path: 'tools.handle', name: 'late' });
    } catch {}
  });
  ctx.tools.handle('wait_for_abort', (_input: any, call: any) => {
    stats.calls++;
    return new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => {
        stats.aborts++;
        reject(new Error('aborted'));
      });
    });
  });
  ctx.tools.handle('big', () => {
    stats.calls++;
    return 'x'.repeat(300 * 1024);
  });
  ctx.tools.handle('crash_mid_call', () => {
    stats.calls++;
    setTimeout(() => process.abort(), 100);
    return new Promise(() => undefined);
  });
  ctx.tools.handle('hang', () => {
    stats.calls++;
    for (;;) {}
  });
  ctx.tools.handle('delete_note', () => {
    stats.calls++;
    stats.deleted++;
    return { deleted: true };
  });
}
`;

let dorkHome: string;
let extDir: string;
let manager: ExtensionManager;
let registry: CapabilityRegistry;
let approvals: ApprovalService;
let preset: PermissionPreset;
let agentPermissions: AgentPermissions | undefined;

/** Write the extension: manifest with its tools, and its server half. */
async function install(): Promise<void> {
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(
    path.join(extDir, 'extension.json'),
    JSON.stringify({
      id: ID,
      name: NAME,
      version: '1.0.0',
      description: 'An isolated extension that gives agents tools.',
      serverCapabilities: {
        serverEntry: './server.ts',
        runtime: 'subprocess',
        allow: { net: [], run: [], agents: false },
      },
      tools: [
        tool('echo'),
        tool('stats'),
        tool('wait_for_abort', { timeoutSeconds: 1 }),
        tool('big'),
        tool('crash_mid_call', { timeoutSeconds: 60 }),
        tool('hang', { timeoutSeconds: 60 }),
        tool('delete_note', { tier: 'destructive', approvalDisplayFields: ['message'] }),
        tool('late'),
      ],
    })
  );
  await fs.writeFile(path.join(extDir, 'index.ts'), 'export function activate() {}\n');
  await fs.writeFile(path.join(extDir, 'server.ts'), SERVER);
}

/** Boot the manager as `index.ts` does, with short restart and watchdog timings. */
async function boot(): Promise<void> {
  manager = new ExtensionManager(dorkHome, [], {
    dorkosPort: 1,
    restartPolicy: { delays: [300, 300, 300], budget: 3 },
    isolatedTimings: { pingIntervalMs: 200, pongTimeoutMs: 1_500 },
  });
  await manager.initialize(null);
  manager.attachAgentTools({ registry, forgetToolPermissions: async () => [] });
}

/** Call a tool as the agent, through the registry's gate. */
function call(name: string, input: unknown = {}, approvalToken?: string): Promise<unknown> {
  return registry.invoke(`${DOMAIN}.${name}`, input, {
    identity: AGENT,
    retryChannel: 'mcp-argument',
    ...(approvalToken ? { approvalToken } : {}),
  });
}

/** Every child process id a test saw, so the cleanup can prove each is gone. */
let pids: number[] = [];

/** The child's own count of the calls that reached it, and its process id. */
async function childStats(): Promise<{
  calls: number;
  aborts: number;
  deleted: number;
  pid: number;
  sendType: string;
}> {
  const stats = (await call('stats')) as {
    calls: number;
    aborts: number;
    deleted: number;
    pid: number;
    sendType: string;
  };
  pids.push(stats.pid);
  return stats;
}

/** The running child's process id, asked of the child itself. */
async function childPid(): Promise<number> {
  return (await childStats()).pid;
}

/** The refusal a gate decision carries, or null when the call ran. */
async function refusalOf(promise: Promise<unknown>): Promise<Record<string, unknown> | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return (
      (err as { decision?: { payload: Record<string, unknown> } }).decision?.payload ?? {
        error: String(err),
      }
    );
  }
}

/** Wait until `check` is true, or fail after `ms`. */
async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const began = Date.now();
  while (!(await check())) {
    if (Date.now() - began > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
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

/** The tool error a rejected call carries. */
async function toolErrorOf(promise: Promise<unknown>): Promise<{ error: string; code: string }> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CapabilityToolError);
    return (err as CapabilityToolError).payload as { error: string; code: string };
  }
  throw new Error('the call succeeded');
}

beforeEach(async () => {
  dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2686-tools-')));
  extDir = path.join(dorkHome, 'extensions', ID);
  stored.value = {
    enabled: [ID],
    disabled: [],
    approvedToRun: [ID],
    approvedSources: { [ID]: { path: extDir } },
    approvedPermissions: { [ID]: { runtime: 'subprocess', net: [], run: [], agents: false } },
  };
  preset = 'balanced';
  agentPermissions = undefined;
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  approvals = new ApprovalService(createTestDb());
  initCapabilityTierGate({ approvals });
  registry = composeRegistry([], { logger: noopLogger });
  initPermissionGate({
    readConfig: () => ({ preset, defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => agentPermissions,
    listActions: () => permissionActions(registry),
  });
  setAgentSendService({
    send: () => new Promise(() => undefined),
    subscribe: () => () => undefined,
    extensionStopped: () => undefined,
    extensionStarted: () => undefined,
  } as unknown as AgentSendService);
  setExtensionInbox({
    markStopped: () => undefined,
    markRunning: () => undefined,
    stop: () => undefined,
    openProjectCount: () => 0,
  } as unknown as ExtensionInboxService);
  await install();
});

afterEach(async () => {
  await manager?.shutdownServer(ID);
  for (const pid of pids) expect(alive(pid)).toBe(false);
  pids = [];
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
  setAgentSendService(undefined);
  setExtensionInbox(null);
  await fs.rm(dorkHome, { recursive: true, force: true });
});

describe('agent tools from an isolated extension (real child)', () => {
  // Purpose: an agent's call returns the child's own result: it ran in the
  // extension's process (not DorkOS's), and only the declared tools it
  // handled are in the registry.
  it('answers an agent call from its own process', async () => {
    await boot();
    expect(registry.get(`${DOMAIN}.echo`)?.source).toEqual({
      kind: 'extension',
      id: ID,
      name: NAME,
    });
    const result = (await call('echo', { message: 'hi' })) as Record<string, unknown>;
    expect(result.message).toBe('hi');
    expect(result.pid).toBe(await childPid());
    expect(result.pid).not.toBe(process.pid);
    expect(alive(result.pid as number)).toBe(true);
    // No registered agent lives at the caller's folder: unknown, as in-process.
    expect(result.agentId).toBeNull();
    expect(registry.capabilities.filter((c) => c.id.startsWith(`${DOMAIN}.`))).toHaveLength(7);
  }, 60_000);

  // Purpose: extension code has no public raw channel (process.send is
  // locked away before the bundle loads), and a binding it tries to forge
  // after register() returned never becomes a tool.
  it('gives extension code no raw channel, and never offers a tool bound late', async () => {
    await boot();
    expect((await childStats()).sendType).toBe('undefined');
    await new Promise((r) => setTimeout(r, 200));
    expect(registry.get(`${DOMAIN}.late`)).toBeUndefined();
    const card = manager.listPublic().find((r) => r.id === ID);
    expect(card?.tools?.find((t) => t.name === 'late')).toMatchObject({ status: 'refused' });
  }, 60_000);

  // Purpose: the gate runs in DorkOS, unchanged, BEFORE anything reaches the
  // child: a Blocked Extension tools area refuses the call, and a
  // destructive tool waits for a person even under Full; the child counts
  // no call for either. A person's yes then runs it once.
  it('gates every call in DorkOS before the child hears of it', async () => {
    await boot();
    const before = (await childStats()).calls;

    agentPermissions = { areas: { extensions: 'blocked' } };
    const blocked = await refusalOf(call('echo', { message: 'x' }));
    expect(blocked).toMatchObject({ status: 'denied', reason: 'permission_blocked' });
    agentPermissions = undefined;

    preset = 'full';
    const asked = await refusalOf(call('delete_note', { message: 'n-1' }));
    expect(asked).toMatchObject({ status: 'approval_required' });
    expect((await childStats()).calls).toBe(before);

    const { approvalId, approvalToken } = asked as { approvalId: string; approvalToken: string };
    expect(approvals.grant(approvalId)).toBeUndefined();
    expect(await call('delete_note', { message: 'n-1' }, approvalToken)).toEqual({ deleted: true });
    expect(await childStats()).toMatchObject({ calls: before + 1, deleted: 1 });
  }, 60_000);

  // Purpose: the host wrapper's deadline (timeoutSeconds: 1) aborts the
  // call, and the abort reaches the handler's call.signal in the child.
  it('aborts the child’s call.signal at the deadline', async () => {
    await boot();
    const started = Date.now();
    const error = await toolErrorOf(call('wait_for_abort'));
    expect(error).toEqual({
      error: `${NAME} didn't answer in 1 seconds.`,
      code: 'EXTENSION_TOOL_TIMEOUT',
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    await until(async () => (await childStats()).aborts === 1);
  }, 60_000);

  // Purpose: a result over 256 KB passes the channel (under 4 MB) but is
  // refused by the host wrapper, as in-process.
  it('refuses a result over 256 KB', async () => {
    await boot();
    expect(await toolErrorOf(call('big'))).toEqual({
      error: `${NAME} returned more than the agent can read.`,
      code: 'EXTENSION_TOOL_BAD_RESULT',
    });
  }, 60_000);

  // Purpose: the child dying mid-call fails the call as stopped, and by the
  // time it fails the tool is already gone from the registry (removed
  // first). A restart offers the tools again, from a new process.
  it('fails a call as stopped when the child dies, then offers the tools again', async () => {
    await boot();
    const first = await childPid();
    // What the registry held when the host released the dead child and
    // rejected its waiting calls: the lifecycle's onGone must have removed
    // the tool by then, whatever the microtask order.
    const atClose: boolean[] = [];
    const close = CtxDispatcher.prototype.close;
    const spy = vi.spyOn(CtxDispatcher.prototype, 'close').mockImplementation(function (
      this: CtxDispatcher
    ) {
      atClose.push(registry.get(`${DOMAIN}.crash_mid_call`) !== undefined);
      return close.call(this);
    });
    let goneWhenRejected: boolean | null = null;
    const pending = call('crash_mid_call').catch((err: unknown) => {
      goneWhenRejected = registry.get(`${DOMAIN}.echo`) === undefined;
      throw err;
    });
    expect(await toolErrorOf(pending)).toEqual({
      error: `${NAME} stopped while this ran.`,
      code: 'EXTENSION_TOOL_STOPPED',
    });
    expect(goneWhenRejected).toBe(true);
    await vi.waitFor(() => expect(atClose).toHaveLength(1), { timeout: 5_000 });
    expect(atClose).toEqual([false]);
    spy.mockRestore();
    expect(registry.get(`${DOMAIN}.crash_mid_call`)).toBeUndefined();
    await until(() => !alive(first));

    await until(() => registry.get(`${DOMAIN}.echo`) !== undefined);
    const again = (await call('echo', { message: 'back' })) as Record<string, unknown>;
    expect(again.message).toBe('back');
    expect(again.pid).not.toBe(first);
    expect(again.pid).toBe(await childPid());
  }, 60_000);

  // Purpose: a handler stuck in a synchronous loop freezes the whole child;
  // the watchdog kills it, the tool leaves the registry, and the call fails
  // as stopped rather than waiting out its 60-second deadline.
  it('removes the tools of a child the watchdog killed for hanging in a handler', async () => {
    await boot();
    const pid = await childPid();
    const started = Date.now();
    expect(await toolErrorOf(call('hang'))).toEqual({
      error: `${NAME} stopped while this ran.`,
      code: 'EXTENSION_TOOL_STOPPED',
    });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(registry.get(`${DOMAIN}.hang`)).toBeUndefined();
    await until(() => !alive(pid));
  }, 60_000);
});

describe('the isolated host on a child exit (real child)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await cleanup(h);
  });

  // Purpose: the host closes tool binding the moment `registered` arrives.
  // Code in the child posting its own binding right after register()
  // returned (here on the raw channel the test seam keeps) is refused with
  // the in-process words, and the host's real binding never holds it.
  it('refuses a tool binding that arrives after registered', async () => {
    const bundle = path.join(h.tmp, 'bundles', 'late.js');
    await fs.writeFile(
      bundle,
      String.raw`
'use strict';
module.exports = function register(_router, ctx) {
  ctx.tools.handle('wait', () => 1);
  setImmediate(() => process.send({ type: 'expose', id: 9001, path: 'tools.handle', name: 'late' }));
};
module.exports.probes = {};
`
    );
    const manifest = ExtensionManifestSchema.parse({
      id: 'late-bind',
      name: 'Late Bind',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
      tools: ['wait', 'late'].map((name) => ({
        name,
        title: name,
        description: 'A test tool.',
        tier: 'observe',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      })),
    });
    const toolChecks = checkDeclaredTools(manifest);
    const built = createDataProviderContext({
      extensionId: 'late-bind',
      extensionDir: path.join(h.tmp, 'ext', 'late-bind'),
      dorkHome: h.dorkHome,
      extensionName: 'Late Bind',
      toolChecks,
    });
    const host = makeHost(h, {
      id: 'late-bind',
      bundle,
      overrides: { ctx: built.ctx, tools: toolChecks },
    });
    await startOk(host);
    await new Promise((r) => setTimeout(r, 300));
    expect(h.logs.some((l) => l.message.includes('refused a tool binding after register()'))).toBe(
      true
    );
    expect(built.tools.seal().handled.map((x) => x.tool.name)).toEqual(['wait']);
    built.dispose();
  }, 30_000);

  /** A bundle that binds one tool that never answers, and can crash on cue. */
  const BUNDLE = String.raw`
'use strict';
module.exports = function register(_router, ctx) {
  ctx.tools.handle('wait', () => new Promise(() => undefined));
};
module.exports.probes = {
  crash: () => { setTimeout(() => process.abort(), 10); return 'crashing'; },
};
`;

  // Purpose: when a running child dies, onGone (where the lifecycle takes its
  // tools out of the registry) runs FIRST: while the child's tool binding is
  // still held on the real ctx and before the call waiting on it is
  // rejected; only then is everything released and onExit told. This pins
  // DOR-2685's stop order structurally, not by microtask timing.
  it('calls onGone before it releases the child or rejects its calls', async () => {
    const bundle = path.join(h.tmp, 'bundles', 'tool.js');
    await fs.writeFile(bundle, BUNDLE);
    const manifest = ExtensionManifestSchema.parse({
      id: 'gone-order',
      name: 'Gone Order',
      version: '1.0.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess' },
      tools: [
        {
          name: 'wait',
          title: 'Wait',
          description: 'Never answers.',
          tier: 'observe',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    });
    const toolChecks = checkDeclaredTools(manifest);
    const built = createDataProviderContext({
      extensionId: 'gone-order',
      extensionDir: path.join(h.tmp, 'ext', 'gone-order'),
      dorkHome: h.dorkHome,
      extensionName: 'Gone Order',
      toolChecks,
    });
    const order: string[] = [];
    let settled = false;
    let registrationsAtGone = -1;
    // The callbacks read `host` only once the child runs, after this line.
    const host = makeHost(h, {
      id: 'gone-order',
      bundle,
      onExit: () => order.push(`exit:${host.ctxRegistrations}`),
      overrides: {
        ctx: built.ctx,
        tools: toolChecks,
        onGone: () => {
          registrationsAtGone = host.ctxRegistrations;
          order.push(`gone:${settled ? 'settled' : 'waiting'}`);
        },
      },
    });
    await startOk(host);
    const { handled } = built.tools.seal();
    expect(handled.map((x) => x.tool.name)).toEqual(['wait']);
    const pending = Promise.resolve(
      handled[0]!.handler(
        {},
        Object.freeze({ signal: new AbortController().signal, agentId: null })
      )
    ).finally(() => {
      settled = true;
    });
    pending.catch(() => undefined);
    await host.probe('crash');
    await expect(pending).rejects.toThrow('Probe stopped.');
    expect(registrationsAtGone).toBe(1);
    expect(order).toEqual(['gone:waiting', 'exit:0']);
    built.dispose();
  }, 30_000);
});

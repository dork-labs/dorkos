/**
 * Shared setup for the isolated-tools.integration suites: everything the original file declared or
 * registered outside its tests.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { noopLogger } from '@dorkos/shared/logger';
import type { ExtensionsConfig } from '../../../extension-enable-resolution.js';
import { ExtensionManager } from '../../../extension-manager.js';
import { composeRegistry } from '../../../../core/capabilities/registry.js';
import { CapabilityToolError } from '../../../../core/capabilities/mcp-envelope.js';
import {
  initCapabilityTierGate,
  resetCapabilityTierGate,
} from '../../../../core/capabilities/tier-enforcement.js';
import {
  initPermissionGate,
  resetPermissionGate,
} from '../../../../core/capabilities/permission-enforcement.js';
import { ApprovalService } from '../../../../core/approvals/index.js';
import { eventFanOut } from '../../../../core/event-fan-out.js';
import { permissionActions } from '../../../../core/permissions/index.js';
import type { AgentIdentity } from '../../../../core/agent-identity/agent-identity-service.js';
import { setAgentSendService, type AgentSendService } from '../../../agent-send/agent-send.js';
import { setExtensionInbox, type ExtensionInboxService } from '../../../inbox/extension-inbox.js';
import { type CapabilityRegistry } from '../../../../core/capabilities/registry.js';
import type { PermissionPreset } from '@dorkos/shared/permissions';
import type { AgentPermissions } from '@dorkos/shared/permissions';

/** What each test runs against; the hooks below reset it. */
export const st = {
  dorkHome: undefined as unknown as string,
  extDir: undefined as unknown as string,
  manager: undefined as unknown as ExtensionManager,
  registry: undefined as unknown as CapabilityRegistry,
  approvals: undefined as unknown as ApprovalService,
  preset: undefined as unknown as PermissionPreset,
  agentPermissions: undefined as unknown as AgentPermissions | undefined,
  pids: [] as number[],
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

export const ID = 'iso-tools';

export const NAME = 'Iso Tools';

export const DOMAIN = 'ext_iso_tools';

export const AGENT: AgentIdentity = {
  agentPath: '/agents/mailer',
  displayName: 'Mailer',
  createdAt: new Date().toISOString(),
};

/** One declared tool, observe unless said otherwise. */
export function tool(name: string, extra: Record<string, unknown> = {}) {
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
export const SERVER = `
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

/** Write the extension: manifest with its tools, and its server half. */
export async function install(): Promise<void> {
  await fs.mkdir(st.extDir, { recursive: true });
  await fs.writeFile(
    path.join(st.extDir, 'extension.json'),
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
  await fs.writeFile(path.join(st.extDir, 'index.ts'), 'export function activate() {}\n');
  await fs.writeFile(path.join(st.extDir, 'server.ts'), SERVER);
}

/** Boot the manager as `index.ts` does, with short restart and watchdog timings. */
export async function boot(): Promise<void> {
  st.manager = new ExtensionManager(st.dorkHome, [], {
    dorkosPort: 1,
    restartPolicy: { delays: [300, 300, 300], budget: 3 },
    isolatedTimings: { pingIntervalMs: 200, pongTimeoutMs: 1_500 },
  });
  await st.manager.initialize(null);
  st.manager.attachAgentTools({ registry: st.registry, forgetToolPermissions: async () => [] });
}

/** Call a tool as the agent, through the registry's gate. */
export function call(name: string, input: unknown = {}, approvalToken?: string): Promise<unknown> {
  return st.registry.invoke(`${DOMAIN}.${name}`, input, {
    identity: AGENT,
    retryChannel: 'mcp-argument',
    ...(approvalToken ? { approvalToken } : {}),
  });
}

/** The child's own count of the calls that reached it, and its process id. */
export async function childStats(): Promise<{
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
  st.pids.push(stats.pid);
  return stats;
}

/** The running child's process id, asked of the child itself. */
export async function childPid(): Promise<number> {
  return (await childStats()).pid;
}

/** The refusal a gate decision carries, or null when the call ran. */
export async function refusalOf(
  promise: Promise<unknown>
): Promise<Record<string, unknown> | null> {
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
export async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const began = Date.now();
  while (!(await check())) {
    if (Date.now() - began > ms) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
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

/** The tool error a rejected call carries. */
export async function toolErrorOf(
  promise: Promise<unknown>
): Promise<{ error: string; code: string }> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(CapabilityToolError);
    return (err as CapabilityToolError).payload as { error: string; code: string };
  }
  throw new Error('the call succeeded');
}

beforeEach(async () => {
  st.dorkHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2686-tools-')));
  st.extDir = path.join(st.dorkHome, 'extensions', ID);
  storedHoisted.value = {
    enabled: [ID],
    disabled: [],
    approvedToRun: [ID],
    // Written before approvals named content, so the first scan pins it to the
    // files it finds (the '0.126.1' migration's mark, DOR-3068).
    approvedSources: { [ID]: { path: st.extDir, legacyPathOnly: true } },
    approvedPermissions: { [ID]: { runtime: 'subprocess', net: [], run: [], agents: false } },
  };
  st.preset = 'balanced';
  st.agentPermissions = undefined;
  vi.spyOn(eventFanOut, 'broadcast').mockImplementation(() => {});
  st.approvals = new ApprovalService(createTestDb());
  initCapabilityTierGate({ approvals: st.approvals });
  st.registry = composeRegistry([], { logger: noopLogger });
  initPermissionGate({
    readConfig: () => ({ preset: st.preset, defaults: { areas: {}, actions: {} } }),
    readAgentPermissions: async () => st.agentPermissions,
    listActions: () => permissionActions(st.registry),
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
  await st.manager?.shutdownServer(ID);
  for (const pid of st.pids) expect(alive(pid)).toBe(false);
  st.pids = [];
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.restoreAllMocks();
  setAgentSendService(undefined);
  setExtensionInbox(null);
  await fs.rm(st.dorkHome, { recursive: true, force: true });
});

/** Exported view of the hoisted `stored` (vitest refuses to export a hoisted binding). */
export const stored = storedHoisted;

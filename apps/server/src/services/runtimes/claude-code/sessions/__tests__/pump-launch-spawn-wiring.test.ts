import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn(() => ({}) as never) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createPumpLauncher,
  decideProcessReuse,
  pumpLaunchCallbacks,
  type PumpLaunchPlan,
} from '../pump-launch.js';
import { captureLaunchFingerprint } from '../launch-fingerprint.js';
import { setProcessTokenPort } from '../../../shared/references/process-token-port.js';
import { createTestDb } from '@dorkos/test-utils/db';
import {
  initAgentIdentityService,
  resetAgentIdentityService,
} from '../../../../core/agent-identity/agent-identity-service.js';
import { wireProcessTokenPort } from '../../../../../startup/steps/work-graph.js';
import { MCP_SERVERS_UNKNOWN } from '../launch-live-settings.js';
import type { LaunchFingerprint } from '../launch-fingerprint.js';
import type { AgentSession } from '../../agent-types.js';
import type { MessageSenderOpts } from '../../messaging/message-sender-shared.js';

/**
 * The options object the shared resolver hands BOTH dispatch paths. It is the
 * same object `message-sender.ts` passes to `query()` verbatim on the
 * resume-per-message path, which is what makes the mutation check below
 * meaningful rather than a comparison of one path against itself.
 */
let ownedAccountRoot: string;

function planWithSharedOptions(overrides: Partial<Options> = {}): {
  plan: PumpLaunchPlan;
  sharedOptions: Options;
} {
  const sharedOptions: Options = {
    cwd: '/proj',
    ...overrides,
    env: { ...overrides.env, CLAUDE_CONFIG_DIR: ownedAccountRoot },
  };
  return {
    sharedOptions,
    plan: {
      effectiveCwd: '/proj',
      enrichedContent: 'hello',
      meshAgentId: undefined,
      statusEvents: [],
      sdkOptions: sharedOptions,
      fingerprint: captureLaunchFingerprint({
        accountRoot: ownedAccountRoot,
        options: sharedOptions,
        systemPromptAppendStable: '',
        credentialEnv: {},
        agentIdentity: undefined,
        effortInput: undefined,
        capabilityResolved: true,
      }),
    },
  };
}

function launch(plan: PumpLaunchPlan): void {
  const session = {
    hasStarted: false,
    sdkSessionId: undefined,
    eventQueue: [],
  } as unknown as AgentSession;
  // No cache callbacks, so `fireLaunchProbes` asks the query nothing.
  const opts = {} as MessageSenderOpts;
  const launcher = createPumpLauncher(session, opts, () => plan, {
    onLaunched: () => {},
    onServersNotHeld: () => {},
  });
  launcher({ sessionId: 'sess-1', prompt: (async function* () {})() as never, resuming: false });
}

beforeEach(() => {
  ownedAccountRoot = mkdtempSync(join(tmpdir(), 'pump-launch-account-'));
  queryMock.mockClear();
});

afterEach(() => {
  rmSync(ownedAccountRoot, { recursive: true, force: true });
});

describe('the persistent pump launch records its process', () => {
  it('hands query() a spawnClaudeCodeProcess seam', () => {
    const { plan } = planWithSharedOptions();

    launch(plan);

    expect(queryMock).toHaveBeenCalledTimes(1);
    const passed = (queryMock.mock.calls as unknown as Array<[{ options: Options }]>)[0]?.[0];
    // Without this the pid is never written down, and a hard-killed server
    // leaves this process orphaned with nothing to reap it (DOR-1310).
    expect(typeof passed?.options.spawnClaudeCodeProcess).toBe('function');
  });

  it('reports the identity token its process holds while that process runs (DOR-5264)', async () => {
    const reported: string[] = [];
    setProcessTokenPort({
      processStarted: (env, chatId) =>
        reported.push(`started ${env?.DORKOS_AGENT_TOKEN} ${chatId}`),
      processEnded: (env) => reported.push(`ended ${env?.DORKOS_AGENT_TOKEN}`),
    });
    try {
      const { plan } = planWithSharedOptions({ env: { DORKOS_AGENT_TOKEN: 'tok-1' } });
      launch(plan);
      // A token reaches no process until one spawns: the turn's mint names nothing.
      expect(reported).toEqual([]);
      const passed = (queryMock.mock.calls as unknown as Array<[{ options: Options }]>)[0]![0];
      const child = passed.options.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        cwd: ownedAccountRoot,
        env: { ...process.env },
        signal: new AbortController().signal,
      });
      expect(reported).toEqual(['started tok-1 sess-1']);
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      expect(reported).toEqual(['started tok-1 sess-1', 'ended tok-1']);
    } finally {
      setProcessTokenPort(undefined);
    }
  });

  it('leaves the resume-per-message path’s options untouched', () => {
    // The deliberate asymmetry: only a PERSISTENT process can outlive the
    // server, so only it is tracked. The seam must therefore be added to a COPY
    // — mutating the shared resolver output would silently put every
    // resume-per-message turn through the custom spawner too, losing the SDK's
    // own stderr handling on a path that never needed tracking.
    const { plan, sharedOptions } = planWithSharedOptions();

    launch(plan);

    expect(sharedOptions.spawnClaudeCodeProcess).toBeUndefined();
    expect(plan.sdkOptions.spawnClaudeCodeProcess).toBeUndefined();
  });
});

describe('a warm process and the tokens turns mint for it (DOR-5264)', () => {
  it('N turns on one launched process leave one entry, and a token no process got names nothing', async () => {
    const identities = initAgentIdentityService(createTestDb());
    wireProcessTokenPort();
    let child: ReturnType<NonNullable<Options['spawnClaudeCodeProcess']>> | undefined;
    try {
      const minted = async () => ({
        DORKOS_AGENT_TOKEN: await identities.mint({ agentPath: '/agents/ana', displayName: 'Ana' }),
      });
      // Each dispatch resolves a plan, and with it a freshly minted token.
      let current = planWithSharedOptions({ env: await minted() }).plan;
      const launcher = createPumpLauncher(
        { hasStarted: false, sdkSessionId: undefined, eventQueue: [] } as unknown as AgentSession,
        {} as MessageSenderOpts,
        () => current,
        { onLaunched: () => {}, onServersNotHeld: () => {} }
      );
      launcher({
        sessionId: 'sess-1',
        prompt: (async function* () {})() as never,
        resuming: false,
      });
      const passed = (queryMock.mock.calls as unknown as Array<[{ options: Options }]>)[0]![0];
      child = passed.options.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30000)'],
        cwd: ownedAccountRoot,
        env: { ...process.env },
        signal: new AbortController().signal,
      });
      const launched = current.sdkOptions.env!.DORKOS_AGENT_TOKEN!;

      // Ten more turns ride the warm process: each mints, and none launches.
      const neverLaunched: string[] = [];
      for (let turn = 0; turn < 10; turn += 1) {
        current = planWithSharedOptions({ env: await minted() }).plan;
        neverLaunched.push(current.sdkOptions.env!.DORKOS_AGENT_TOKEN!);
      }

      expect(identities.chats.size).toBe(1);
      expect((await identities.resolve(launched))?.chatId).toBe('sess-1');
      for (const token of neverLaunched)
        expect((await identities.resolve(token))?.chatId).toBeUndefined();
    } finally {
      if (child && child.exitCode === null && !child.killed) child.kill('SIGKILL');
      setProcessTokenPort(undefined);
      resetAgentIdentityService();
    }
  });
});

describe('a process that did not answer for its servers in time (DOR-3882)', () => {
  const inProcess = { type: 'sdk', name: 'dorkos' } as never;
  const stdio = { type: 'stdio', command: 'node', env: { TOKEN: 'CANARY' } } as never;
  const fingerprint = {
    live: { mcpServers: { dorkos: inProcess, stdio } },
  } as unknown as LaunchFingerprint;
  const emptySlot = () =>
    ({ live: undefined, fingerprint: undefined }) as Parameters<typeof pumpLaunchCallbacks>[0];

  it('a Remove of its only external server still goes out, for a server that landed late', async () => {
    // Security's P1: the CLI finishes a slow request, so recording "in-process
    // only" here left the Remove reading as no change, and the server running.
    const slot = emptySlot();
    const callbacks = pumpLaunchCallbacks(slot);
    const live = {} as never;
    const launched = captureLaunchFingerprint({
      accountRoot: '/staged/claude-client',
      options: { cwd: '/repo', mcpServers: { dorkos: inProcess, stdio } } as Options,
      systemPromptAppendStable: '',
      credentialEnv: {},
      agentIdentity: undefined,
      effortInput: undefined,
      capabilityResolved: true,
    });
    callbacks.onLaunched(live, launched);
    callbacks.onServersNotHeld(live);
    expect(slot.fingerprint?.live.mcpServers).toBe(MCP_SERVERS_UNKNOWN);

    const afterRemove = captureLaunchFingerprint({
      accountRoot: '/staged/claude-client',
      options: { cwd: '/repo', mcpServers: { dorkos: inProcess } } as Options,
      systemPromptAppendStable: '',
      credentialEnv: {},
      agentIdentity: undefined,
      effortInput: undefined,
      capabilityResolved: true,
    });
    const reuse = decideProcessReuse(slot.fingerprint, afterRemove);
    expect(reuse.action).toBe('adjust');
    if (reuse.action !== 'adjust') return;
    const setMcpServers = vi.fn(async () => ({}));
    await reuse.apply({ setMcpServers } as never);
    expect(setMcpServers).toHaveBeenCalledWith({ dorkos: inProcess });
  });

  it('changes nothing when that process has since gone', () => {
    const slot = emptySlot();
    pumpLaunchCallbacks(slot).onServersNotHeld({} as never);
    expect(slot.live).toBeUndefined();
    expect(slot.fingerprint).toBeUndefined();
    const other = emptySlot();
    const callbacks = pumpLaunchCallbacks(other);
    callbacks.onLaunched({} as never, fingerprint);
    callbacks.onServersNotHeld({} as never);
    expect(other.fingerprint).toBe(fingerprint);
  });
});

describe('the persistent launch keeps servers off the command line (DOR-3882)', () => {
  it('passes query() no external server, and hands them over stdin', async () => {
    const setMcpServers = vi.fn(async () => ({}));
    queryMock.mockImplementationOnce(() => ({ setMcpServers }) as never);
    const stdio = { type: 'stdio', command: 'node', env: { TOKEN: 'CANARY' } } as never;
    const { plan } = planWithSharedOptions({ mcpServers: { stdio } });
    launch(plan);
    const passed = (queryMock.mock.calls as unknown as Array<[{ options: Options }]>)[0]?.[0];
    expect(JSON.stringify(passed?.options)).not.toContain('CANARY');
    expect(passed?.options).not.toHaveProperty('mcpServers');
    await vi.waitFor(() => expect(setMcpServers).toHaveBeenCalledWith({ stdio }));
  });
});

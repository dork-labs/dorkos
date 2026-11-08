import { describe, it, expect, vi, beforeEach } from 'vitest';
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
function planWithSharedOptions(): { plan: PumpLaunchPlan; sharedOptions: Options } {
  const sharedOptions: Options = { cwd: '/proj' };
  return {
    sharedOptions,
    plan: {
      effectiveCwd: '/proj',
      enrichedContent: 'hello',
      meshAgentId: undefined,
      statusEvents: [],
      sdkOptions: sharedOptions,
      fingerprint: {} as PumpLaunchPlan['fingerprint'],
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
  queryMock.mockClear();
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
    const { plan } = planWithSharedOptions();
    plan.sdkOptions = { cwd: '/proj', mcpServers: { stdio } };
    launch(plan);
    const passed = (queryMock.mock.calls as unknown as Array<[{ options: Options }]>)[0]?.[0];
    expect(JSON.stringify(passed?.options)).not.toContain('CANARY');
    expect(passed?.options).not.toHaveProperty('mcpServers');
    await vi.waitFor(() => expect(setMcpServers).toHaveBeenCalledWith({ stdio }));
  });
});

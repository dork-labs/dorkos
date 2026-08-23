import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Options } from '@anthropic-ai/claude-agent-sdk';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn(() => ({}) as never) }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: queryMock }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createPumpLauncher, type PumpLaunchPlan } from '../pump-launch.js';
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
  const session = { hasStarted: false, sdkSessionId: undefined } as unknown as AgentSession;
  // No cache callbacks, so `fireLaunchProbes` asks the query nothing.
  const opts = {} as MessageSenderOpts;
  const launcher = createPumpLauncher(
    session,
    opts,
    () => plan,
    () => {}
  );
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

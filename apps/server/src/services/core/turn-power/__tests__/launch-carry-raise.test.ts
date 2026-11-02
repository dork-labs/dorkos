/**
 * A Wi-Fi hold on an agent's turn rides onto the chat it starts, over the API
 * (`POST /:id/messages`) and with `session_start`, as a mark, never a ceiling
 * (DOR-3561, Security on #3280): the new chat keeps its level, and is refused a
 * raise. Driven through the real launch spreads, the real level record and the
 * real own-folder gate; only the agent's set level stands in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { countWhileRunning, resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import { recordTurnLevels } from '../turn-levels.js';

// Bo is set to Full by a person, so the one thing that can keep its own folder
// closed here is a mark (`resolveOwnFolderOpen`).
vi.mock('../../../session/resolution/resolve-session-defaults.js', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('../../../session/resolution/resolve-session-defaults.js')
    >();
  return {
    ...real,
    readAgentExecutionDefaults: async (home: string) =>
      home === '/agents/bo'
        ? { filesAndCommands: 'autonomy' }
        : real.readAgentExecutionDefaults(home),
  };
});
vi.mock('../../runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    has: (type: string) => type === 'claude-code',
    get: () => ({ getCapabilities: () => CLAUDE_CODE_CAPABILITIES }),
    getSessionSettings: async () => null,
  },
}));
// The request is not from Wi-Fi: only the agent's own turn can carry a hold.
vi.mock('../../auth/sessions/wifi-turn-ceiling.js', () => ({ wifiTurnCeiling: () => ({}) }));
vi.mock('../../auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../auth/index.js')>()),
  readOwnerAccount: () => null,
}));
vi.mock('../../config-manager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config-manager.js')>()),
  configManager: {
    get: (section: string) => (section === 'auth' ? { enabled: false } : undefined),
    set: () => {},
  },
}));

const { launcherTurnCeiling } = await import('../../../../routes/session-launcher.js');
const { outsiderStartCeiling } =
  await import('../../../runtimes/claude-code/mcp-tools/session-start-facts.js');
const { resolveOwnFolderOpen } =
  await import('../../../runtimes/claude-code/folder-settings/own-folder-open.js');

const FULL = 'bypassPermissions';
const BO = '/agents/bo';

/** Run one Full turn of Bo's on `sessionId` through the real level record. */
async function runTurn(sessionId: string, opts: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => FULL
  );
  for await (const _event of runtime.sendMessage(sessionId, 'go', opts)) {
    // drained: the record is what is under test
  }
}

/** Whether the started chat's turn may open Bo's own folder setup: a raise. */
async function startedMayRaise(sessionId: string, opts: MessageOpts): Promise<boolean> {
  await runTurn(sessionId, opts);
  return resolveOwnFolderOpen({ home: BO, turnMode: FULL, session: {}, sessionId });
}

afterEach(() => resetLiveOutsiderTurns());

describe('POST /:id/messages from an agent whose turn holds a Wi-Fi mark', () => {
  it('starts a chat that keeps its level and is refused a raise', async () => {
    const held = countWhileRunning(
      { forAgent: BO },
      { outsider: true },
      (async function* () {
        await new Promise(() => undefined);
      })()
    );
    void held.next();

    const launch = launcherTurnCeiling({ kind: 'agent', agentPath: BO }, {} as never);
    expect(launch).toEqual({ carriedMarks: { outsider: true } });
    expect(await startedMayRaise('api-marked', launch)).toBe(false);

    const { carriedMarks: _dropped, ...unmarked } = launch;
    expect(await startedMayRaise('api-mark-dropped', unmarked)).toBe(true);
  });

  it('starts a clean chat from a clean turn, and it may raise', async () => {
    const launch = launcherTurnCeiling({ kind: 'agent', agentPath: BO }, {} as never);
    expect(launch).toEqual({});
    expect(await startedMayRaise('api-clean', launch)).toBe(true);
  });
});

describe('session_start from a chat whose turn holds a Wi-Fi mark', () => {
  it('starts a chat that keeps its level and is refused a raise', async () => {
    await runTurn('held-starter', { permissionCeiling: 'runtime-default' });

    const start = outsiderStartCeiling({ agentPath: BO, chat: { sessionId: 'held-starter' } });
    expect(start).toEqual({ carriedMarks: { outsider: true } });
    expect(await startedMayRaise('start-marked', start)).toBe(false);

    const { carriedMarks: _dropped, ...unmarked } = start;
    expect(await startedMayRaise('start-mark-dropped', unmarked)).toBe(true);
  });

  it('starts a clean chat from a clean chat, and it may raise', async () => {
    await runTurn('clean-starter', {});
    const start = outsiderStartCeiling({ agentPath: BO, chat: { sessionId: 'clean-starter' } });
    expect(start).toEqual({});
    expect(await startedMayRaise('start-clean', start)).toBe(true);
  });
});

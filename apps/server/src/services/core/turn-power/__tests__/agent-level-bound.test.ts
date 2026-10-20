/**
 * Every turn starts no looser than its agent's current level (DOR-3175).
 *
 * Driven through the REAL registration seam: a real `RuntimeRegistry` over a
 * real SQLite db wraps a fake runtime in every production decorator, and the
 * fake launches the way Claude Code does (`turnPermissionMode`: the stored mode
 * held to the turn's ceiling). Only the agent's level is stubbed, by agent, so
 * each case can say what a person set it to.
 *
 * The room rows send what the room dispatcher sends a seat: the agent's home as
 * `cwd` and the seat's `roomTurn`. A Write in Claude Code raises a card only
 * under a mode that asks before an edit (`default`), so each row reads the mode
 * the turn launched at.
 *
 * Seeded defects, each red before the code stood:
 *
 * - Dropping `boundToAgentLevel` from `decorateRuntime` reddens every "lower" row.
 * - Placing it inside `recordTurnLevels` reddens "hands on the level it ran at".
 * - Adding the bound when it does not bind reddens "sends a turn its level
 *   admits exactly as asked".
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type {
  AgentRuntime,
  MessageOpts,
  RuntimeCapabilities,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import type { PermissionStop } from '@dorkos/shared/agent-runtime';
import { clampModeToCeiling } from '@dorkos/shared/permission-semantics';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { resolveModeDecision } from '../../../runtimes/claude-code/turn-permission.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { lastTurnLevelOf } from '../turn-levels.js';
import { levelBinds } from '../agent-level-bound.js';

/** What a person set each agent's Files & commands to; absent = nothing configured. */
const agentStops = new Map<string, PermissionStop>();
/** Agents whose level cannot be read. */
const unreadable = new Set<string>();

const STOP_MODE: Record<PermissionStop, string> = {
  ask: 'default',
  act: 'acceptEdits',
  autonomy: 'bypassPermissions',
};

vi.mock('../../../session/resolution/agent-launch-level.js', () => ({
  resolveAgentLaunchLevel: async ({ agentPath }: { agentPath: string }) => {
    if (unreadable.has(agentPath)) throw new Error('manifest unreadable');
    const stop = agentStops.get(agentPath) ?? null;
    return { stop, mode: stop ? STOP_MODE[stop] : undefined };
  },
}));

// Imported after the mock, so the seam reads the stubbed level.
const { RuntimeRegistry } = await import('../../runtime-registry.js');

const ANA = '/agents/ana';
const BOB = '/agents/bob';
const ROOM = 'room-1';

/** One launch the fake runtime saw. */
interface Launch {
  sessionId: string;
  mode: string;
  ceiling: TurnPermissionCeiling | undefined;
}

/** A runtime that launches the way Claude Code does, and remembers each launch. */
function launchingRuntime(
  type: string,
  capabilities: RuntimeCapabilities,
  storedModeOf: (sessionId: string) => string | null
) {
  const launches: Launch[] = [];
  const declared = capabilities.permissionModes;
  const launch = (sessionId: string, opts: MessageOpts | undefined) => {
    const chosen = opts?.permissionMode ?? storedModeOf(sessionId) ?? declared.default!;
    const ceiling = opts?.permissionCeiling;
    launches.push({
      sessionId,
      mode: ceiling === undefined ? chosen : clampModeToCeiling(declared, chosen, ceiling),
      ceiling,
    });
  };
  const runtime = {
    type,
    getCapabilities: () => ({ ...capabilities, type }),
    getSessionCwd: () => undefined,
    async *sendMessage(
      sessionId: string,
      _content: string,
      opts?: MessageOpts
    ): AsyncGenerator<StreamEvent> {
      launch(sessionId, opts);
      yield { type: 'done', data: { sessionId } } as unknown as StreamEvent;
    },
    async *executeCommandIntent(
      sessionId: string,
      _intent: string,
      opts?: MessageOpts
    ): AsyncGenerator<StreamEvent> {
      launch(sessionId, opts);
      yield { type: 'done', data: { sessionId } } as unknown as StreamEvent;
    },
  };
  return { runtime: runtime as unknown as AgentRuntime, launches };
}

/** Drain a turn to its end. */
async function run(turn: AsyncGenerator<StreamEvent>): Promise<void> {
  for await (const _event of turn) {
    // drain
  }
}

/** What a room dispatch sends a seat of `agent`. */
function seatOpts(agent: string, extra: Partial<MessageOpts> = {}): MessageOpts {
  return {
    cwd: agent,
    roomTurn: { roomId: ROOM, agentPath: agent },
    ...extra,
  } as MessageOpts;
}

/** Whether a Write in Claude Code would raise a card under this mode. */
function writeCards(mode: string): boolean {
  // The CLI allows an edit itself under these, and never hands it to the gate.
  if (mode === 'acceptEdits' || mode === 'bypassPermissions' || mode === 'auto') return false;
  return resolveModeDecision(mode) === 'ask';
}

describe('an agent’s level bounds every turn it starts (DOR-3175)', () => {
  let db: ReturnType<typeof createTestDb>;
  let registry: InstanceType<typeof RuntimeRegistry>;
  let launches: Launch[];

  /** A fresh registry over the same db, as after a restart. */
  function boot(
    type = 'claude-code',
    capabilities: RuntimeCapabilities = CLAUDE_CODE_CAPABILITIES
  ) {
    registry = new RuntimeRegistry();
    registry.setDb(db);
    const fake = launchingRuntime(type, capabilities, (id) => registry.storedPermissionModeOf(id));
    launches = fake.launches;
    registry.register(fake.runtime);
    return registry.get(type);
  }

  beforeEach(() => {
    db = createTestDb();
    agentStops.clear();
    unreadable.clear();
    registerTestHomes([ANA, BOB]);
  });
  afterEach(() => clearTestHomes());

  describe('the lower (QA rows)', () => {
    it('a seat stored at Full, its agent then capped at Ask: the same room’s next Write cards', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-a', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-a', 'write it', seatOpts(ANA)));
      expect(writeCards(launches.at(-1)!.mode)).toBe(false);

      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('seat-a', 'write it again', seatOpts(ANA)));

      expect(launches.at(-1)!.mode).toBe('default');
      expect(writeCards(launches.at(-1)!.mode)).toBe(true);
      // The stored seat is never rewritten: the bound lives on the turn.
      expect(registry.storedPermissionModeOf('seat-a')).toBe('bypassPermissions');
    });

    it('a new room follows the cap too', async () => {
      const runtime = boot();
      agentStops.set(ANA, 'ask');
      // A new seat's first turn carries the seed it was born with.
      await run(
        runtime.sendMessage(
          'seat-new',
          'hi',
          seatOpts(ANA, { permissionMode: 'bypassPermissions' })
        )
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('a marked seat stays held to its mark under the cap', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-marked', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'act');
      // A stranger's words in view hold the turn to the runtime's default.
      await run(
        runtime.sendMessage(
          'seat-marked',
          'hi',
          seatOpts(ANA, { permissionCeiling: 'runtime-default' })
        )
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('holds a resumed seat after a restart, reading only what is stored', async () => {
      boot();
      await registry.saveSessionSettings('seat-r', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');

      const afterRestart = boot();
      await run(afterRestart.sendMessage('seat-r', 'still there?', seatOpts(ANA)));

      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('lowers a scheduled run that names a looser mode', async () => {
      const runtime = boot();
      agentStops.set(ANA, 'act');
      await run(
        runtime.sendMessage('run-1', 'nightly', {
          cwd: ANA,
          forAgent: ANA,
          permissionMode: 'bypassPermissions',
          unattended: true,
        })
      );
      expect(launches.at(-1)!.mode).toBe('acceptEdits');
    });

    it('lowers a mini app’s work for an agent', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('mini-1', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');
      // A mini app starts work AS the agent, in a folder that names nobody.
      await run(runtime.sendMessage('mini-1', 'do it', { cwd: '/tmp/work', forAgent: ANA }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('lowers a seat moved onto Codex', async () => {
      const runtime = boot('codex', CODEX_CAPABILITIES);
      await registry.saveSessionSettings('seat-codex', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'act');
      await run(runtime.sendMessage('seat-codex', 'carry on', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('acceptEdits');
    });

    it('lowers a command intent (a summary is a turn too)', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-c', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');
      await run(runtime.executeCommandIntent('seat-c', 'compact', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('reads the agent recorded for a chat whose folder names nobody', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-1', { permissionMode: 'bypassPermissions' });
      vi.spyOn(registry, 'getSessionAgentPath').mockResolvedValue(ANA);
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('chat-1', 'hi', { cwd: '/tmp/elsewhere' }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('hands on the level it ran at, not the stored one', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-h', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('seat-h', 'post something', seatOpts(ANA)));
      const level = lastTurnLevelOf('seat-h');
      expect(level).toMatchObject({ asks: 'always', reach: 'edit' });
      // A cap is no mark: the post it writes reads as neither a stranger's nor a teammate's.
      expect(level?.outsider).toBeUndefined();
      expect(level?.teammate).toBeUndefined();
    });

    it('holds the turn to the runtime’s default when the level cannot be read', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-u', { permissionMode: 'bypassPermissions' });
      unreadable.add(ANA);
      await run(runtime.sendMessage('seat-u', 'hi', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('default');
    });
  });

  describe('what it leaves alone', () => {
    it('sends a turn its level admits exactly as asked', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-ok', { permissionMode: 'default' });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-ok', 'hi', seatOpts(ANA)));
      expect(launches.at(-1)!.ceiling).toBeUndefined();
    });

    it('never raises: a seat at Ask stays at Ask under a Full agent (the raise is its own change)', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-ask', { permissionMode: 'default' });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-ask', 'hi', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('leaves a chat with no agent as it was', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('plain', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('plain', 'hi', { cwd: '/tmp/nobody' }));
      expect(launches.at(-1)!.mode).toBe('bypassPermissions');
      expect(launches.at(-1)!.ceiling).toBeUndefined();
    });

    it('leaves a turn alone when nothing is configured anywhere', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-n', { permissionMode: 'bypassPermissions' });
      await run(runtime.sendMessage('seat-n', 'hi', seatOpts(BOB)));
      expect(launches.at(-1)!.ceiling).toBeUndefined();
    });

    it('binds a chat with no stored mode, whose mode it cannot see', () => {
      const declared = CLAUDE_CODE_CAPABILITIES.permissionModes;
      const ask = { asks: 'always', reach: 'edit' } as const;
      expect(levelBinds(declared, ask, null, undefined)).toBe(true);
    });

    it('keeps Plan, which every level admits', () => {
      const declared = CLAUDE_CODE_CAPABILITIES.permissionModes;
      const ask = { asks: 'always', reach: 'edit' } as const;
      expect(levelBinds(declared, ask, 'plan', undefined)).toBe(false);
    });
  });
});

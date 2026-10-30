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
import {
  chosenFullAutonomy,
  resolveModeDecision,
  turnPermissionMode,
} from '../../../runtimes/claude-code/turn-permission.js';
import { choseFullAutonomy, resetChosenTurns } from '../full-autonomy.js';
import { getAccountTools } from '../../../runtimes/claude-code/mcp-tools/account-tools.js';
import {
  registerTestHomes,
  clearTestHomes,
} from '../../agent-identity/__tests__/agent-home-fixture.js';
import { roomSessions, rooms, sessionMetadata } from '@dorkos/db';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import { DOE_CAPABILITIES } from '../../../runtimes/doe/runtime-constants.js';
import {
  parseCeiling,
  senderCeilingJson,
} from '../../../session/chat-messages/chat-message-ceiling.js';
import { ceilingCarrying } from '../turn-marks.js';
import { lastTurnLevelOf } from '../turn-levels.js';
import { levelBinds } from '../agent-level-bound.js';
import { createChatRiseFacts, setChatRiseFacts } from '../chat-rise-facts.js';
import { setContinuationHoldDb } from '../continuation-hold.js';

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
    // Claude Code's own launch read; Codex's is the same rule over its own modes.
    const mode =
      type === 'claude-code'
        ? turnPermissionMode({
            permissionMode: chosen,
            ...(opts?.levelPermissionMode !== undefined
              ? { turnLevelMode: opts.levelPermissionMode }
              : {}),
            ...(ceiling !== undefined ? { turnPermissionCeiling: ceiling } : {}),
          })
        : ((start: string) =>
            ceiling === undefined ? start : clampModeToCeiling(declared, start, ceiling))(
            opts?.levelPermissionMode ?? chosen
          );
    launches.push({ sessionId, mode, ceiling });
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

  /** A chat as its launch left it: an own origin, not held, stored at `mode`. */
  function seedChat(
    sessionId: string,
    mode: string | null,
    extra: Partial<typeof sessionMetadata.$inferInsert> = {}
  ) {
    db.insert(sessionMetadata)
      .values({
        sessionId,
        runtime: 'claude-code',
        agentPath: ANA,
        launchOrigin: 'interactive',
        lastTurnHeld: false,
        permissionMode: mode,
        createdAt: new Date().toISOString(),
        ...extra,
      })
      .run();
  }

  /** A room seat of Ana's, in a room of this computer. */
  function seedSeat(sessionId: string, mode: string | null, roomId = ROOM) {
    db.insert(rooms)
      .values({
        id: roomId,
        kind: 'channel',
        title: 'Build',
        createdAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
      } as typeof rooms.$inferInsert)
      .onConflictDoNothing()
      .run();
    db.insert(roomSessions)
      .values({ roomId, authorId: 'author-ana', sessionId, createdAt: new Date().toISOString() })
      .run();
    seedChat(sessionId, mode, { launchOrigin: 'room' });
  }

  beforeEach(() => {
    db = createTestDb();
    agentStops.clear();
    unreadable.clear();
    registerTestHomes([ANA, BOB]);
    setContinuationHoldDb(db);
    setChatRiseFacts(createChatRiseFacts(db));
  });
  afterEach(() => {
    clearTestHomes();
    setContinuationHoldDb(undefined);
    setChatRiseFacts(null);
  });

  describe('a sender below Full messages an agent at Full (DOR-3440, the live case)', () => {
    const BELOW_FULL = { asks: 'always', reach: 'edit' } as const;

    it.each([
      [
        'a row this build stores',
        senderCeilingJson(
          { turnLevelOf: () => BELOW_FULL },
          { sessionId: 'sender', agentPath: BOB }
        ),
      ],
      ['a plain level an older build stored', JSON.stringify(BELOW_FULL)],
      ['an older row with a plain level in a list', JSON.stringify([BELOW_FULL])],
    ])('0 cards: %s', async (_name, stored) => {
      const permissionCeiling = parseCeiling(stored);
      expect(permissionCeiling).toBeUndefined();

      const runtime = boot();
      agentStops.set(ANA, 'autonomy');
      seedChat('dm-1', 'bypassPermissions', { launchOrigin: 'chat-message' });
      await run(runtime.sendMessage('dm-1', 'do it', { cwd: ANA }));

      const { mode, ceiling } = launches.at(-1)!;
      expect(mode).toBe('bypassPermissions');
      expect(ceiling).toBeUndefined();
      expect(
        chosenFullAutonomy({
          permissionMode: mode,
          ...(ceiling !== undefined ? { turnPermissionCeiling: ceiling } : {}),
        })
      ).toBe(true);
      expect(writeCards(mode)).toBe(false);
    });
  });

  describe('a teammate’s record never raises a turn (DOR-3440, Security)', () => {
    const TEAMMATE = [{ roomId: ROOM, authorId: 'member' }];
    const record = ceilingCarrying({ teammate: TEAMMATE })!;
    /** A chain as an older build stored it on a chat message row, read back. */
    const olderRow = parseCeiling(
      JSON.stringify(['runtime-default', { asks: 'always', reach: 'read', teammate: TEAMMATE }])
    )!;
    /** The same chain as this build stores it, read back. */
    const newRow = parseCeiling(JSON.stringify(record))!;

    it.each([
      ['a room turn', record],
      ['a chat hop', newRow],
      ['a chat hop from an older build’s row', olderRow],
    ])('an agent at Ask still asks: %s', async (_name, ceiling) => {
      const runtime = boot();
      agentStops.set(ANA, 'ask');
      seedChat('chat-1', null);
      await run(
        runtime.sendMessage('chat-1', 'write it', { cwd: ANA, permissionCeiling: ceiling })
      );
      expect(launches.at(-1)!.mode).toBe('default');
      expect(writeCards(launches.at(-1)!.mode)).toBe(true);
      expect(lastTurnLevelOf('chat-1')?.teammate).toEqual(TEAMMATE);
    });

    it('a chat stored at Full whose agent is at Ask still asks, and after a restart', async () => {
      seedChat('chat-2', 'bypassPermissions');
      agentStops.set(ANA, 'ask');
      for (const _boot of [1, 2]) {
        const runtime = boot();
        await run(runtime.sendMessage('chat-2', 'go', { cwd: ANA, permissionCeiling: record }));
        expect(launches.at(-1)!.mode).toBe('default');
      }
      expect(registry.storedPermissionModeOf('chat-2')).toBe('bypassPermissions');
    });

    it('a chat the chain opened runs at its agent’s level, not the record’s', async () => {
      const runtime = boot();
      seedChat('opened-ask', null, { launchOrigin: 'chat-message' });
      seedChat('opened-act', null, { launchOrigin: 'chat-message' });
      seedChat('opened-full', null, { launchOrigin: 'chat-message' });
      for (const [id, stop, mode] of [
        ['opened-ask', 'ask', 'default'],
        ['opened-act', 'act', 'acceptEdits'],
        ['opened-full', 'autonomy', 'bypassPermissions'],
      ] as const) {
        agentStops.set(ANA, stop);
        await run(runtime.sendMessage(id, 'go', { cwd: ANA, permissionCeiling: newRow }));
        expect(launches.at(-1)!.mode, id).toBe(mode);
      }
    });

    it('a schedule’s named mode stays below a Full agent: the record does not raise it', async () => {
      const runtime = boot();
      agentStops.set(ANA, 'autonomy');
      seedChat('run-1', null, { launchOrigin: 'schedule' });
      await run(
        runtime.sendMessage('run-1', 'go', {
          cwd: ANA,
          permissionMode: 'acceptEdits',
          permissionCeiling: record,
        })
      );
      expect(launches.at(-1)!.mode).toBe('acceptEdits');
    });

    it.each([
      ['Claude Code', CLAUDE_CODE_CAPABILITIES],
      ['Codex', CODEX_CAPABILITIES],
      ['OpenCode', OPENCODE_CAPABILITIES],
      ['Doe', DOE_CAPABILITIES],
    ])('%s: the clamp leaves every declared mode as it is', (_name, capabilities) => {
      const declared = capabilities.permissionModes;
      for (const { id } of declared.values) {
        for (const ceiling of [record, newRow, olderRow]) {
          expect(clampModeToCeiling(declared, id, ceiling), id).toBe(id);
        }
      }
    });

    it('Codex: a chat stored at its loosest mode, its agent capped, stays capped', async () => {
      const runtime = boot('codex', CODEX_CAPABILITIES);
      seedChat('codex-1', 'bypassPermissions', { runtime: 'codex' });
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('codex-1', 'go', { cwd: ANA, permissionCeiling: record }));
      // Codex's own Ask: a read-only sandbox.
      expect(launches.at(-1)!.mode).toBe('default');
    });
  });

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

    it('a warm Full seat lowered to Ask is not Full on its next marked turn (DOR-3416)', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('seat-lwp', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-lwp', 'warm up', seatOpts(ANA)));
      expect(choseFullAutonomy('seat-lwp')).toBe(true);

      agentStops.set(ANA, 'ask');
      // Outside words: a stranger's hold, which on its own already holds the turn at Ask.
      await run(
        runtime.sendMessage(
          'seat-lwp',
          'write it',
          seatOpts(ANA, { permissionCeiling: 'runtime-default' })
        )
      );
      const turn = launches.at(-1)!;
      expect(turn.mode).toBe('default');
      // The agent's level rides the ceiling beside the hold, so what reads the level the chat is
      // set to (the hold set aside) still sees Ask, not the stored Full.
      expect(JSON.stringify(turn.ceiling)).toContain('runtime-default');
      expect(
        chosenFullAutonomy({
          permissionMode: 'bypassPermissions',
          ...(turn.ceiling !== undefined ? { turnPermissionCeiling: turn.ceiling } : {}),
        })
      ).toBe(false);
      expect(choseFullAutonomy('seat-lwp')).toBe(false);
      // So what a marked turn may do only at Full is refused again: the account usage read.
      const usage = getAccountTools({} as never, () => ({
        sessionId: 'seat-lwp',
        agentPath: ANA,
      })).find((t) => (t as { name: string }).name === 'accounts_usage') as unknown as {
        handler: (args: object, extra: unknown) => Promise<{ content: { text: string }[] }>;
      };
      expect((await usage.handler({}, {})).content[0]!.text).toContain('MARKED_TURN');
      resetChosenTurns();
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

  describe('which agent holds a chat (QA rows G and H)', () => {
    it('G: a chat in a nested subfolder of its agent’s folder cards after the cap', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-g', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('chat-g', 'write it', { cwd: `${ANA}/sub/deep` }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('H: a chat in a sibling worktree is held by the agent recorded at launch', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-h', { permissionMode: 'bypassPermissions' });
      vi.spyOn(registry, 'getSessionAgentPath').mockResolvedValue(ANA);
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('chat-h', 'write it', { cwd: '/work/ana-wt' }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('holds a chat to the default when its recorded agent matches no folder', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-gone', { permissionMode: 'bypassPermissions' });
      vi.spyOn(registry, 'getSessionAgentPath').mockResolvedValue('/agents/unregistered');
      await run(runtime.sendMessage('chat-gone', 'write it', { cwd: '/work/elsewhere' }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('A in B: a chat of Ana’s standing in Bob’s folder keeps Ana’s cap', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-a-in-b', { permissionMode: 'bypassPermissions' });
      vi.spyOn(registry, 'getSessionAgentPath').mockResolvedValue(ANA);
      agentStops.set(ANA, 'ask');
      agentStops.set(BOB, 'autonomy');
      await run(runtime.sendMessage('chat-a-in-b', 'write it', { cwd: `${BOB}/sub` }));
      expect(writeCards(launches.at(-1)!.mode)).toBe(true);
    });

    it('A in B: and keeps Bob’s cap too, the stricter of both', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-a-in-b2', { permissionMode: 'bypassPermissions' });
      vi.spyOn(registry, 'getSessionAgentPath').mockResolvedValue(ANA);
      agentStops.set(ANA, 'autonomy');
      agentStops.set(BOB, 'ask');
      await run(runtime.sendMessage('chat-a-in-b2', 'write it', { cwd: `${BOB}/sub` }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('A in B: a turn that names Ana is held by Ana’s level', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-a-in-b3', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'ask');
      agentStops.set(BOB, 'autonomy');
      await run(
        runtime.sendMessage('chat-a-in-b3', 'write it', { cwd: `${BOB}/sub`, forAgent: ANA })
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('G: born at Full, capped, uncapped: back to 0 cards, as the history line counts it', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-g-cycle', { permissionMode: 'bypassPermissions' });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-g-cycle', 'go', { cwd: `${ANA}/sub/deep` }));
      expect(writeCards(launches.at(-1)!.mode)).toBe(false);
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('chat-g-cycle', 'go', { cwd: `${ANA}/sub/deep` }));
      expect(writeCards(launches.at(-1)!.mode)).toBe(true);
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-g-cycle', 'go', { cwd: `${ANA}/sub/deep` }));
      expect(writeCards(launches.at(-1)!.mode)).toBe(false);
    });

    it('never raises a chat found only by an enclosing folder', async () => {
      const runtime = boot();
      seedChat('chat-g-up', 'default');
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-g-up', 'hi', { cwd: `${ANA}/sub` }));
      expect(launches.at(-1)!.mode).toBe('default');
    });
  });

  describe('a level mode a caller sent is dropped (Security Must)', () => {
    const sentLevel = { levelPermissionMode: 'bypassPermissions' } as Partial<MessageOpts>;

    it('on a marked seat', async () => {
      const runtime = boot();
      seedSeat('seat-strip-marked', 'default');
      agentStops.set(ANA, 'autonomy');
      await run(
        runtime.sendMessage(
          'seat-strip-marked',
          'hi',
          seatOpts(ANA, { ...sentLevel, permissionCeiling: 'runtime-default' })
        )
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('on a chat a person capped', async () => {
      const runtime = boot();
      seedChat('chat-strip-capped', 'default', { permissionModeByPerson: true });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-strip-capped', 'hi', { cwd: ANA, ...sentLevel }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('on a chat with no agent', async () => {
      const runtime = boot();
      await registry.saveSessionSettings('chat-strip-plain', { permissionMode: 'default' });
      await run(
        runtime.sendMessage('chat-strip-plain', 'hi', { cwd: '/work/nobody', ...sentLevel })
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });
  });

  describe('the raise (QA rows)', () => {
    it('a seat stored at Ask, its agent then uncapped to Full: the same room writes with 0 cards', async () => {
      const runtime = boot();
      seedSeat('seat-up', 'default');
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('seat-up', 'write it', seatOpts(ANA)));
      expect(writeCards(launches.at(-1)!.mode)).toBe(true);

      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-up', 'write it again', seatOpts(ANA)));

      expect(launches.at(-1)!.mode).toBe('bypassPermissions');
      expect(writeCards(launches.at(-1)!.mode)).toBe(false);
      // Never written: the stored mode is still the one it was born with.
      expect(registry.storedPermissionModeOf('seat-up')).toBe('default');
      // And the level it hands on is the one it ran at.
      expect(lastTurnLevelOf('seat-up')).toMatchObject({ asks: 'never' });
    });

    it('then a cap again: the same seat asks on its next turn', async () => {
      const runtime = boot();
      seedSeat('seat-both', 'default');
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-both', 'go', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('bypassPermissions');
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('seat-both', 'go', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('a new room follows the uncap too', async () => {
      const runtime = boot();
      agentStops.set(ANA, 'autonomy');
      // A new seat is born at its agent's level (its seed names the mode).
      await run(
        runtime.sendMessage(
          'seat-new-up',
          'hi',
          seatOpts(ANA, { permissionMode: 'bypassPermissions' })
        )
      );
      expect(launches.at(-1)!.mode).toBe('bypassPermissions');
    });

    it('a turn a Wi-Fi hold bound stays capped after the uncap', async () => {
      const runtime = boot();
      seedSeat('seat-heard', 'default');
      agentStops.set(ANA, 'autonomy');
      await run(
        runtime.sendMessage(
          'seat-heard',
          'hi',
          seatOpts(ANA, { permissionCeiling: 'runtime-default' })
        )
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('a chat a person set to Ask stays at Ask: a per-chat cap', async () => {
      const runtime = boot();
      seedChat('chat-capped', 'default', { permissionModeByPerson: true });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-capped', 'hi', { cwd: ANA }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    // Where a chat's messages came from says nothing about its level (DOR-3440).
    it('a chat an extension’s message opened, held last turn, launches at its agent’s level', async () => {
      const runtime = boot();
      seedChat('chat-ext', null, { launchOrigin: 'extension-message', lastTurnHeld: true });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-ext', 'hi', { cwd: ANA }));
      expect(launches.at(-1)!.mode).toBe('bypassPermissions');
      agentStops.set(ANA, 'ask');
      await run(runtime.sendMessage('chat-ext', 'hi', { cwd: ANA }));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('a chat a binding opened launches at its agent’s level', async () => {
      const runtime = boot();
      seedChat('chat-binding', null, { launchOrigin: 'relay-binding' });
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-binding', 'hi', { cwd: ANA }));
      expect(launches.at(-1)!.mode).toBe('bypassPermissions');
    });

    it('a chat in Plan keeps Plan', async () => {
      const runtime = boot();
      seedChat('chat-plan', 'plan');
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('chat-plan', 'hi', { cwd: ANA }));
      expect(launches.at(-1)!.mode).toBe('plan');
    });

    it('never raises a scheduled run', async () => {
      const runtime = boot();
      seedChat('run-2', 'default', { launchOrigin: 'interactive' });
      agentStops.set(ANA, 'autonomy');
      await run(
        runtime.sendMessage('run-2', 'nightly', {
          cwd: ANA,
          permissionMode: 'default',
          unattended: true,
        })
      );
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('raises nothing with no facts wired', async () => {
      const runtime = boot();
      seedSeat('seat-nofacts', 'default');
      setChatRiseFacts(null);
      agentStops.set(ANA, 'autonomy');
      await run(runtime.sendMessage('seat-nofacts', 'hi', seatOpts(ANA)));
      expect(launches.at(-1)!.mode).toBe('default');
    });

    it('still holds a raised turn to an unmarked poster’s level', async () => {
      const runtime = boot();
      seedSeat('seat-poster', 'default');
      agentStops.set(ANA, 'autonomy');
      const poster = { asks: 'when-risky', reach: 'edit' } as const;
      await run(
        runtime.sendMessage('seat-poster', 'hi', seatOpts(ANA, { permissionCeiling: poster }))
      );
      expect(launches.at(-1)!.mode).toBe('acceptEdits');
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

/**
 * The Wi-Fi mark (DOR-3061, `specs/turn-marks/design-note.md`): minted from a Wi-Fi request, held
 * to the runtime's default wherever it is carried, and never turned into a standing yes.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentRuntime,
  MessageOpts,
  ToolDecisionOptions,
  TurnPermissionLevel,
} from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import {
  levelOfMode,
  resolveCeilingLevel,
  stricterLevel,
  type DeclaredModes,
} from '@dorkos/shared/permission-semantics';
import { createTestDb } from '@dorkos/test-utils/db';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { ceilingCarrying, marksForTurn, marksOfCeiling, parseStoredMarks } from '../turn-marks.js';
import {
  entryMarksOf,
  lastTurnLevelOf,
  noteEntryLevel,
  recordTurnLevels,
  setEntryMarksStore,
} from '../turn-levels.js';
import { TaskStore } from '../../../tasks/task-store.js';
import { createEntryMarksStore } from '../../../rooms/limits/entry-marks-store.js';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import {
  chatMarksOf,
  ceilingForContinuation,
  noteChatMarks,
  setChatMarksDb,
} from '../chat-marks.js';
import {
  WIFI_CEILING,
  WIFI_LEVEL,
  wifiTurnCeiling,
  withoutAlwaysAllow,
  withoutStandingYes,
} from '../wifi-mark.js';

const CLAUDE_MODES = CLAUDE_CODE_CAPABILITIES.permissionModes as DeclaredModes;
const CODEX_MODES = CODEX_CAPABILITIES.permissionModes as DeclaredModes;
const defaultOf = (declared: DeclaredModes) => levelOfMode(declared, declared.default)!;

/** The Wi-Fi mark carried on a level alone, with no runtime default beside it: the worst case. */
const CARRIED_ALONE: TurnPermissionLevel = {
  asks: 'never',
  reach: 'everything',
  outsider: true,
  wifi: true,
};

/** A card that would offer Always allow. */
const CARD: StreamEvent = {
  type: 'approval_required',
  data: {
    toolCallId: 't1',
    toolName: 'Bash',
    input: '{}',
    hasSuggestions: true,
    alwaysAllowScope: 'project',
  },
} as StreamEvent;

let counter = 0;
const fresh = () => `wifi-mark-${(counter += 1)}`;

/** A Claude Code runtime set to Full autonomy, wrapped in the level record and the marks. */
function recorded() {
  const sent: (MessageOpts | undefined)[] = [];
  const decisions: (ToolDecisionOptions | undefined)[] = [];
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(_id: string, _content: string, opts?: MessageOpts) {
        sent.push(opts);
        yield CARD;
        yield { type: 'done', data: {} } as StreamEvent;
      },
      approveTool(_id: string, _call: string, _approved: boolean, options?: ToolDecisionOptions) {
        decisions.push(options);
        return true;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  return { runtime, sent, decisions };
}

async function drain(events: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

beforeEach(() => {
  resetLiveOutsiderTurns();
  setChatMarksDb(undefined);
});
afterEach(() => setChatMarksDb(undefined));

describe('minting', () => {
  it('a Wi-Fi request’s turn carries the Wi-Fi and outsider marks; any other carries none', () => {
    expect(marksForTurn(wifiTurnCeiling(true))).toEqual({ outsider: true, wifi: true });
    expect(wifiTurnCeiling(false)).toEqual({});
    expect(marksOfCeiling(WIFI_CEILING)).toEqual({ outsider: true, wifi: true });
  });

  it('resolves to exactly the runtime’s default: no looser, and no stricter', () => {
    for (const declared of [CLAUDE_MODES, CODEX_MODES]) {
      const level = resolveCeilingLevel(declared, WIFI_CEILING);
      expect({ asks: level.asks, reach: level.reach, auto: level.auto }).toEqual({
        ...defaultOf(declared),
        auto: defaultOf(declared).auto,
      });
    }
  });
});

describe('carrying', () => {
  it('survives a merge, a stored row and a carried ceiling, always beside the outsider mark', () => {
    expect(stricterLevel(defaultOf(CLAUDE_MODES), WIFI_LEVEL)).toMatchObject({ wifi: true });
    expect(stricterLevel(WIFI_LEVEL, defaultOf(CLAUDE_MODES))).toMatchObject({ wifi: true });
    expect(parseStoredMarks('{"wifi":true}')).toEqual({ outsider: true, wifi: true });
    const carried = ceilingCarrying({ outsider: true, wifi: true });
    expect(carried).toEqual(['runtime-default', WIFI_LEVEL]);
    expect(marksOfCeiling(carried!)).toEqual({ outsider: true, wifi: true });
  });
});

describe('at the seam', () => {
  it('holds a turn that carries the mark on a level alone to the runtime’s default', async () => {
    const { runtime, sent } = recorded();
    const id = fresh();
    await drain(runtime.sendMessage(id, 'hi', { permissionCeiling: CARRIED_ALONE }));

    expect(sent[0]?.permissionCeiling).toEqual(['runtime-default', CARRIED_ALONE]);
    const level = lastTurnLevelOf(id)!;
    expect({ asks: level.asks, reach: level.reach }).toEqual(defaultOf(CLAUDE_MODES));
    expect(level).toMatchObject({ outsider: true, wifi: true });
  });

  it('leaves a ceiling that already holds the default as it was', async () => {
    const { runtime, sent } = recorded();
    await drain(runtime.sendMessage(fresh(), 'hi', wifiTurnCeiling(true)));
    expect(sent[0]?.permissionCeiling).toBe(WIFI_CEILING);
  });

  it('offers Allow once only on the cards a Wi-Fi-marked turn raises', async () => {
    const { runtime } = recorded();
    const [card] = await drain(runtime.sendMessage(fresh(), 'hi', wifiTurnCeiling(true)));
    expect(card).toMatchObject({ type: 'approval_required', data: { hasSuggestions: false } });
    expect(card!.data).not.toHaveProperty('alwaysAllowScope');
  });

  it('leaves an unmarked turn’s cards as they were', async () => {
    const { runtime } = recorded();
    const [card] = await drain(runtime.sendMessage(fresh(), 'hi'));
    expect(card).toBe(CARD);
  });

  it('answers a Wi-Fi-marked turn’s card once, even when a standing yes is sent', async () => {
    const { runtime, decisions } = recorded();
    const wifi = fresh();
    const plain = fresh();
    await drain(runtime.sendMessage(wifi, 'hi', wifiTurnCeiling(true)));
    await drain(runtime.sendMessage(plain, 'hi'));

    runtime.approveTool(wifi, 't1', true, { alwaysAllow: true, answeredBy: 'p' } as never);
    runtime.approveTool(plain, 't1', true, { alwaysAllow: true });

    expect(decisions[0]).toEqual({ answeredBy: 'p' });
    expect(decisions[1]).toEqual({ alwaysAllow: true });
  });
});

describe('the helpers', () => {
  it('take only the standing yes off', () => {
    const other = { type: 'text_delta', data: { text: 'hi' } } as StreamEvent;
    expect(withoutStandingYes(other)).toBe(other);
    expect(withoutAlwaysAllow({ denyReason: 'no' })).toEqual({ denyReason: 'no' });
    expect(withoutAlwaysAllow(undefined)).toBeUndefined();
  });
});

describe('each chat’s latest marks, for the turns that pick it up on their own', () => {
  it('carries a Wi-Fi-marked turn’s marks to the next automatic turn, after a restart too', async () => {
    const db = createTestDb();
    setChatMarksDb(db);
    const { runtime } = recorded();
    const id = fresh();
    await drain(runtime.sendMessage(id, 'hi', wifiTurnCeiling(true)));

    setChatMarksDb(db); // a restart: nothing in memory, only the row
    expect(chatMarksOf(id)).toEqual({ outsider: true, wifi: true });
    expect(ceilingForContinuation(id)).toEqual({ permissionCeiling: WIFI_CEILING });
  });

  it('carries nothing after an unmarked turn, and replaces the marks of an earlier one', async () => {
    const db = createTestDb();
    setChatMarksDb(db);
    const { runtime } = recorded();
    const id = fresh();
    await drain(runtime.sendMessage(id, 'hi', wifiTurnCeiling(true)));
    await drain(runtime.sendMessage(id, 'hi'));

    setChatMarksDb(db);
    expect(ceilingForContinuation(id)).toEqual({});
  });

  it('reads a chat with no record as unknown, which carries the outsider mark', () => {
    setChatMarksDb(createTestDb());
    expect(ceilingForContinuation(fresh())).toEqual({ permissionCeiling: 'runtime-default' });
    setChatMarksDb(undefined);
    expect(ceilingForContinuation(fresh())).toEqual({ permissionCeiling: 'runtime-default' });
  });

  it('carries a teammate’s mark on too: the tier’s read-only bound (a named tightening)', () => {
    const origin = { roomId: 'space-room', authorId: 'priya' };
    noteChatMarks('teammate-chat', { outsider: true, teammate: [origin] });
    expect(ceilingForContinuation('teammate-chat')).toEqual({
      permissionCeiling: [
        'runtime-default',
        expect.objectContaining({ reach: 'read', teammate: [origin] }),
      ],
    });
  });
});

describe('the durable copies a Wi-Fi-marked turn writes', () => {
  it('a schedule it writes parks with the mark on it, so its card names the Wi-Fi sign-in', () => {
    const store = new TaskStore(createTestDb());
    const task = store.createTask({
      name: 'nightly',
      description: 'a nightly check',
      prompt: 'check the build',
      cron: '0 3 * * *',
      filePath: '/tmp/dor-3061-nightly.md',
    });
    expect(store.approvals.markOrigin(task.id, { outsider: true, wifi: true })).toBe(true);
    // A later turn with only a stranger's words keeps the Wi-Fi mark: marks only add up.
    store.approvals.markOrigin(task.id, { outsider: true });
    expect(store.getTask(task.id)).toMatchObject({
      status: 'pending_approval',
      originMarks: { outsider: true, wifi: true },
    });
  });

  it('a room post it writes is still read as Wi-Fi-marked after a restart', () => {
    const harness = createRoomHarness({ agents: agentLookupFor({}) });
    const channel = harness.service.createRoom(
      { kind: 'channel', title: 'Team', members: [], agentPaths: [] },
      harness.human
    );
    setEntryMarksStore(createEntryMarksStore(harness.db));
    try {
      const post = harness.service.post(channel.id, { authorId: harness.human, text: 'hi' });
      noteEntryLevel(post.id, WIFI_LEVEL, channel.id);
      setEntryMarksStore(createEntryMarksStore(harness.db));
      expect(entryMarksOf(`${post.id}-not-in-memory`, channel.id)).toBeUndefined();
      expect(entryMarksOf(post.id, channel.id)).toMatchObject({ outsider: true, wifi: true });
    } finally {
      setEntryMarksStore(null);
    }
  });
});

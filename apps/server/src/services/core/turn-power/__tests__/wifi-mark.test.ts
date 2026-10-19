/**
 * The Wi-Fi mark (DOR-3061, `specs/turn-marks/design-note.md`): minted from a Wi-Fi request, held
 * to the runtime's default wherever it is carried, and never turned into a standing yes.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { inArray, sessionMetadata } from '@dorkos/db';
import { RuntimeRegistry } from '../../runtime-registry.js';
import {
  linkSessionId,
  resetSessionKeys,
} from '../../../session/resolution/session-key-registry.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { ceilingCarrying, marksForTurn, marksOfCeiling, parseStoredMarks } from '../turn-marks.js';
import {
  entryMarksOf,
  lastTurnLevelOf,
  noteEntryLevel,
  offersOnlyOnce,
  recordTurnLevels,
  setEntryMarksStore,
} from '../turn-levels.js';
import { TaskStore } from '../../../tasks/task-store.js';
import { createEntryMarksStore } from '../../../rooms/limits/entry-marks-store.js';
import { agentLookupFor, createRoomHarness } from '../../../rooms/__tests__/room-test-harness.js';
import { resetLiveOutsiderTurns } from '../live-outsider-turns.js';
import {
  chatMarksOf,
  continuationCeiling,
  noteChatMarks,
  notePersonMessage,
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
  resetSessionKeys();
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

  it('answers once a card answered under the chat’s other id, or raised by a Wi-Fi turn', async () => {
    const { runtime, decisions } = recorded();
    const requested = `${fresh()}-asked`;
    await drain(runtime.sendMessage(requested, 'hi', wifiTurnCeiling(true)));
    linkSessionId(requested, `${requested}-canonical`);

    runtime.approveTool(`${requested}-canonical`, 'some-other-card', true, { alwaysAllow: true });
    runtime.approveTool('a-chat-nobody-recorded', 't1', true, { alwaysAllow: true });

    expect(decisions).toEqual([{}, {}]);
    expect(offersOnlyOnce('a-chat-nobody-recorded', 't1')).toBe(true);
    expect(offersOnlyOnce('a-chat-nobody-recorded', 'never-raised')).toBe(false);
  });

  it('answers a Wi-Fi-marked turn’s card once, even when a standing yes is sent', async () => {
    const { runtime, decisions } = recorded();
    const wifi = fresh();
    const plain = fresh();
    await drain(runtime.sendMessage(wifi, 'hi', wifiTurnCeiling(true)));
    await drain(runtime.sendMessage(plain, 'hi'));

    runtime.approveTool(wifi, 't1', true, { alwaysAllow: true, answeredBy: 'p' } as never);
    runtime.approveTool(plain, 'plain-card', true, { alwaysAllow: true });

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
    expect(continuationCeiling(id)).toEqual({ permissionCeiling: WIFI_CEILING });
  });

  it('is cleared only by a person’s own unmarked turn', async () => {
    const db = createTestDb();
    setChatMarksDb(db);
    const { runtime } = recorded();
    const id = fresh();
    await drain(runtime.sendMessage(id, 'hi', wifiTurnCeiling(true)));
    // An agent's message, a schedule, a beat, a compaction: unmarked, but nobody's own words.
    await drain(runtime.sendMessage(id, 'hi'));
    expect(continuationCeiling(id)).toEqual({ permissionCeiling: WIFI_CEILING });
    // A person's own turn that still carries a mark adds it rather than clearing.
    notePersonMessage('person-marked');
    await drain(
      runtime.sendMessage(id, 'hi', {
        messageId: 'person-marked',
        permissionCeiling: 'runtime-default',
      })
    );
    expect(chatMarksOf(id)).toEqual({ outsider: true, wifi: true });

    notePersonMessage('person-plain');
    await drain(runtime.sendMessage(id, 'hi', { messageId: 'person-plain' }));
    setChatMarksDb(db);
    expect(continuationCeiling(id)).toEqual({});
  });

  it('starts a brand-new chat with nothing carried, and adds what its first turn carries', async () => {
    setChatMarksDb(createTestDb());
    const { runtime } = recorded();
    const plain = fresh();
    await drain(runtime.sendMessage(plain, 'hi'));
    expect(continuationCeiling(plain)).toEqual({});
  });

  it('follows a chat renamed mid-first-turn, across a restart, with no row left behind', async () => {
    const db = createTestDb();
    setChatMarksDb(db);
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    const { runtime } = recorded();
    const requested = `${fresh()}-requested`;
    const canonical = `${fresh()}-canonical`;
    await drain(runtime.sendMessage(requested, 'hi', wifiTurnCeiling(true)));
    // The runtime renames it: the row moves, and the in-memory alias follows.
    await registry.rekeySessionSettings(requested, canonical);
    linkSessionId(requested, canonical);
    // A later turn sent under the first id still lands on the chat's one row.
    await drain(runtime.sendMessage(requested, 'hi'));

    setChatMarksDb(db); // a restart
    resetSessionKeys();
    expect(chatMarksOf(canonical)).toEqual({ outsider: true, wifi: true });
    const rows = db
      .select({ id: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(inArray(sessionMetadata.sessionId, [requested, canonical]))
      .all();
    expect(rows.map((row) => row.id)).toEqual([canonical]);
  });

  it('merges both ids’ marks when a rename lands on a chat that already has a row', async () => {
    const db = createTestDb();
    setChatMarksDb(db);
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    noteChatMarks('merge-from', { outsider: true, wifi: true }, false);
    noteChatMarks('merge-to', {}, true);
    await registry.rekeySessionSettings('merge-from', 'merge-to');

    setChatMarksDb(db);
    expect(chatMarksOf('merge-to')).toEqual({ outsider: true, wifi: true });
  });

  it('folds in and clears marks left under an id the chat answered to before its rename', async () => {
    const db = createTestDb();
    setChatMarksDb(db);
    noteChatMarks('orphan-old', { outsider: true, wifi: true }, false);
    linkSessionId('orphan-old', 'orphan-new');
    expect(chatMarksOf('orphan-new')).toEqual({ outsider: true, wifi: true });
    noteChatMarks('orphan-new', {}, false);

    setChatMarksDb(db);
    expect(chatMarksOf('orphan-new')).toEqual({ outsider: true, wifi: true });
    const rows = db
      .select({ id: sessionMetadata.sessionId })
      .from(sessionMetadata)
      .where(inArray(sessionMetadata.sessionId, ['orphan-old', 'orphan-new']))
      .all();
    expect(rows.map((row) => row.id)).toEqual(['orphan-new']);
  });

  it('answers with the new, stronger marks when the write fails', () => {
    const db = createTestDb();
    setChatMarksDb(db);
    noteChatMarks('failing-write', {}, true);
    vi.spyOn(db, 'transaction').mockImplementation(() => {
      throw new Error('disk full');
    });
    noteChatMarks('failing-write', { outsider: true, wifi: true }, false);
    expect(chatMarksOf('failing-write')).toEqual({ outsider: true, wifi: true });
    vi.restoreAllMocks();
  });

  it('reads a chat with no record as unknown, which carries the outsider mark', () => {
    setChatMarksDb(createTestDb());
    expect(continuationCeiling(fresh())).toEqual({ permissionCeiling: 'runtime-default' });
    setChatMarksDb(undefined);
    expect(continuationCeiling(fresh())).toEqual({ permissionCeiling: 'runtime-default' });
  });

  it('carries a teammate’s mark on too: the tier’s read-only bound (a named tightening)', () => {
    const origin = { roomId: 'space-room', authorId: 'priya' };
    noteChatMarks('teammate-chat', { outsider: true, teammate: [origin] }, false);
    expect(continuationCeiling('teammate-chat')).toEqual({
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

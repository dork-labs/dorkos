/**
 * The seam that gets a room turn's `control_ui` onto the room's table — two
 * callers, one writer, and the stamp that keeps them from doubling (spec
 * `room-canvas` §5, ADR `260911-200303`).
 *
 * Four properties, and each is a live defect if it breaks:
 *
 * - **The handler answers with what really happened.** It calls the writer
 *   synchronously and returns its result, so a refusal reaches the model instead
 *   of a fabricated success — and pushes no event at all, so nothing downstream
 *   can act on something that did not happen.
 * - **The stamp survives the normalizer.** That function REBUILDS a `ui_command`
 *   field by field and drops the rest, which is exactly what it is for and
 *   exactly what would erase the stamp. Erased, every claude-code canvas
 *   operation applies twice — and silently, because the second write looks like
 *   an ordinary one.
 * - **The tap applies the unstamped ones.** That is how the scripted test-mode
 *   runtime reaches the same writer with the same ceiling.
 * - **The marker clears.** The room this turn answers in is bound per TURN and
 *   dropped when the turn ends, so a session that ran one room turn writes to no
 *   room on its next direct turn.
 *
 * @module server/services/rooms/canvas/tests/room-canvas-routing
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamEvent, UiState } from '@dorkos/shared/types';
import { UiStateReportDocumentSchema, type UiCommand } from '@dorkos/shared/schemas';
import type { RawSessionEvent } from '../../../session/session-state-projector.js';
import { toRawSessionEvent } from '../../../session/session-event-normalizer.js';
import { CapabilityToolError } from '../../../core/capabilities/index.js';
import { controlUi, getUiState } from '../../../session/browser-seat/ui-control.js';
import { uiTurnFacts } from '../../../session/browser-seat/ui-turn-facts.js';
import { reachesPastTheScreen } from '../../../session/browser-seat/ui-surface-consent.js';
import { setRoomService } from '../../index.js';
import { peekCanvasService, sessionScope, SESSION_OWNER_AUTHOR } from '../../../canvas/index.js';
import { NOT_IN_A_ROOM_MESSAGE, tooManyCanvasOpsMessage } from '../room-canvas-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';

// The window a `ui_command` reaches is a session's durable stream. Captured
// rather than stood up: every assertion here is about WHICH event the handler
// decided to push and what it stamped on it.
const reach = vi.hoisted(() => ({ emitted: [] as RawSessionEvent[] }));
vi.mock('../../../session/browser-seat/session-reach.js', () => ({
  emitToSession: (_sessionId: string, event: RawSessionEvent) => {
    reach.emitted.push(event);
    return true;
  },
}));

const ANA = '/agents/ana';
const SESSION = 'sess-room-turn';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/**
 * Run grep, treating "matched nothing" as an empty result rather than a throw.
 *
 * @param args - Arguments for grep.
 * @returns Its output, or `''` when it matched nothing.
 */
function grep(args: string[]): string {
  try {
    return execFileSync('grep', args, { encoding: 'utf-8' });
  } catch {
    return '';
  }
}

/** Run `control_ui` for the room turn under test, refusal included. */
async function control(command: UiCommand): Promise<Record<string, unknown>> {
  try {
    return await controlUi(command as unknown as Record<string, unknown>, { sessionId: SESSION });
  } catch (err) {
    if (err instanceof CapabilityToolError) return err.payload as Record<string, unknown>;
    throw err;
  }
}

describe('the `ui.control` handler, inside a room turn', () => {
  let harness: RoomHarness;
  let roomId: string;
  let ana: string;

  beforeEach(() => {
    reach.emitted.length = 0;
    uiTurnFacts.clear();
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    setRoomService(harness.service);
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;
    uiTurnFacts.bindTurn(SESSION, { roomTurn: { roomId, authorId: ana, turnId: 'turn-1' } });
  });

  it('returns the real write — the document, its revision and who is looking', async () => {
    const result = await control({
      action: 'open_canvas',
      content: { type: 'json', data: { hello: 'room' }, title: 'notes' },
    });
    expect(result).toMatchObject({ success: true, target: 'room', roomId, rev: 1, viewers: 0 });
    expect(typeof result.documentId).toBe('string');

    // …and the room really holds it.
    const documents = harness.service.canvas.list(roomId);
    expect(documents).toHaveLength(1);
    expect(documents[0].id).toBe(result.documentId);
  });

  it('stamps the event it pushes with what it wrote', async () => {
    const result = await control({
      action: 'open_canvas',
      content: { type: 'json', data: {}, title: 'notes' },
    });
    expect(reach.emitted).toHaveLength(1);
    const pushed = reach.emitted[0] as RawSessionEvent & {
      applied?: { documentId: string; rev: number };
    };
    expect(pushed.applied).toEqual({ documentId: result.documentId, rev: result.rev });
  });

  it('returns the REFUSAL, and pushes no event at all', async () => {
    // The defect this catches is a handler that reports success and lets the
    // tap refuse later: by then the model has been told it worked, and the
    // command has already gone out on a private stream.
    const result = await control({ action: 'show_toast', message: 'hi', level: 'info' });
    expect(result).toEqual({ success: false, target: 'room', reason: NOT_IN_A_ROOM_MESSAGE });
    expect(reach.emitted).toEqual([]);
    expect(harness.service.canvas.list(roomId)).toEqual([]);
  });

  it('refuses the fourth change of a turn in the result the model reads', async () => {
    for (const n of [1, 2, 3]) {
      await control({
        action: 'open_canvas',
        content: { type: 'json', data: { n }, title: `doc ${n}` },
      });
    }
    const fourth = await control({
      action: 'open_canvas',
      content: { type: 'json', data: { n: 4 }, title: 'doc 4' },
    });
    expect(fourth).toEqual({
      success: false,
      target: 'room',
      reason: tooManyCanvasOpsMessage(3),
    });
    // Three rows and three events, not four of either.
    expect(harness.service.canvas.list(roomId)).toHaveLength(3);
    expect(reach.emitted).toHaveLength(3);
  });

  it('is byte-identical to today outside a room turn', async () => {
    const result = await controlUi(
      { action: 'show_toast', message: 'hi', level: 'info' },
      { sessionId: 'sess-direct' }
    );
    expect(result).toEqual({ success: true, action: 'show_toast' });
    expect(reach.emitted).toHaveLength(1);
  });

  it('answers `get_ui_state` with the room’s table, naming the default target', async () => {
    const opened = await control({
      action: 'open_canvas',
      content: { type: 'json', data: {}, title: 'notes' },
    });
    const state = (await getUiState({ sessionId: SESSION })) as Record<string, unknown>;
    expect(state).toMatchObject({
      surface: 'room',
      roomId,
      viewers: 0,
      yourLastDocumentId: opened.documentId,
    });
    expect(state.canvas).toMatchObject({ count: 1 });
  });

  /**
   * Spec §1.7's "the two arms agree on the five shared keys", asserted by
   * READING BOTH ARMS (DOR-2006 review, finding 6).
   *
   * The guard that claimed this compared a hardcoded six-name literal to the
   * schema it was copied from, and never touched the room arm at all: renaming
   * the room arm's `title:` to `titleText:` left three files and 109 tests
   * green. Here both handlers are driven for real and both key sets come from
   * the schema, so a rename on either side fails.
   */
  it('answers both arms with the same document keys, and `active` only on the session', async () => {
    await control({
      action: 'open_canvas',
      content: { type: 'json', data: {}, title: 'notes' },
    });
    const roomState = (await getUiState({ sessionId: SESSION })) as Record<string, unknown>;

    // The session arm, over the same registered writer the harness stood up.
    const canvas = peekCanvasService();
    if (!canvas) throw new Error('the harness registers a canvas service');
    canvas.open(sessionScope('sess-own'), SESSION_OWNER_AUTHOR, {
      type: 'json',
      data: {},
      title: 'notes',
    });
    const sessionState = (await getUiState({ sessionId: 'sess-own' })) as Record<string, unknown>;

    const documentsOf = (state: Record<string, unknown>) =>
      (state.canvas as { documents: Record<string, unknown>[] }).documents;
    const shared = Object.keys(UiStateReportDocumentSchema.shape)
      .filter((key) => key !== 'active')
      .sort();

    expect(Object.keys(documentsOf(roomState)[0]!).sort()).toEqual(shared);
    expect(Object.keys(documentsOf(sessionState)[0]!).sort()).toEqual(
      Object.keys(UiStateReportDocumentSchema.shape).sort()
    );
  });

  it('answers `get_ui_state` about the SESSION’s own canvas outside a room turn', async () => {
    // The panel, sidebar and agent parts are still the client's own report; the
    // canvas part is the server's table, which is what this whole phase exists
    // to make true (spec `canvas-agent-seat` §1.7).
    const uiState: UiState = {
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: true, activeTab: null },
      agent: { id: null, cwd: null },
    };
    uiTurnFacts.bindTurn('sess-own-direct', { uiState });
    const state = (await getUiState({ sessionId: 'sess-own-direct' })) as Record<string, unknown>;
    expect(state).toMatchObject({
      panels: uiState.panels,
      sidebar: uiState.sidebar,
      agent: uiState.agent,
      canvas: { open: false, viewers: 0, documents: [], count: 0 },
    });
  });
});

describe('the sixteen window actions', () => {
  /** Everything `control_ui` accepts that a room does not. */
  const WINDOW_ACTIONS: UiCommand[] = [
    { action: 'show_toast', message: 'hi', level: 'info' },
    { action: 'open_panel', panel: 'tasks' },
    { action: 'close_panel', panel: 'tasks' },
    { action: 'toggle_panel', panel: 'tasks' },
    { action: 'open_sidebar' },
    { action: 'close_sidebar' },
    { action: 'switch_sidebar_tab', tab: 'overview' },
    { action: 'set_theme', theme: 'dark' },
    { action: 'scroll_to_message', messageId: 'm1' },
    { action: 'switch_agent', cwd: '/projects/x' },
    { action: 'open_pip' },
    { action: 'close_pip' },
    { action: 'open_terminal' },
    { action: 'open_command_palette' },
    { action: 'celebrate' },
    { action: 'apply_layout', shape: 'focus' },
  ];

  let harness: RoomHarness;
  let roomId: string;

  beforeEach(() => {
    reach.emitted.length = 0;
    uiTurnFacts.clear();
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    setRoomService(harness.service);
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    const ana = harness.authors.resolveAgent(ANA, 'Ana').id;
    uiTurnFacts.bindTurn(SESSION, { roomTurn: { roomId, authorId: ana, turnId: 'turn-1' } });
  });

  /**
   * Asserted by DRIVING the handler, not by asking a predicate (spec
   * `canvas-agent-seat` §5).
   *
   * There used to be a second mechanism here — a codex-only `isUiActionRefusedInRoom`
   * the event-mapper consulted — and keeping two lists of the same sixteen
   * actions in step was its own standing cost. The writer's own allow-list is
   * the single enforcement point now, so this reads the answer the model would
   * really get.
   */
  it('are every one of them refused in a room, and change nothing', async () => {
    for (const command of WINDOW_ACTIONS) {
      const result = await control(command);
      expect(result, command.action).toEqual({
        success: false,
        target: 'room',
        reason: NOT_IN_A_ROOM_MESSAGE,
      });
    }
    expect(reach.emitted).toEqual([]);
    expect(harness.service.canvas.list(roomId)).toEqual([]);
  });

  it('leaves the six canvas verbs alone', async () => {
    const opened = await control({
      action: 'open_canvas',
      content: { type: 'json', data: {}, title: 'notes' },
    });
    expect(opened).toMatchObject({ success: true, target: 'room' });
  });

  it('refuses an action nobody has written yet, because it is an allow-list', async () => {
    // The direction the list has to fail in: a twenty-third action reaches a
    // room refused rather than leaking onto somebody's private stream. It does
    // not even parse, which is the outer half of the same fail-closed rule.
    const result = await control({ action: 'open_holodeck' } as unknown as UiCommand);
    expect(result.error).toBe('Invalid UI command');
    expect(reach.emitted).toEqual([]);
  });

  it('leaves the OUTSIDE-the-app consent rule alone', async () => {
    // The two are different questions. `apply_layout` is refused for an agent
    // reaching in from outside the DorkOS app wherever it is; `show_toast` is
    // refused only in a room.
    expect(reachesPastTheScreen('apply_layout')).toBe(true);
    expect(reachesPastTheScreen('show_toast')).toBe(false);
  });
});

describe('the stamp’s round trip through the normalizer', () => {
  it('arrives with `applied` intact', () => {
    // THE test for the edit that is invisible until it is missing. The
    // normalizer rebuilds this event field by field; a stamp it does not copy is
    // a stamp the room turn's collector never sees, and every claude-code canvas
    // operation then applies twice.
    const pushed = {
      type: 'ui_command',
      data: {
        command: { action: 'close_canvas', documentId: 'doc-1' },
        applied: { documentId: 'doc-1', rev: 7 },
      },
    } as unknown as StreamEvent;

    const normalized = toRawSessionEvent(pushed);
    expect(normalized).toMatchObject({
      type: 'ui_command',
      command: { action: 'close_canvas', documentId: 'doc-1' },
      applied: { documentId: 'doc-1', rev: 7 },
    });
  });

  it('leaves an UNSTAMPED event unstamped — which is what the tap keys on', () => {
    const normalized = toRawSessionEvent({
      type: 'ui_command',
      data: { command: { action: 'close_canvas' } },
    } as unknown as StreamEvent);
    expect(normalized).toEqual({ type: 'ui_command', command: { action: 'close_canvas' } });
  });
});

describe('the client never reads the stamp', () => {
  it('is read by no client file that handles a `ui_command`', () => {
    // It is server-side bookkeeping with one job. A client that read it would be
    // branching on whether a command had already been applied somewhere it
    // cannot see, which is exactly the coupling the field's docs forbid.
    //
    // Scoped to the files that handle `ui_command` rather than to the word
    // "applied", which the marketplace, shapes and connections features all use
    // for their own unrelated things — a whole-tree grep would be red for
    // reasons that have nothing to do with this field.
    const clientSrc = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../../../../../client/src'
    );
    const handlers = grep(['-rl', '--include=*.ts', '--include=*.tsx', 'ui_command', clientSrc])
      .split('\n')
      .filter(Boolean);
    // The subject is asserted before the verdict is: "no file reads it" is
    // vacuously true of no files, so a search that found nothing would pass
    // having looked at nothing.
    expect(handlers.length).toBeGreaterThan(0);

    // A READ of the field, not the word: `.applied`, `['applied']`, or a
    // destructure of it. Prose about something being "applied" is not a read,
    // and matching it would make this red for reasons unrelated to the field.
    const reads = grep([
      '-n',
      '-E',
      String.raw`\.applied\b|\['applied'\]|\{[^}]*\bapplied\b[^}]*\} *=`,
      ...handlers,
    ])
      .split('\n')
      .filter(Boolean);
    expect(reads, `no client ui_command handler may read the stamp:\n${reads.join('\n')}`).toEqual(
      []
    );
  });
});

describe('the marker clears', () => {
  it('is bound per turn and dropped when the turn ends', () => {
    uiTurnFacts.clear();
    uiTurnFacts.bindTurn('s', { roomTurn: { roomId: 'r', authorId: 'a', turnId: 't' } });
    expect(uiTurnFacts.read('s').roomTurn).toBeDefined();

    // The turn ended: the next one, whatever starts it, writes to no room.
    uiTurnFacts.endTurn('s');
    expect(uiTurnFacts.read('s').roomTurn).toBeUndefined();
  });

  it('is cleared by a turn that carries no room, not merely left alone', () => {
    // The `uiState` half is the shape this must not be copied from — it sets and
    // never clears, which is harmless for a window snapshot and would leave a
    // session writing to a channel forever.
    uiTurnFacts.clear();
    uiTurnFacts.bindTurn('s', {
      uiState: {
        panels: { settings: false, tasks: false, relay: false, picker: false },
        sidebar: { open: true, activeTab: null },
        agent: { id: null, cwd: null },
      },
      roomTurn: { roomId: 'r', authorId: 'a', turnId: 't' },
    });

    uiTurnFacts.bindTurn('s', {});

    expect(uiTurnFacts.read('s').roomTurn).toBeUndefined();
    // …and the window snapshot survives, because no client re-sent one.
    expect(uiTurnFacts.read('s').uiState).toBeDefined();
  });

  it('is bound by the trigger, for every runtime rather than for one', () => {
    // Read off the trigger's source rather than asserted through a mocked turn:
    // the whole claim is that ONE runtime-neutral line binds it, which is what
    // makes Codex and OpenCode able to answer "which room am I in" at all.
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const source = readFileSync(path.join(serverSrc, 'services/session/trigger-turn.ts'), 'utf-8');
    expect(source).toContain('uiTurnFacts.bindTurn(turnKey, {');
    expect(source).toContain('uiTurnFacts.endTurn(turnKey);');
  });
});

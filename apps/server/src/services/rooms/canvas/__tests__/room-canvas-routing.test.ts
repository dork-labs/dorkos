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
 * - **The tap applies the unstamped ones.** That is how codex and the scripted
 *   test-mode runtime reach the same writer with the same ceiling.
 * - **The marker clears.** `session.roomTurn` is assigned on every turn,
 *   `undefined` included, so a session that ran one room turn writes to no room
 *   on its next direct turn.
 *
 * @module server/services/rooms/canvas/tests/room-canvas-routing
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamEvent, UiState } from '@dorkos/shared/types';
import type { UiCommand } from '@dorkos/shared/schemas';
import { toRawSessionEvent } from '../../../session/session-event-normalizer.js';
import {
  createControlUiHandler,
  createGetUiStateHandler,
  type UiToolSession,
} from '../../../runtimes/claude-code/mcp-tools/ui-tools.js';
import {
  isUiActionRefusedInRoom,
  isUiActionRefusedOnCodex,
} from '../../../runtimes/codex/ui-command-consent.js';
import { setRoomService } from '../../index.js';
import { NOT_IN_A_ROOM_MESSAGE, tooManyCanvasOpsMessage } from '../room-canvas-service.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../__tests__/room-test-harness.js';

const ANA = '/agents/ana';
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

/** Read one MCP tool result back as the object the model would see. */
function resultOf(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content.find((block) => block.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

describe('the claude-code handler, inside a room turn', () => {
  let harness: RoomHarness;
  let roomId: string;
  let ana: string;
  let session: UiToolSession;

  beforeEach(() => {
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    setRoomService(harness.service);
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;
    session = {
      eventQueue: [],
      roomTurn: { roomId, authorId: ana, turnId: 'turn-1' },
    };
  });

  /** Call `control_ui` the way the SDK does: loose arguments in, JSON out. */
  const controlUi = async (command: UiCommand) =>
    resultOf(
      (await createControlUiHandler(session)(command as unknown as Record<string, unknown>)) as {
        content: Array<{ type: string; text?: string }>;
      }
    );

  it('returns the real write — the document, its revision and who is looking', async () => {
    const result = await controlUi({
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
    const result = await controlUi({
      action: 'open_canvas',
      content: { type: 'json', data: {}, title: 'notes' },
    });
    expect(session.eventQueue).toHaveLength(1);
    const pushed = session.eventQueue[0] as StreamEvent & {
      data: { applied?: { documentId: string; rev: number } };
    };
    expect(pushed.data.applied).toEqual({ documentId: result.documentId, rev: result.rev });
  });

  it('returns the REFUSAL, and pushes no event at all', async () => {
    // The defect this catches is a handler that reports success and lets the
    // tap refuse later: by then the model has been told it worked, and the
    // command has already gone out on a private stream.
    const result = await controlUi({ action: 'show_toast', message: 'hi', level: 'info' });
    expect(result).toEqual({ success: false, target: 'room', reason: NOT_IN_A_ROOM_MESSAGE });
    expect(session.eventQueue).toEqual([]);
    expect(harness.service.canvas.list(roomId)).toEqual([]);
  });

  it('refuses the fourth change of a turn in the result the model reads', async () => {
    for (const n of [1, 2, 3]) {
      await controlUi({
        action: 'open_canvas',
        content: { type: 'json', data: { n }, title: `doc ${n}` },
      });
    }
    const fourth = await controlUi({
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
    expect(session.eventQueue).toHaveLength(3);
  });

  it('is byte-identical to today outside a room turn', async () => {
    const direct: UiToolSession = { eventQueue: [] };
    const result = resultOf(
      (await createControlUiHandler(direct)({
        action: 'show_toast',
        message: 'hi',
        level: 'info',
      })) as { content: Array<{ type: string; text?: string }> }
    );
    expect(result).toEqual({ success: true, action: 'show_toast' });
    expect(direct.eventQueue).toHaveLength(1);
  });

  it('answers `get_ui_state` with the room’s table, naming the default target', async () => {
    const opened = await controlUi({
      action: 'open_canvas',
      content: { type: 'json', data: {}, title: 'notes' },
    });
    const state = resultOf(
      (await createGetUiStateHandler(session)()) as {
        content: Array<{ type: string; text?: string }>;
      }
    );
    expect(state).toMatchObject({
      surface: 'room',
      roomId,
      viewers: 0,
      yourLastDocumentId: opened.documentId,
    });
    expect(state.canvas).toMatchObject({ count: 1 });
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
    const state = resultOf(
      (await createGetUiStateHandler({ eventQueue: [], uiState })()) as {
        content: Array<{ type: string; text?: string }>;
      }
    );
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
  const WINDOW_ACTIONS = [
    'show_toast',
    'open_panel',
    'close_panel',
    'toggle_panel',
    'open_sidebar',
    'close_sidebar',
    'switch_sidebar_tab',
    'set_theme',
    'scroll_to_message',
    'switch_agent',
    'open_pip',
    'close_pip',
    'open_terminal',
    'open_command_palette',
    'celebrate',
    'apply_layout',
  ];

  it('is exactly the set codex refuses in a room', () => {
    for (const action of WINDOW_ACTIONS) {
      expect(isUiActionRefusedInRoom(action), action).toBe(true);
    }
    for (const action of [
      'open_canvas',
      'update_canvas',
      'close_canvas',
      'open_file',
      'open_diff',
      'browser_navigate',
    ]) {
      expect(isUiActionRefusedInRoom(action), action).toBe(false);
    }
  });

  it('refuses an action nobody has written yet, because it is an allow-list', () => {
    // The direction the list has to fail in: a twenty-third action reaches a
    // room refused rather than leaking onto somebody's private stream.
    expect(isUiActionRefusedInRoom('open_holodeck')).toBe(true);
  });

  it('leaves codex’s OWN consent rule alone', () => {
    // The two are different questions. `apply_layout` is refused on codex
    // everywhere; `show_toast` is refused only in a room.
    expect(isUiActionRefusedOnCodex('apply_layout')).toBe(true);
    expect(isUiActionRefusedOnCodex('show_toast')).toBe(false);
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
  it('is assigned unconditionally on every turn, `undefined` included', () => {
    // Read off the adapter's source rather than asserted through a mocked SDK
    // turn: the whole claim is about ONE line, and what makes it correct is that
    // it is an unconditional assignment rather than a guarded one. The `ui_state`
    // lift immediately above it is the shape this must not be copied from — it
    // sets and never clears, which is harmless for a snapshot and would leave a
    // session writing to a channel forever.
    const serverSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const source = readFileSync(
      path.join(serverSrc, 'services/runtimes/claude-code/claude-code-runtime.ts'),
      'utf-8'
    );
    expect(source).toContain('session.roomTurn = opts?.roomTurn;');
    expect(source).not.toMatch(/if \([^)]*roomTurn[^)]*\) session\.roomTurn/);
  });
});

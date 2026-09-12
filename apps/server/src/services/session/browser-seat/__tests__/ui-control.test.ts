import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { RawSessionEvent } from '../../session-state-projector.js';
import type { UiState } from '@dorkos/shared/types';
import { CanvasDocumentStore, CanvasService, setCanvasService } from '../../../canvas/index.js';
import { CapabilityToolError } from '../../../core/capabilities/index.js';
import { logger } from '../../../../lib/logger.js';
import { STATUS_BY_CODE } from '../../../../routes/room-error-response.js';
import { controlUi, getUiState, type UiCallerContext } from '../ui-control.js';
import { uiTurnFacts } from '../ui-turn-facts.js';

// The window these verbs reach is a session's durable stream. Captured rather
// than stood up: what every assertion below is about is WHICH event the handler
// decided to push, not the projector's own machinery, which has its own suite.
const reach = vi.hoisted(() => ({
  emitted: [] as { sessionId: string; event: RawSessionEvent }[],
}));
vi.mock('../session-reach.js', () => ({
  emitToSession: (sessionId: string, event: RawSessionEvent) => {
    reach.emitted.push({ sessionId, event });
    return true;
  },
}));

const SESSION = 'sess-ui';
const CALLER: UiCallerContext = { sessionId: SESSION };

/** The events this session's windows were sent, in order. */
function emitted(): RawSessionEvent[] {
  return reach.emitted.filter((e) => e.sessionId === SESSION).map((e) => e.event);
}

/** What the window snapshot holds for the session under test. */
function uiState(): UiState | undefined {
  return uiTurnFacts.read(SESSION).uiState;
}

/** Run `control_ui` and report its refusal as a value rather than a throw. */
async function control(
  args: Record<string, unknown>,
  caller: UiCallerContext = CALLER
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  try {
    return { payload: await controlUi(args, caller), isError: false };
  } catch (err) {
    if (err instanceof CapabilityToolError) {
      return { payload: err.payload as Record<string, unknown>, isError: true };
    }
    throw err;
  }
}

beforeEach(() => {
  reach.emitted.length = 0;
  uiTurnFacts.clear();
});

describe('control_ui', () => {
  it('returns success with action name for valid command', async () => {
    const { payload } = await control({ action: 'open_panel', panel: 'tasks' });

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('open_panel');
  });

  it('puts a ui_command on the calling session’s stream', async () => {
    await control({ action: 'open_panel', panel: 'tasks' });

    expect(emitted()).toHaveLength(1);
    expect(emitted()[0].type).toBe('ui_command');
  });

  it('returns success for show_toast', async () => {
    const { payload } = await control({ action: 'show_toast', message: 'Hello!', level: 'info' });

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('show_toast');
  });

  it('returns success for open_canvas with markdown content', async () => {
    const { payload } = await control({
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hello' },
    });

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('open_canvas');
  });

  it('returns success for open_pip and leaves uiState unprojected (no PIP field)', async () => {
    const { payload } = await control({ action: 'open_pip', title: 'Tic-Tac-Toe' });

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('open_pip');
    // The PIP panel has no member in the UiState snapshot, so the projection is
    // a no-op: nothing about the panels or the sidebar moved.
    expect(uiState()?.panels).toEqual({
      settings: false,
      tasks: false,
      relay: false,
      picker: false,
    });
  });

  it('returns success for close_pip', async () => {
    const { payload } = await control({ action: 'close_pip' });

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('close_pip');
  });

  it('returns success for set_theme', async () => {
    const { payload } = await control({ action: 'set_theme', theme: 'dark' });

    expect(payload.success).toBe(true);
    expect(payload.action).toBe('set_theme');
  });

  it('returns an error result for an invalid action', async () => {
    const { payload, isError } = await control({ action: 'nonexistent_action' });

    expect(isError).toBe(true);
    expect(payload.error).toBe('Invalid UI command');
    expect(payload.details).toBeDefined();
  });

  it('does not emit anything when validation fails', async () => {
    await control({ action: 'nonexistent_action' });

    expect(emitted()).toHaveLength(0);
  });

  it('returns an error when open_panel has an invalid panel', async () => {
    expect((await control({ action: 'open_panel', panel: 'nonexistent' })).isError).toBe(true);
  });

  it('optimistically projects open_panel onto the window snapshot (from default when unset)', async () => {
    await control({ action: 'open_panel', panel: 'tasks' });

    expect(uiState()?.panels.tasks).toBe(true);
    // Untouched fields keep their default values.
    expect(uiState()?.panels.settings).toBe(false);
    expect(uiState()?.sidebar.open).toBe(true);
  });

  it('a follow-up get_ui_state reflects the panel command issued this turn', async () => {
    await control({ action: 'open_panel', panel: 'tasks' });

    const state = (await getUiState(CALLER)) as { panels: { tasks: boolean } };
    expect(state.panels.tasks).toBe(true);
  });

  it('no longer projects a CANVAS command onto the snapshot — the table answers instead', async () => {
    // The canvas arms of `applyUiCommandToState` are gone (spec
    // `canvas-agent-seat` §1.7). They existed to keep one nullable contentType
    // plausible for a surface that has held twelve documents since DOR-219, and
    // `get_ui_state` reads the real table now. If they came back, the snapshot
    // would grow a `canvas` key the schema no longer declares.
    await control({ action: 'open_canvas', content: { type: 'markdown', content: '# Hi' } });

    expect(uiState()).not.toHaveProperty('canvas');
  });

  it('projects switch_sidebar_tab (opens sidebar + sets tab) over prior client state', async () => {
    uiTurnFacts.bindTurn(SESSION, {
      uiState: {
        panels: { settings: false, tasks: false, relay: false, picker: false },
        sidebar: { open: false, activeTab: 'overview' },
        agent: { id: null, cwd: null },
      },
    });
    await control({ action: 'switch_sidebar_tab', tab: 'connections' });

    expect(uiState()?.sidebar).toEqual({ open: true, activeTab: 'connections' });
  });

  it('toggle_panel flips the current value', async () => {
    uiTurnFacts.bindTurn(SESSION, {
      uiState: {
        panels: { settings: false, tasks: true, relay: false, picker: false },
        sidebar: { open: true, activeTab: 'overview' },
        agent: { id: null, cwd: null },
      },
    });
    await control({ action: 'toggle_panel', panel: 'tasks' });

    expect(uiState()?.panels.tasks).toBe(false);
  });

  it('does not touch the window snapshot when validation fails', async () => {
    await control({ action: 'nonexistent_action' });

    expect(uiState()).toBeUndefined();
  });

  it('still pushes the event for open_file and browser_navigate, projecting no canvas', async () => {
    // Both are canvas writes on the SERVER now. With no canvas service standing
    // in this unit test, the handler falls through to the event push — which is
    // what the client needs either way, because the event is the reveal.
    await control({ action: 'open_file', sourcePath: 'src/index.ts' });
    await control({ action: 'browser_navigate', url: 'http://localhost:3000' });

    expect(emitted()).toHaveLength(2);
    expect(uiState()).not.toHaveProperty('canvas');
  });

  it('leaves panel state untouched for open_terminal (terminal is a panel tab)', async () => {
    // The terminal is a right-panel tab with no server-projected field, so the
    // deterministic projection is a no-op.
    uiTurnFacts.bindTurn(SESSION, {
      uiState: {
        panels: { settings: false, tasks: false, relay: false, picker: false },
        sidebar: { open: true, activeTab: 'overview' },
        agent: { id: null, cwd: null },
      },
    });
    await control({ action: 'open_terminal' });

    expect(uiState()?.sidebar).toEqual({ open: true, activeTab: 'overview' });
  });
});

describe('get_ui_state', () => {
  it('returns default state when no client has reported one', async () => {
    expect(await getUiState(CALLER)).toEqual({
      // An empty table, honestly reported: this process has no canvas service,
      // so there is nothing on it and nobody watching.
      canvas: { open: false, viewers: 0, documents: [], count: 0 },
      panels: { settings: false, tasks: false, relay: false, picker: false },
      // Default sidebar tab is null — the tab strip is an embedded-only surface.
      sidebar: { open: true, activeTab: null },
      agent: { id: null, cwd: null },
    });
  });

  it('returns the client’s reported state when there is one', async () => {
    const sessionState: UiState = {
      panels: { settings: false, tasks: true, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'connections' },
      agent: { id: 'agent-1', cwd: '/projects/my-app' },
    };
    uiTurnFacts.bindTurn(SESSION, { uiState: sessionState });

    // The three parts the CLIENT still owns come back verbatim; the canvas part
    // is composed server-side and is never the client's opinion (§1.7).
    expect(await getUiState(CALLER)).toEqual({
      ...sessionState,
      canvas: { open: false, viewers: 0, documents: [], count: 0 },
    });
  });
});

describe('a surface with no session', () => {
  it('control_ui returns an error instead of a false success', async () => {
    const { payload, isError } = await control({ action: 'open_panel', panel: 'tasks' }, {});

    expect(isError).toBe(true);
    expect(payload.error).toMatch(/require an attached interactive session/i);
    // Echoes the attempted action for context but never claims success.
    expect(payload.success).toBeUndefined();
    expect(payload.action).toBe('open_panel');
  });

  it('get_ui_state returns an error instead of fabricated defaults', async () => {
    await expect(getUiState({})).rejects.toBeInstanceOf(CapabilityToolError);
    await getUiState({}).catch((err: unknown) => {
      const payload = (err as CapabilityToolError).payload as Record<string, unknown>;
      expect(payload.error).toMatch(/require an attached interactive session/i);
      expect(payload.canvas).toBeUndefined();
    });
  });
});

/**
 * The refusal an agent reaching in from OUTSIDE the DorkOS app gets for an
 * action that writes to the machine (DOR-639, widened to the surface by spec
 * `canvas-agent-seat` §5).
 *
 * The rule used to be "refused on Codex" and lived in the Codex adapter. What it
 * really tests is the loopback runtime surface, which Codex and OpenCode both
 * reach DorkOS through and neither can put a question to a person on.
 */
describe('an action that reaches past the screen, over the runtime surface', () => {
  const fromRuntime: UiCallerContext = { sessionId: SESSION, fromRuntimeSurface: true };

  it('is refused, and nothing is emitted', async () => {
    const { payload, isError } = await control(
      { action: 'apply_layout', shape: 'focus' },
      fromRuntime
    );

    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.action).toBe('apply_layout');
    expect(String(payload.error)).toContain('apply_layout');
    expect(emitted()).toHaveLength(0);
  });

  it('leaves a client-only action alone', async () => {
    const { payload, isError } = await control(
      { action: 'show_toast', message: 'hi' },
      fromRuntime
    );

    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(emitted()).toHaveLength(1);
  });

  it('does not refuse the same action from inside the app', async () => {
    // The in-session surface CAN ask: claude-code raises an approval card for
    // this exact call (DOR-625). So the refusal is a property of the door the
    // call came through, not of the action alone.
    const { isError } = await control({ action: 'apply_layout', shape: 'focus' });

    expect(isError).toBe(false);
  });
});

/**
 * What `control_ui` does about a canvas writer it cannot reach (DOR-2006 review,
 * blocker 3 and finding 4).
 *
 * Two hosts have no writer to reach. The Obsidian embed opens somebody else's
 * database READ-ONLY and registers none on purpose; a server mid-boot has not
 * built one yet. Both must degrade to the event this tool has always pushed —
 * and a writer that faults mid-call (a locked database, or the read-only one the
 * embed used to register) must reach the model as a sentence rather than as a
 * stack trace that ends its turn.
 */
describe('control_ui when there is no canvas writer to reach', () => {
  it('falls through to the event, rather than failing the call', async () => {
    // No `setCanvasService` anywhere above: this is the embed's situation, and
    // the caller has a real session id, so nothing but the missing writer is in
    // play.
    const { payload } = await control({ action: 'open_file', sourcePath: '/notes/a.md' });

    expect(payload.success).toBe(true);
    // No document id: nothing was written, and the answer does not pretend it was.
    expect(payload.documentId).toBeUndefined();
    expect(emitted()).toHaveLength(1);
  });
});

describe('control_ui when the canvas writer faults', () => {
  let db: Db;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    const canvas = new CanvasService({
      documents: new CanvasDocumentStore(db),
      channels: { publish: () => {}, viewers: () => 0 },
    });
    // A real service, made to fault the way a locked or read-only database
    // faults — `SqliteError: attempt to write a readonly database` is what the
    // embed produced before it stopped registering a writer at all.
    vi.spyOn(canvas, 'apply').mockImplementation(() => {
      throw new Error('attempt to write a readonly database');
    });
    setCanvasService(canvas);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.$client.close();
  });

  it('answers the model with a refusal instead of throwing through the tool', async () => {
    const { payload, isError } = await control({ action: 'open_file', sourcePath: '/notes/a.md' });

    expect(isError).toBe(true);
    expect(payload.success).toBe(false);
    expect(payload.target).toBe('session');
    expect(String(payload.reason)).toMatch(/could not be reached/i);
    // The driver's own message is NOT passed on: it names internals the model
    // can do nothing about.
    expect(String(payload.reason)).not.toMatch(/readonly/i);
    // And a write that did not happen pushes no event, so no window is told it did.
    expect(emitted()).toHaveLength(0);
  });

  it('puts the fault in the log, where the operator can act on it', async () => {
    // The half the model never sees. A silent catch left an operator whose agent
    // said "your canvas could not be reached" with nothing to work from, while
    // every sibling catch in this area logs (DOR-2006 review round 2, N2).
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await control({ action: 'open_file', sourcePath: '/notes/a.md' });

    const said = warn.mock.calls.find(([message]) => String(message).includes('[canvas]'));
    expect(said).toBeDefined();
    expect(said?.[1]).toMatchObject({
      sessionId: SESSION,
      action: 'open_file',
      // The driver's message, kept HERE rather than sent to the model.
      error: expect.stringContaining('readonly'),
    });
  });

  it('codes the refusal 503, not the 404 `ROOM_NOT_FOUND` maps to', () => {
    // `CanvasApplyResult.code` exists so a surface turning it into an HTTP
    // status does not have to match on prose — so the code has to mean what
    // happened. `ROOM_NOT_FOUND` said "that thing does not exist" about a write
    // that failed on a canvas that does.
    expect(STATUS_BY_CODE.CANVAS_UNAVAILABLE).toBe(503);
    expect(STATUS_BY_CODE.ROOM_NOT_FOUND).toBe(404);
  });
});

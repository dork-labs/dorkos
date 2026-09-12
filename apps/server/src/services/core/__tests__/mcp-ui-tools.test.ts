import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { StreamEvent, UiState } from '@dorkos/shared/types';
import { CanvasDocumentStore, CanvasService, setCanvasService } from '../../canvas/index.js';
import {
  createControlUiHandler,
  createGetUiStateHandler,
  getUiTools,
  type UiToolSession,
} from '../../runtimes/claude-code/mcp-tools/ui-tools.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';

// Passthrough mock so getUiTools() can build tool defs without the real SDK: the
// registered handler is exposed directly for invocation.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown
  ) => ({ name, description, schema, handler }),
}));

/** Shape of the passthrough tool def the mocked `tool()` returns. */
interface MockTool {
  name: string;
  handler: (
    input: Record<string, unknown>
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

function createMockSession(uiState?: UiState): UiToolSession {
  return {
    eventQueue: [] as StreamEvent[],
    eventQueueNotify: vi.fn(),
    uiState,
  };
}

describe('control_ui handler', () => {
  let session: UiToolSession;

  beforeEach(() => {
    session = createMockSession();
  });

  it('returns success with action name for valid command', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'open_panel', panel: 'tasks' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('open_panel');
  });

  it('emits ui_command event to session eventQueue', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'open_panel', panel: 'tasks' });

    expect(session.eventQueue).toHaveLength(1);
    const event = session.eventQueue[0];
    expect(event.type).toBe('ui_command');
  });

  it('calls eventQueueNotify after emitting', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'close_sidebar' });

    expect(session.eventQueueNotify).toHaveBeenCalledTimes(1);
  });

  it('returns success for show_toast', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({
      action: 'show_toast',
      message: 'Hello!',
      level: 'info',
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('show_toast');
  });

  it('returns success for open_canvas with markdown content', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hello' },
    });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('open_canvas');
  });

  it('returns success for open_pip and leaves uiState unprojected (no PIP field)', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'open_pip', title: 'Tic-Tac-Toe' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('open_pip');
    // The PIP panel has no member in the UiState snapshot, so the projection is
    // a no-op: nothing about the panels or the sidebar moved.
    expect(session.uiState?.panels).toEqual({
      settings: false,
      tasks: false,
      relay: false,
      picker: false,
    });
  });

  it('returns success for close_pip', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'close_pip' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('close_pip');
  });

  it('returns success for set_theme', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'set_theme', theme: 'dark' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.action).toBe('set_theme');
  });

  it('returns error for invalid action', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'nonexistent_action' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toBe('Invalid UI command');
    expect(parsed.details).toBeDefined();
  });

  it('does not emit event when validation fails', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'nonexistent_action' });

    expect(session.eventQueue).toHaveLength(0);
    expect(session.eventQueueNotify).not.toHaveBeenCalled();
  });

  it('returns error when open_panel has invalid panel', async () => {
    const handler = createControlUiHandler(session);
    const result = await handler({ action: 'open_panel', panel: 'nonexistent' });

    expect(result.isError).toBe(true);
  });

  it('optimistically projects open_panel onto session.uiState (from default when unset)', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'open_panel', panel: 'tasks' });

    expect(session.uiState?.panels.tasks).toBe(true);
    // Untouched fields keep their default values.
    expect(session.uiState?.panels.settings).toBe(false);
    expect(session.uiState?.sidebar.open).toBe(true);
  });

  it('a follow-up get_ui_state reflects the panel command issued this turn', async () => {
    await createControlUiHandler(session)({ action: 'open_panel', panel: 'tasks' });

    const state = JSON.parse((await createGetUiStateHandler(session)()).content[0].text);
    expect(state.panels.tasks).toBe(true);
  });

  it('no longer projects a CANVAS command onto uiState — the table answers instead', async () => {
    // The canvas arms of `applyUiCommandToState` are gone (spec
    // `canvas-agent-seat` §1.7). They existed to keep one nullable contentType
    // plausible for a surface that has held twelve documents since DOR-219, and
    // `get_ui_state` reads the real table now. If they came back, `uiState`
    // would grow a `canvas` key the schema no longer declares.
    await createControlUiHandler(session)({
      action: 'open_canvas',
      content: { type: 'markdown', content: '# Hi' },
    });

    expect(session.uiState).not.toHaveProperty('canvas');
  });

  it('projects switch_sidebar_tab (opens sidebar + sets tab) over prior client state', async () => {
    const seeded = createMockSession({
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: false, activeTab: 'overview' },
      agent: { id: null, cwd: null },
    });
    await createControlUiHandler(seeded)({ action: 'switch_sidebar_tab', tab: 'connections' });

    expect(seeded.uiState?.sidebar).toEqual({ open: true, activeTab: 'connections' });
  });

  it('toggle_panel flips the current value', async () => {
    const seeded = createMockSession({
      panels: { settings: false, tasks: true, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'overview' },
      agent: { id: null, cwd: null },
    });
    await createControlUiHandler(seeded)({ action: 'toggle_panel', panel: 'tasks' });

    expect(seeded.uiState?.panels.tasks).toBe(false);
  });

  it('does not mutate session.uiState when validation fails', async () => {
    const handler = createControlUiHandler(session);
    await handler({ action: 'nonexistent_action' });

    expect(session.uiState).toBeUndefined();
  });

  it('still pushes the event for open_file and browser_navigate, projecting no canvas', async () => {
    // Both are canvas writes on the SERVER now. With no canvas service standing
    // in this unit test, the handler falls through to the event push — which is
    // what the client needs either way, because the event is the reveal.
    await createControlUiHandler(session)({ action: 'open_file', sourcePath: 'src/index.ts' });
    await createControlUiHandler(session)({
      action: 'browser_navigate',
      url: 'http://localhost:3000',
    });

    expect(session.eventQueue).toHaveLength(2);
    expect(session.uiState).not.toHaveProperty('canvas');
  });

  it('leaves panel state untouched for open_terminal (terminal is a panel tab)', async () => {
    // The terminal is a right-panel tab with no server-projected field, so the
    // deterministic projection is a no-op.
    const seeded = createMockSession({
      panels: { settings: false, tasks: false, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'overview' },
      agent: { id: null, cwd: null },
    });
    await createControlUiHandler(seeded)({ action: 'open_terminal' });

    expect(seeded.uiState?.sidebar).toEqual({ open: true, activeTab: 'overview' });
  });
});

describe('get_ui_state handler', () => {
  it('returns default state when no session state exists', async () => {
    const session = createMockSession();
    const handler = createGetUiStateHandler(session);
    const result = await handler();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toEqual({
      // An empty table, honestly reported: this process has no canvas service,
      // so there is nothing on it and nobody watching.
      canvas: { open: false, viewers: 0, documents: [], count: 0 },
      panels: { settings: false, tasks: false, relay: false, picker: false },
      // Default sidebar tab is null — the tab strip is an embedded-only surface.
      sidebar: { open: true, activeTab: null },
      agent: { id: null, cwd: null },
    });
  });

  it('returns session state when provided', async () => {
    const sessionState: UiState = {
      panels: { settings: false, tasks: true, relay: false, picker: false },
      sidebar: { open: true, activeTab: 'connections' },
      agent: { id: 'agent-1', cwd: '/projects/my-app' },
    };
    const session = createMockSession(sessionState);
    const handler = createGetUiStateHandler(session);
    const result = await handler();

    const parsed = JSON.parse(result.content[0].text);
    // The three parts the CLIENT still owns come back verbatim; the canvas part
    // is composed server-side and is never the client's opinion (§1.7).
    expect(parsed).toEqual({
      ...sessionState,
      canvas: { open: false, viewers: 0, documents: [], count: 0 },
    });
  });

  it('returns default state when uiState is undefined', async () => {
    const session = createMockSession(undefined);
    const handler = createGetUiStateHandler(session);
    const result = await handler();

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.canvas.open).toBe(false);
    expect(parsed.sidebar.open).toBe(true);
    // The default sidebar tab is null: the sidebar tab strip exists only in the
    // embedded (Obsidian) shell, so before any client reports there is no
    // addressable tab to fabricate.
    expect(parsed.sidebar.activeTab).toBeNull();
  });
});

describe('getUiTools without a session (session-less)', () => {
  const emptyDeps = {} as McpToolDeps;

  function toolByName(name: string): MockTool {
    const tools = getUiTools(emptyDeps) as unknown as MockTool[];
    const found = tools.find((t) => t.name === name);
    if (!found) throw new Error(`tool ${name} not registered`);
    return found;
  }

  it('control_ui returns an MCP error instead of a false success', async () => {
    const result = await toolByName('control_ui').handler({ action: 'open_panel', panel: 'tasks' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/require an attached interactive session/i);
    // Echoes the attempted action for context but never claims success.
    expect(parsed.success).toBeUndefined();
    expect(parsed.action).toBe('open_panel');
  });

  it('get_ui_state returns an MCP error instead of fabricated defaults', async () => {
    const result = await toolByName('get_ui_state').handler({});

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.error).toMatch(/require an attached interactive session/i);
    expect(parsed.canvas).toBeUndefined();
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
    // the session has a real id, so nothing but the missing writer is in play.
    const session: UiToolSession = { ...createMockSession(), sdkSessionId: 'sess-embedded' };
    const handler = createControlUiHandler(session);

    const result = await handler({ action: 'open_file', sourcePath: '/notes/a.md' });

    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    // No document id: nothing was written, and the answer does not pretend it was.
    expect(parsed.documentId).toBeUndefined();
    expect(session.eventQueue).toHaveLength(1);
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
    const session: UiToolSession = { ...createMockSession(), sdkSessionId: 'sess-faulting' };
    const handler = createControlUiHandler(session);

    const result = await handler({ action: 'open_file', sourcePath: '/notes/a.md' });

    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(false);
    expect(parsed.target).toBe('session');
    expect(parsed.reason).toMatch(/could not be reached/i);
    // The driver's own message is NOT passed on: it names internals the model
    // can do nothing about.
    expect(parsed.reason).not.toMatch(/readonly/i);
    // And a write that did not happen pushes no event, so no window is told it did.
    expect(session.eventQueue).toHaveLength(0);
  });
});

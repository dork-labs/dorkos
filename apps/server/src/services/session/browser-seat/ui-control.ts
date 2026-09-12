/**
 * Driving the DorkOS window, and reading back what is in it — the handlers
 * behind `control_ui` and `get_ui_state` (spec `canvas-agent-seat` §5).
 *
 * `control_ui` validates a UiCommand against `UiCommandSchema` and then splits
 * three ways:
 *
 * - **In a room**, the room's canvas verbs go through `RoomCanvasService.apply`
 *   and the tool answers the model with what really happened (spec
 *   `room-canvas` §5.2). A verb a room does not accept is refused by that
 *   writer's own allow-list, which is why there is no second room rule here.
 * - **In a session, a canvas verb** goes through the same writer under a
 *   `session:` scope (spec `canvas-agent-seat` §1.2) and answers with the
 *   document id. The canvas is the server's, so the effect is a row and a
 *   `canvas` event, not a hope about one browser.
 * - **Everything else** is an imperative pushed to the window as a `ui_command`
 *   event: panels, the sidebar, a toast, the palette.
 *
 * `get_ui_state` answers with a {@link UiStateReport}: the panel, sidebar and
 * agent parts the CLIENT reported, plus the canvas read straight off the table.
 *
 * ## One implementation, three runtimes
 *
 * These used to be hand-registered on claude-code's in-process MCP server and
 * bound to its live `AgentSession` object, which is why Codex had a stub that
 * produced no effect and OpenCode had nothing at all. They are capability
 * handlers now, and everything they need arrives as a session id: the room
 * marker and the window snapshot from {@link uiTurnFacts}, the canvas from the
 * service, the window itself from {@link emitToSession}.
 *
 * @module services/session/browser-seat/ui-control
 */
import { UiCommandSchema } from '@dorkos/shared/schemas';
import type { UiState, UiStateReport, UiCommand } from '@dorkos/shared/types';
import {
  CANVAS_VERBS,
  SESSION_AGENT_AUTHOR,
  frontOfViewIds,
  peekCanvasService,
  sessionScope,
  type CanvasApplyResult,
} from '../../canvas/index.js';
import { getRoomService, RoomError } from '../../rooms/index.js';
import type { RawSessionEvent } from '../session-state-projector.js';
// The leaf module rather than the `core/capabilities` barrel, for the reason
// `./devtools-reads` states in full: the barrel closes an import cycle back to
// this domain, and the domain reads schemas from these files at module scope.
import { CapabilityToolError } from '../../core/capabilities/mcp-envelope.js';
import { logger } from '../../../lib/logger.js';
import { emitToSession } from './session-reach.js';
import { uiTurnFacts, type UiRoomTurn } from './ui-turn-facts.js';
import { reachesPastTheScreen, uiActionRefusalMessage } from './ui-surface-consent.js';

/**
 * Default UI state answered with when no client has reported one.
 *
 * `sidebar.activeTab` defaults to null: the sidebar tab strip exists only in the
 * embedded (Obsidian) shell, so the honest default — before any client reports —
 * is "no addressable tab", not a fabricated `overview`.
 */
const DEFAULT_UI_STATE: UiState = {
  panels: { settings: false, tasks: false, relay: false, picker: false },
  sidebar: { open: true, activeTab: null },
  agent: { id: null, cwd: null },
};

/**
 * What a caller is told when it reaches these verbs from a surface with no
 * session behind it.
 *
 * Registering them without a bound session must not pretend to succeed — there
 * is no window to control or read.
 */
const SESSIONLESS_UI_ERROR = {
  error: 'control_ui and get_ui_state require an attached interactive session',
  detail:
    'These tools drive and read a live DorkOS window bound to a specific session. ' +
    'The current surface has no session attached, so there is no window to control or report.',
};

/** Deep clone of {@link DEFAULT_UI_STATE} — the seed when a session has no prior snapshot. */
function cloneDefaultUiState(): UiState {
  return structuredClone(DEFAULT_UI_STATE);
}

/**
 * Fold a validated {@link UiCommand}'s deterministic effect into a UI-state
 * snapshot, returning a new state. Mirrors the client dispatcher's state writes
 * (`ui-action-dispatcher`) for the commands that change persistent UI state;
 * commands with no lasting state effect (toast, theme, scroll, command palette)
 * return the state unchanged.
 *
 * This is a best-effort projection of PANELS, the sidebar and the agent — the
 * three things the client still owns. The canvas is not among them: it is a
 * table on the server, and `get_ui_state` reads it rather than guessing.
 *
 * @param state - The current UI-state snapshot.
 * @param command - The validated command to apply.
 * @returns The folded snapshot.
 */
function applyUiCommandToState(state: UiState, command: UiCommand): UiState {
  switch (command.action) {
    case 'open_panel':
      return { ...state, panels: { ...state.panels, [command.panel]: true } };
    case 'close_panel':
      return { ...state, panels: { ...state.panels, [command.panel]: false } };
    case 'toggle_panel':
      return {
        ...state,
        panels: { ...state.panels, [command.panel]: !state.panels[command.panel] },
      };
    case 'open_sidebar':
      return { ...state, sidebar: { ...state.sidebar, open: true } };
    case 'close_sidebar':
      return { ...state, sidebar: { ...state.sidebar, open: false } };
    case 'switch_sidebar_tab':
      // Best-effort intent projection: the client dispatcher opens the sidebar
      // and selects the tab — but ONLY on the embedded (Obsidian) shell, which is
      // the sole host with a sidebar tab strip. In the web app this command is a
      // no-op, and that client reports `activeTab: null`, which corrects this
      // projection on its next snapshot (get_ui_state is intent, not a live read).
      return { ...state, sidebar: { open: true, activeTab: command.tab } };
    case 'open_terminal':
      // The terminal is a right-panel tab, not a canvas document; it has no
      // canvas contentType. There is no server-projected panel/tab field beyond
      // canvas today, so the deterministic effect is a no-op on this snapshot —
      // the client reveals and focuses the Terminal tab (best-effort, web-only).
      return state;
    case 'switch_agent':
      return { ...state, agent: { ...state.agent, cwd: command.cwd } };
    default:
      // show_toast, set_theme, scroll_to_message, open_command_palette,
      // celebrate, open_pip, close_pip — and every CANVAS verb. The canvas arms
      // were removed here when the canvas moved to the server (spec
      // `canvas-agent-seat` §1.7): they existed to keep one nullable
      // `contentType` plausible for a surface that has held twelve documents
      // since DOR-219, and `get_ui_state` now reads the real table instead.
      return state;
  }
}

/** Who is calling a `ui` verb, as much of it as these two handlers read. */
export interface UiCallerContext {
  /** The calling session, from the surface's own resolution. */
  sessionId?: string;
  /** That session's working directory, when the surface carries one. */
  cwd?: string;
  /**
   * True when the call arrived over the loopback runtime listener — an agent
   * reaching in from outside the DorkOS app, with no way to ask a person about
   * an action that writes to their machine. See {@link ./ui-surface-consent}.
   */
  fromRuntimeSurface?: boolean;
}

/**
 * Run one `control_ui` call for the session that made it.
 *
 * @param args - The raw command arguments, already parsed against the tool's
 *   own field map and about to be parsed against `UiCommandSchema`.
 * @param caller - The calling session, its directory, and which surface it came
 *   in on.
 * @returns What happened, in the shape the model reads.
 * @throws {CapabilityToolError} On every refusal — an invalid command, a
 *   surface with no session, a room or session canvas that said no.
 */
export async function controlUi(
  args: Record<string, unknown>,
  caller: UiCallerContext
): Promise<Record<string, unknown>> {
  const sessionId = caller.sessionId;
  if (sessionId === undefined) {
    throw new CapabilityToolError({
      ...SESSIONLESS_UI_ERROR,
      action: (args as { action?: string }).action,
    });
  }

  const parsed = UiCommandSchema.safeParse(args);
  if (!parsed.success) {
    throw new CapabilityToolError({ error: 'Invalid UI command', details: parsed.error.issues });
  }
  const command = parsed.data;

  // **An agent reaching in from outside the app cannot be asked**, so an action
  // that writes to the machine is refused rather than run (DOR-639, widened to
  // the surface by spec `canvas-agent-seat` §5). Decided before anything is
  // written, and answered on the one channel that reaches the model.
  if (caller.fromRuntimeSurface === true && reachesPastTheScreen(command.action)) {
    throw new CapabilityToolError({
      success: false,
      action: command.action,
      error: uiActionRefusalMessage(command.action),
    });
  }

  // **In a room, this is the writer's call and it answers the model with what
  // really happened** (spec `room-canvas` §5.2). Synchronous, because the
  // alternative is refusing an operation the tool has already reported as
  // successful — a bound that answers later is a silent drop, not a bound.
  //
  // A refusal pushes NO event at all, so no room, no session and no viewer
  // ever sees an effect the model was told did not happen.
  const roomTurn = uiTurnFacts.read(sessionId).roomTurn;
  if (roomTurn !== undefined) {
    const applied = applyToRoomCanvas(roomTurn, caller.cwd, command);
    if (!applied.applied) {
      throw new CapabilityToolError({ success: false, target: 'room', reason: applied.reason });
    }
    emitToSession(sessionId, {
      type: 'ui_command',
      command,
      // The stamp the room turn's collector reads. It exists for one decision —
      // "did the handler already apply this?" — and the client never reads it.
      // Without it the collector would apply the same command a second time.
      applied: { documentId: applied.documentId, rev: applied.rev },
    } as RawSessionEvent);
    return {
      success: true,
      target: 'room',
      roomId: roomTurn.roomId,
      documentId: applied.documentId,
      rev: applied.rev,
      viewers: applied.viewers,
    };
  }

  // **A canvas verb in a SESSION is a write too** (spec `canvas-agent-seat`
  // §1.2). It goes through the same writer the room path uses, under a
  // `session:` scope, and answers with the document id — so the agent knows
  // WHICH document it just put on the table and can read it back.
  //
  // The `ui_command` event still goes out afterwards, unchanged: its job on a
  // session is to reveal the pane. The effect itself arrives separately, as
  // the `canvas` event the service published, in every window of the session
  // rather than just the one that asked.
  if (isSessionCanvasWrite(command)) {
    const applied = applyToSessionCanvasSafely(sessionId, caller.cwd, command);
    if (applied !== null) {
      if (!applied.applied) {
        throw new CapabilityToolError({
          success: false,
          target: 'session',
          reason: applied.reason,
        });
      }
      emitToSession(sessionId, { type: 'ui_command', command } as RawSessionEvent);
      return {
        success: true,
        target: 'session',
        action: command.action,
        documentId: applied.documentId,
        rev: applied.rev,
        viewers: applied.viewers,
      };
    }
    // No canvas service in this process — an embedded host reading somebody
    // else's database read-only, or a boot that has not reached the rooms
    // subsystem. Fall through to the `ui_command` event below.
    //
    // **In the embed that event reaches nobody, and that is the whole
    // behaviour.** `subscribeUiCommand` has exactly one subscriber — the web
    // app's `main.tsx` — and the Obsidian plugin never subscribes, so the push
    // is a no-op there rather than the older client-side canvas path it never
    // had. Net: the embed reads this machine's canvas and writes nothing to it,
    // which is ADR `260825-194924`'s rule.
  }

  emitToSession(sessionId, { type: 'ui_command', command } as RawSessionEvent);

  // Optimistically fold the command's deterministic effect into the session's
  // UI-state snapshot so a same-turn `get_ui_state` reflects it. The client only
  // reports its state at turn start, so without this the "verify with
  // get_ui_state" advice would answer with pre-command state. Best-effort:
  // edit-protection deferral or a headless session can make the real client
  // diverge (see CONTROL_UI_DESCRIPTION notes).
  const facts = uiTurnFacts.read(sessionId);
  uiTurnFacts.setUiState(
    sessionId,
    applyUiCommandToState(facts.uiState ?? cloneDefaultUiState(), command)
  );

  return { success: true, action: command.action };
}

/**
 * Answer `get_ui_state` for the session that asked.
 *
 * In a room it answers about the room's shared table (spec `room-canvas` §5.8).
 * In a session it answers with a {@link UiStateReport}: the panel, sidebar and
 * agent parts the CLIENT reported, plus the canvas read straight off the table
 * (spec `canvas-agent-seat` §1.7).
 *
 * @param caller - The calling session.
 * @returns The report.
 * @throws {CapabilityToolError} When the surface carries no session.
 */
export async function getUiState(caller: UiCallerContext): Promise<unknown> {
  const sessionId = caller.sessionId;
  if (sessionId === undefined) throw new CapabilityToolError(SESSIONLESS_UI_ERROR);

  // In a room, the private session UI state is not what the agent is looking at
  // — the room's shared table is (spec `room-canvas` §5.8).
  const roomTurn = uiTurnFacts.read(sessionId).roomTurn;
  if (roomTurn !== undefined) {
    const canvas = getRoomService().canvas;
    const documents = canvas.list(roomTurn.roomId);
    return {
      surface: 'room',
      roomId: roomTurn.roomId,
      // Live readers of this room's stream. One person with two tabs counts
      // twice and an agent counts zero, and the teaching says exactly that —
      // `0` means nobody is looking right now.
      viewers: canvas.viewers(roomTurn.roomId),
      // What a bare `update_canvas` would act on, named so the agent can see the
      // default rather than discover it.
      yourLastDocumentId: canvas.lastDocumentFor(roomTurn.roomId, roomTurn.authorId)?.id ?? null,
      canvas: {
        documents: documents.map((document) => ({
          id: document.id,
          type: document.contentType,
          title: document.title,
          author: document.authorId,
          pinned: document.pinned,
        })),
        count: documents.length,
      },
    };
  }
  return sessionUiStateReport(sessionId);
}

/**
 * Whether this command, in a SESSION, is a write to the canvas table rather than
 * an imperative to the window.
 *
 * Two carve-outs, and both keep behaviour a person already relies on:
 *
 * - **`open_canvas` with no content** asks for the PANE, not a document. There
 *   is nothing to write, and there never was.
 * - **`close_canvas` with no `documentId`** closes the whole panel, both views
 *   with it — the verb names the surface (`UiCommandSchema`'s own words). Naming
 *   a document closes that document; leaving it out is unchanged.
 *
 * @param command - The validated command.
 * @returns Whether it should reach the writer.
 */
function isSessionCanvasWrite(command: UiCommand): boolean {
  if (!CANVAS_VERBS.has(command.action)) return false;
  if (command.action === 'open_canvas') return command.content !== undefined;
  if (command.action === 'close_canvas') return command.documentId !== undefined;
  return true;
}

/**
 * Put one canvas command on this session's own table, through the single
 * writer.
 *
 * @param sessionId - The calling session, which the scope names.
 * @param cwd - Where this session stands, so a file document records it.
 * @param command - The validated command.
 * @returns What was written, or `null` when this process has no canvas service.
 */
function applyToSessionCanvas(
  sessionId: string,
  cwd: string | undefined,
  command: UiCommand
): CanvasApplyResult | null {
  const canvas = peekCanvasService();
  // No canvas service in this process — an embedded host reading somebody
  // else's database, or a boot that has not reached the rooms subsystem. `null`
  // means "fall through", not "failed".
  if (!canvas) return null;
  const content = canvas.contentForCommand(command);
  return canvas.apply({
    scope: sessionScope(sessionId),
    authorId: SESSION_AGENT_AUTHOR,
    command,
    // A session has one directory, and a file document records it so the agent
    // can read the document back through the same boundary check the file route
    // makes. No labels: there is only one tree and one reader.
    ...(content !== null && cwd !== undefined
      ? { tree: { resolvedCwd: cwd, sourceLabel: null, treeKind: null, aheadOfMain: null } }
      : {}),
    // A session HAS a front document per view, unlike a room — so a bare
    // `update_canvas` lands where it always has: on the document the person is
    // looking at in the view this content belongs to.
    defaultTarget: 'active-in-view',
  });
}

/**
 * Run {@link applyToSessionCanvas} and turn a thrown fault into a sentence.
 *
 * **The exact shape {@link applyToRoomCanvas} has had since it shipped**, for the
 * same reason: a database that is busy, locked or read-only is a thing that
 * happens, and the model must read a refusal it can act on rather than have its
 * turn die on a stack trace. The read-only embed is the case that proved it —
 * `apply` over a read-only database threw `SqliteError: attempt to write a
 * readonly database` straight through the tool.
 *
 * **It says so in the log, and the code says what happened.** The catch was
 * silent, so an operator whose agent reported "Your canvas could not be reached
 * just now" had nothing to work from — and it answered `ROOM_NOT_FOUND`, which
 * every surface that turns a code into a status reads as 404. Nothing was
 * missing; the write failed. `CANVAS_UNAVAILABLE` is a 503 and the sentence the
 * model reads is unchanged. The driver's own message is still NOT passed on to
 * the model — it names internals a model cannot act on — which is precisely why
 * the log line carries it.
 *
 * @param sessionId - The calling session.
 * @param cwd - Where this session stands.
 * @param command - The validated command.
 * @returns What was written, why nothing was, or `null` to fall through.
 */
function applyToSessionCanvasSafely(
  sessionId: string,
  cwd: string | undefined,
  command: UiCommand
): CanvasApplyResult | null {
  try {
    return applyToSessionCanvas(sessionId, cwd, command);
  } catch (err) {
    logger.warn('[canvas] a session canvas write faulted', {
      sessionId,
      action: command.action,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      applied: false,
      code: 'CANVAS_UNAVAILABLE',
      reason: err instanceof RoomError ? err.message : 'Your canvas could not be reached just now.',
    };
  }
}

/**
 * Compose what `get_ui_state` answers with for a one-on-one session.
 *
 * Three of the four parts are the client's own last report; the fourth is a read
 * of the table. A process with no canvas service — an embedded host, or a boot
 * that never stood the rooms subsystem up — answers with an empty canvas and
 * `viewers: 0`, which is the honest reading of "there is no table here" rather
 * than a fabricated one.
 *
 * @param sessionId - The session being asked about.
 * @returns The report.
 */
function sessionUiStateReport(sessionId: string): UiStateReport {
  const state = uiTurnFacts.read(sessionId).uiState ?? DEFAULT_UI_STATE;
  const canvas = peekCanvasService();
  const scope = sessionScope(sessionId);
  const documents = canvas ? canvas.list(scope) : [];
  // The same helper the writer's LRU reads, so "the front document of this
  // view" is one rule over one table rather than two copies that can disagree.
  const frontOfView = frontOfViewIds(documents);
  return {
    canvas: {
      open: documents.length > 0,
      viewers: canvas ? canvas.viewers(scope) : 0,
      documents: documents.map((document) => ({
        id: document.id,
        type: document.contentType,
        title: document.title,
        author: document.authorId,
        pinned: document.pinned,
        active: frontOfView.has(document.id),
      })),
      count: documents.length,
    },
    panels: state.panels,
    sidebar: state.sidebar,
    agent: state.agent,
  };
}

/**
 * Put one canvas command on the room's table, through the single writer.
 *
 * A thin wrapper so the handler above reads as one decision. It resolves the
 * service late — the rooms subsystem is registered during boot and a handler
 * created before it would otherwise capture nothing — and degrades a wiring
 * failure into a refusal the model can read rather than a stack trace.
 *
 * @param roomTurn - Where this turn is happening.
 * @param sessionCwd - The session's directory, used only when the turn carries
 *   none of its own.
 * @param command - The validated command.
 * @returns What was written, or why nothing was.
 */
function applyToRoomCanvas(
  roomTurn: UiRoomTurn,
  sessionCwd: string | undefined,
  command: UiCommand
): CanvasApplyResult {
  try {
    return getRoomService().canvas.apply({
      roomId: roomTurn.roomId,
      authorId: roomTurn.authorId,
      turnId: roomTurn.turnId,
      command,
      // The turn's own directory, preferred over the session's: in a project
      // room they differ, and the marker's is the tree this TURN was placed in.
      ...((roomTurn.cwd ?? sessionCwd) ? { cwd: roomTurn.cwd ?? sessionCwd } : {}),
      ...(roomTurn.aheadOfMain !== undefined ? { aheadOfMain: roomTurn.aheadOfMain } : {}),
    });
  } catch (err) {
    return {
      applied: false,
      code: 'ROOM_NOT_FOUND',
      reason:
        err instanceof RoomError
          ? err.message
          : 'That room’s canvas could not be reached just now.',
    };
  }
}

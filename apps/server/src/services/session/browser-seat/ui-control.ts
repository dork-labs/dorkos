/**
 * Driving the DorkOS window, and reading back what is in it — the handlers
 * behind `control_ui` and `get_ui_state` (spec `canvas-agent-seat` §5).
 *
 * `control_ui` validates a UiCommand against `UiCommandSchema` and then splits
 * four ways:
 *
 * - **A canvas verb carrying `target`** goes to the room it names, whichever
 *   surface the turn is on (spec `canvas-agent-seat` §9). Membership is checked
 *   at that seam, and a room the agent is not in answers exactly as one that
 *   does not exist.
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
import { getRoomService, RoomError, type RoomService } from '../../rooms/index.js';
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

/**
 * What an agent is told when `target` names a room it is not in — or one that
 * does not exist, which is deliberately the same answer.
 *
 * The room system's own refusal, with the two verbs that fix it. A room id is
 * not a capability, so "no such room" and "you are not in it" must never be
 * distinguishable from out here (`room-visibility.ts`).
 */
const TARGET_ROOM_NOT_FOUND_MESSAGE =
  'No such room. Check the id — get_room or list_member_rooms will tell you which rooms you are in.';

/**
 * What an agent is told when it targets a room from a session with no agent
 * behind it.
 *
 * A targeted write is posted in somebody's name and charged to somebody's
 * per-turn allowance, and this session's directory hosts no agent to be — so
 * there is nobody to write as. It is refused rather than written as the
 * operator, which is who a fallback would silently pick.
 */
const TARGET_NEEDS_AN_AGENT_MESSAGE =
  'This session is not an agent, so it has no membership to put something on a room with. Open the canvas here instead, or post to the room.';

/**
 * What an agent is told when it hangs `target` on an action a room has no
 * surface for.
 *
 * The sixteen non-canvas actions are imperatives to one WINDOW — a toast, a
 * panel, the command palette — and a room has no window to push them to.
 * Targeting must not become a way around the verb allow-list a room already
 * enforces, so the action still runs where it was going to run and the target is
 * dropped, out loud.
 */
const TARGET_IGNORED_MESSAGE =
  'A room only shares a canvas, so target does nothing for this action. It ran in this window instead. The six canvas actions are the ones a room can take.';

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

  const roomTurn = uiTurnFacts.read(sessionId).roomTurn;

  // **A targeted write goes somewhere else entirely, and it is decided first**
  // (spec `canvas-agent-seat` §9). `target` names a room this agent is a member
  // of, so neither branch below applies: not the room this turn is answering in,
  // and not this session's own canvas.
  //
  // Naming the room the turn is ALREADY in is accepted and is a no-op
  // distinction, so it falls through to the ordinary room path below: one
  // ledger, one allowance and one line for that room, rather than two of each
  // for the same turn in the same place.
  const target = 'target' in command ? command.target : undefined;
  const targetsAnotherRoom = target !== undefined && target.roomId !== roomTurn?.roomId;
  if (targetsAnotherRoom && CANVAS_VERBS.has(command.action)) {
    return applyToTargetedRoom({
      sessionId,
      roomId: target.roomId,
      command,
      roomTurn,
      ...(caller.cwd !== undefined ? { cwd: caller.cwd } : {}),
    });
  }

  // **Refused in reverse.** A room shares a canvas, not a window, so the other
  // sixteen actions have nowhere to land there — and a room refuses them anyway
  // (`CANVAS_VERBS`), so targeting must not become a way around that. The action
  // still runs where it was going to run and the target is dropped, out loud,
  // because a field that silently does nothing is worse than one that says so.
  //
  // It is read off the RAW arguments rather than off the parsed command, because
  // `target` rides the six canvas members of the union and nothing else — so on
  // any other action the schema has already dropped it, and a check on the
  // parsed value could never see one to complain about.
  const targetIgnored =
    args.target !== undefined && !CANVAS_VERBS.has(command.action)
      ? { targetIgnored: TARGET_IGNORED_MESSAGE }
      : {};

  // **In a room, this is the writer's call and it answers the model with what
  // really happened** (spec `room-canvas` §5.2). Synchronous, because the
  // alternative is refusing an operation the tool has already reported as
  // successful — a bound that answers later is a silent drop, not a bound.
  //
  // A refusal pushes NO event at all, so no room, no session and no viewer
  // ever sees an effect the model was told did not happen.
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

  return { success: true, action: command.action, ...targetIgnored };
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
  if (roomTurn !== undefined) return roomUiStateReport(roomTurn);
  return sessionUiStateReport(sessionId);
}

/**
 * What `get_ui_state` answers with inside a room turn: the room's shared table.
 *
 * Wrapped the way {@link applyToRoomCanvas} is, and for the same reason the
 * domain states as a property — a rooms subsystem this process never stood up
 * degrades to a sentence the model can read rather than a stack trace that ends
 * its turn. That case is practically unreachable in a booted server and was the
 * one place the claim was false.
 *
 * @param roomTurn - Where this turn is happening.
 * @returns The room's table, or a refusal saying it could not be reached.
 */
function roomUiStateReport(roomTurn: UiRoomTurn): unknown {
  let canvas;
  try {
    canvas = getRoomService().canvas;
  } catch (err) {
    logger.warn('[canvas] a room’s table could not be read for get_ui_state', {
      roomId: roomTurn.roomId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw new CapabilityToolError({
      surface: 'room',
      roomId: roomTurn.roomId,
      error: 'That room’s canvas could not be reached just now.',
    });
  }
  {
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
 * Put one canvas command on a room the calling session is a member of (spec
 * `canvas-agent-seat` §9).
 *
 * **Only ever called for a CANVAS verb**, which the caller decides: the other
 * sixteen actions have no surface in a room and are handled where the command
 * runs.
 *
 * **It never falls through.** Every outcome is answered here — a room the agent
 * is not in, no agent behind the session, a refusal from the writer — because
 * the alternative is putting the document on this session's own canvas and
 * telling the model it went to the room.
 *
 * **The session it charges is the one the SURFACE verified**, never one an
 * argument named. Q6 carried a fourth refusal here, for a claude-code session
 * whose `sdkSessionId` had not arrived yet; a capability has no such state — a
 * context either carries a session id or it does not, and the one that does not
 * is refused at the top of {@link controlUi} before any of this runs. Porting
 * that branch would have been a branch nothing could reach.
 *
 * @param input.sessionId - The calling session, from the verified context.
 * @param input.roomId - The room `target` named.
 * @param input.command - The validated command.
 * @param input.roomTurn - The room this turn is answering in, if any — for the
 *   author it already resolved and the directory it was placed in.
 * @param input.cwd - Where this session stands.
 * @returns What was written, or why nothing was.
 * @throws {CapabilityToolError} On every refusal.
 */
function applyToTargetedRoom(input: {
  sessionId: string;
  roomId: string;
  command: UiCommand;
  roomTurn: UiRoomTurn | undefined;
  cwd?: string;
}): Record<string, unknown> {
  const { sessionId, roomId, command, roomTurn } = input;
  let rooms: RoomService;
  try {
    rooms = getRoomService();
  } catch {
    // No rooms subsystem in this process — an embedded host, or a boot that
    // never stood one up. Falling through would put the document on this
    // session's own canvas, which is not what was asked for.
    throw new CapabilityToolError({
      success: false,
      target: 'room',
      roomId,
      reason: TARGET_ROOM_NOT_FOUND_MESSAGE,
    });
  }

  // Who is writing, resolved server-side and never from the arguments. A room
  // turn already knows — the runner resolved it — and a one-on-one turn is the
  // agent whose directory the session runs in, which is the same key the
  // in-session identity resolver uses.
  const authorId = roomTurn?.authorId ?? agentAuthorForSession(rooms, input.cwd);
  if (authorId === null) {
    throw new CapabilityToolError({
      success: false,
      target: 'room',
      roomId,
      reason: TARGET_NEEDS_AN_AGENT_MESSAGE,
    });
  }

  const cwd = roomTurn?.cwd ?? input.cwd;
  try {
    const applied = rooms.canvas.applyTargeted({
      sessionId,
      roomId,
      authorId,
      command,
      // The turn's own directory, preferred over the session's, for the reason
      // `applyToRoomCanvas` gives: in a project room they differ.
      ...(cwd !== undefined ? { cwd } : {}),
    });
    if (!applied.applied) {
      throw new CapabilityToolError({
        success: false,
        target: 'room',
        roomId,
        reason: applied.reason,
      });
    }
    // No `ui_command` event: the document went to a room, and this session's own
    // window has nothing to reveal. Every viewer of that room learns about it on
    // the room's own stream, which is where the effect already went.
    return {
      success: true,
      target: 'room',
      roomId,
      action: command.action,
      documentId: applied.documentId,
      rev: applied.rev,
      viewers: applied.viewers,
    };
  } catch (err) {
    if (err instanceof CapabilityToolError) throw err;
    throw new CapabilityToolError({
      success: false,
      target: 'room',
      roomId,
      reason:
        err instanceof RoomError && err.code === 'ROOM_NOT_FOUND'
          ? TARGET_ROOM_NOT_FOUND_MESSAGE
          : 'That room’s canvas could not be reached just now.',
    });
  }
}

/**
 * The room author of the agent whose session this is, or `null` when the
 * session's directory hosts no agent.
 *
 * The directory IS the agent-identity key everywhere else in this neighbourhood
 * — the relay sender, the task proposer, the in-session capability principal all
 * resolve from it — so it is the key here too. Asked of the registry's one agent
 * seam FIRST, so a directory with no agent in it is answered rather than minting
 * an author row nothing will ever use.
 *
 * @param rooms - The room service.
 * @param cwd - The session's working directory.
 * @returns The author id, or `null`.
 */
function agentAuthorForSession(rooms: RoomService, cwd: string | undefined): string | null {
  if (cwd === undefined) return null;
  const registry = rooms.authorRegistry;
  if (registry.agentNameOf(cwd) === null) return null;
  // Undefined rather than the name: `resolveAgent` refreshes the cached display
  // name from what it is handed, and `agents.name` is the address rather than
  // the label. Absent means "this caller does not know", which keeps whatever
  // the mesh-backed resolve stored.
  return registry.resolveAgent(cwd, undefined).id;
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

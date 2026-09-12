/**
 * MCP tools for agent-driven UI control and UI state queries.
 *
 * `control_ui` validates a UiCommand via Zod and then splits four ways:
 *
 * - **A canvas verb carrying `target`** goes to the room that names, whichever
 *   surface the turn is on (spec `canvas-agent-seat` §9). Membership is checked
 *   at this seam, and a room the agent is not in answers exactly as one that
 *   does not exist.
 * - **In a room**, the room's canvas verbs go through `RoomCanvasService.apply`
 *   and the tool answers the model with what really happened (spec
 *   `room-canvas` §5.2).
 * - **In a session, a canvas verb** now goes through the same writer under a
 *   `session:` scope (spec `canvas-agent-seat` §1.2) and answers with the
 *   document id. The canvas is the server's, so the effect is a row and a
 *   `canvas` event, not a hope about one browser.
 * - **Everything else** is still an imperative pushed to the client as a
 *   `ui_command` event: panels, the sidebar, a toast, the palette.
 *
 * `get_ui_state` answers with a {@link UiStateReport}: the panel, sidebar and
 * agent parts the CLIENT reported, plus the canvas read straight off the table.
 * It used to answer with the client's last-sent snapshot, which made "what is on
 * the canvas" a guess about a copy in one window.
 *
 * @module services/runtimes/claude-code/mcp-tools/ui-tools
 */
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { UiCommandSchema } from '@dorkos/shared/schemas';
import type { UiState, UiStateReport, UiCommand, StreamEvent } from '@dorkos/shared/types';
import { CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT } from '../../shared/ui-tool-contract.js';
import { getRoomService, RoomError, type RoomService } from '../../../rooms/index.js';
import {
  CANVAS_VERBS,
  SESSION_AGENT_AUTHOR,
  frontOfViewIds,
  peekCanvasService,
  sessionScope,
  type CanvasApplyResult,
} from '../../../canvas/index.js';
import type { McpToolDeps } from './types.js';
import { jsonContent } from './types.js';

/**
 * Default UI state returned when no client-reported state exists on the session.
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
 * Error result returned by the session-less tool variants. Registering `control_ui`
 * / `get_ui_state` without a bound session (e.g. an external MCP surface with no
 * interactive client) must not pretend to succeed — there is no UI to control or
 * read.
 */
const SESSIONLESS_UI_ERROR = {
  error: 'control_ui and get_ui_state require an attached interactive session',
  detail:
    'These tools mutate/read a live DorkOS client UI bound to a specific session. ' +
    'The current MCP surface has no session attached, so there is no UI to control or report.',
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
 * three things the client still owns. The canvas is not among them any more: it
 * is a table on the server, and `get_ui_state` reads it rather than guessing.
 *
 * @param state - The current UI-state snapshot.
 * @param command - The validated command to apply.
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
      // the sole host with a sidebar tab strip. On the web cockpit this command
      // is a no-op, and that client reports `activeTab: null`, which corrects this
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
 * Minimal session interface needed by UI tool handlers.
 * Matches the subset of `AgentSession` that event-emitting tools require.
 */
export interface UiToolSession {
  eventQueue: StreamEvent[];
  eventQueueNotify?: () => void;
  uiState?: UiState;
  /**
   * Session working directory. Used to resolve the session's trusted Relay
   * sender identity (see `resolveSenderIdentity`) so relay tools inject a
   * server-derived `from` rather than trusting the LLM.
   */
  cwd?: string;
  /**
   * The room this session's CURRENT turn is answering in, or absent for an
   * ordinary one-on-one turn (spec `room-canvas` §5.3).
   *
   * Server-derived and assigned on every turn — including to `undefined` — so a
   * session that ran one room turn writes to no room on its next direct turn.
   */
  roomTurn?: {
    roomId: string;
    authorId: string;
    turnId: string;
    cwd?: string;
    aheadOfMain?: number | null;
  };
  /**
   * The session's canonical SDK id, seeded to the request id at creation and
   * updated when the SDK init assigns the real id (see `session-store.ts`).
   * The DevTools read tools resolve it at READ time so a first-turn rekey
   * (`rekeyProjector` → `rekeySession`) never strands them on the stale
   * request UUID.
   */
  sdkSessionId?: string;
}

/**
 * Create the `control_ui` tool handler.
 * Validates the command against UiCommandSchema, emits a `ui_command` SSE event
 * to the session's event queue, optimistically projects the command's effect
 * onto `session.uiState`, and returns confirmation to the agent.
 *
 * @param session - The active session to emit events on (bound at tool creation)
 */
export function createControlUiHandler(session: UiToolSession) {
  return async (args: Record<string, unknown>) => {
    const parsed = UiCommandSchema.safeParse(args);
    if (!parsed.success) {
      return jsonContent({ error: 'Invalid UI command', details: parsed.error.issues }, true);
    }

    const command = parsed.data;

    // **A targeted write goes somewhere else entirely, and it is decided
    // first** (spec `canvas-agent-seat` §9). `target` names a room this agent is
    // a member of, so neither branch below applies: not the room this turn is
    // answering in, and not this session's own canvas.
    // Naming the room the turn is ALREADY in is accepted and is a no-op
    // distinction, so it falls through to the ordinary room path below: one
    // ledger, one allowance and one line for that room, rather than two of each
    // for the same turn in the same place.
    const target = 'target' in command ? command.target : undefined;
    if (target !== undefined && target.roomId !== session.roomTurn?.roomId) {
      const answered = applyToTargetedRoom(session, target.roomId, command);
      if (answered !== null) return answered;
    }

    // **In a room, this is the writer's call and it answers the model with what
    // really happened** (spec `room-canvas` §5.2). Synchronous, because the
    // alternative is refusing an operation the tool has already reported as
    // successful — a bound that answers later is a silent drop, not a bound.
    //
    // A refusal pushes NO event at all, so no room, no session and no viewer
    // ever sees an effect the model was told did not happen.
    const roomTurn = session.roomTurn;
    if (roomTurn !== undefined) {
      const applied = applyToRoomCanvas(session, roomTurn, command);
      if (!applied.applied) {
        return jsonContent({ success: false, target: 'room', reason: applied.reason }, true);
      }
      session.eventQueue.push({
        type: 'ui_command',
        // The stamp the room turn's collector reads. It exists for one decision
        // — "did the handler already apply this?" — and the client never reads
        // it. Without it the collector would apply the same command a second
        // time.
        data: { command, applied: { documentId: applied.documentId, rev: applied.rev } },
      } as StreamEvent);
      session.eventQueueNotify?.();
      return jsonContent({
        success: true,
        target: 'room',
        roomId: roomTurn.roomId,
        documentId: applied.documentId,
        rev: applied.rev,
        viewers: applied.viewers,
      });
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
      const applied = applyToSessionCanvasSafely(session, command);
      if (applied !== null) {
        if (!applied.applied) {
          return jsonContent({ success: false, target: 'session', reason: applied.reason }, true);
        }
        session.eventQueue.push({ type: 'ui_command', data: { command } } as StreamEvent);
        session.eventQueueNotify?.();
        return jsonContent({
          success: true,
          target: 'session',
          action: command.action,
          documentId: applied.documentId,
          rev: applied.rev,
          viewers: applied.viewers,
        });
      }
      // No canvas service in this process — an embedded host, or a boot that has
      // not reached the rooms subsystem. Fall through: the command still reaches
      // the client, which is exactly what it did before the table existed.
    }

    // Emit the command as a ui_command StreamEvent to the SSE stream
    session.eventQueue.push({
      type: 'ui_command',
      data: { command },
    } as StreamEvent);
    session.eventQueueNotify?.();

    // Optimistically fold the command's deterministic effect into the session's
    // UI-state snapshot so a same-turn `get_ui_state` reflects it. The client
    // only reports its state at turn start, so without this the "verify with
    // get_ui_state" advice would answer with pre-command state. Best-effort:
    // edit-protection deferral or a headless session can make the real client
    // diverge (see CONTROL_UI_DESCRIPTION notes).
    session.uiState = applyUiCommandToState(session.uiState ?? cloneDefaultUiState(), command);

    return jsonContent({ success: true, action: command.action });
  };
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

/**
 * Put one canvas command on a room the calling session is a member of (spec
 * `canvas-agent-seat` §9).
 *
 * **It answers `null` for "this is not a targeted write after all"**, which is
 * the one case the caller has to carry on from: a process with no canvas
 * service. Everything else — the wrong verb, a room the agent is not in, a
 * refusal from the writer — is answered here, because each of them is something
 * the model must read rather than have silently fall through onto a different
 * surface.
 *
 * @param session - The session taking the turn.
 * @param roomId - The room `target` named.
 * @param command - The validated command.
 * @returns The tool result, or `null` to fall through.
 */
function applyToTargetedRoom(
  session: UiToolSession,
  roomId: string,
  command: UiCommand
): ReturnType<typeof jsonContent> | null {
  // Refused in reverse: a room refuses the other sixteen actions anyway
  // (`CANVAS_VERBS`), so targeting cannot be a way to reach one there.
  if (!CANVAS_VERBS.has(command.action)) {
    return jsonContent({ success: false, target: 'room', roomId, reason: TARGET_IGNORED_MESSAGE });
  }
  const sessionId = session.sdkSessionId;
  if (sessionId === undefined) return null;

  let rooms;
  try {
    rooms = getRoomService();
  } catch {
    // No rooms subsystem in this process — an embedded host, or a boot that
    // never stood one up. Falling through would put the document on this
    // session's own canvas, which is not what was asked for.
    return jsonContent(
      { success: false, target: 'room', roomId, reason: TARGET_ROOM_NOT_FOUND_MESSAGE },
      true
    );
  }

  // Who is writing, resolved server-side and never from the arguments. A room
  // turn already knows — the runner resolved it — and a one-on-one turn is the
  // agent whose directory the session runs in, which is the same key the
  // in-session identity resolver uses.
  const authorId = session.roomTurn?.authorId ?? agentAuthorForSession(rooms, session.cwd);
  if (authorId === null) {
    return jsonContent(
      { success: false, target: 'room', roomId, reason: TARGET_NEEDS_AN_AGENT_MESSAGE },
      true
    );
  }

  try {
    const applied = rooms.canvas.applyTargeted({
      sessionId,
      roomId,
      authorId,
      command,
      // The turn's own directory, preferred over the session's, for the reason
      // `applyToRoomCanvas` gives: in a project room they differ.
      ...((session.roomTurn?.cwd ?? session.cwd) !== undefined
        ? { cwd: session.roomTurn?.cwd ?? session.cwd }
        : {}),
    });
    if (!applied.applied) {
      return jsonContent({ success: false, target: 'room', roomId, reason: applied.reason }, true);
    }
    // No `ui_command` event: the document went to a room, and this session's own
    // window has nothing to reveal. Every viewer of that room learns about it on
    // the room's own stream, which is where the effect already went.
    return jsonContent({
      success: true,
      target: 'room',
      roomId,
      action: command.action,
      documentId: applied.documentId,
      rev: applied.rev,
      viewers: applied.viewers,
    });
  } catch (err) {
    return jsonContent(
      {
        success: false,
        target: 'room',
        roomId,
        reason:
          err instanceof RoomError && err.code === 'ROOM_NOT_FOUND'
            ? TARGET_ROOM_NOT_FOUND_MESSAGE
            : 'That room’s canvas could not be reached just now.',
      },
      true
    );
  }
}

/**
 * The room author of the agent whose session this is, or `null` when the
 * session's directory hosts no agent.
 *
 * The directory IS the agent-identity key everywhere else in this file's
 * neighbourhood — the relay sender, the task proposer, the in-session capability
 * principal all resolve from it — so it is the key here too. Asked of the
 * registry's one agent seam FIRST, so a directory with no agent in it is
 * answered rather than minting an author row nothing will ever use.
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
 * The scope names the session's CANONICAL id, resolved at call time from
 * `sdkSessionId` for the same reason the DevTools read tools resolve theirs
 * there: a first-turn rekey must not strand a write on the request UUID.
 *
 * @param session - The session taking the turn.
 * @param command - The validated command.
 * @returns What was written, or `null` when this process has no canvas service.
 */
function applyToSessionCanvas(
  session: UiToolSession,
  command: UiCommand
): CanvasApplyResult | null {
  const canvas = peekCanvasService();
  const sessionId = session.sdkSessionId;
  // No canvas service in this process — an embedded host reading somebody
  // else's database, or a boot that has not reached the rooms subsystem. `null`
  // means "fall through", not "failed".
  if (!canvas || sessionId === undefined) return null;
  const content = canvas.contentForCommand(command);
  return canvas.apply({
    scope: sessionScope(sessionId),
    authorId: SESSION_AGENT_AUTHOR,
    command,
    // A session has one directory, and a file document records it so the agent
    // can read the document back through the same boundary check the file route
    // makes. No labels: there is only one tree and one reader.
    ...(content !== null && session.cwd !== undefined
      ? {
          tree: {
            resolvedCwd: session.cwd,
            sourceLabel: null,
            treeKind: null,
            aheadOfMain: null,
          },
        }
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
 * `ROOM_NOT_FOUND` is the sibling's code and is carried here for the same
 * reason: `CanvasApplyResult` types its code as a `RoomErrorCode`, none of which
 * means "the writer faulted", and the code never leaves this file — the handler
 * answers the model with `reason` alone. A raw driver message is NOT passed on:
 * it names internals the model cannot do anything about.
 *
 * @param session - The session taking the turn.
 * @param command - The validated command.
 * @returns What was written, why nothing was, or `null` to fall through.
 */
function applyToSessionCanvasSafely(
  session: UiToolSession,
  command: UiCommand
): CanvasApplyResult | null {
  try {
    return applyToSessionCanvas(session, command);
  } catch (err) {
    return {
      applied: false,
      code: 'ROOM_NOT_FOUND',
      reason: err instanceof RoomError ? err.message : 'Your canvas could not be reached just now.',
    };
  }
}

/**
 * Create the `get_ui_state` tool handler.
 *
 * In a room it answers about the room's shared table. In a session it answers
 * with a {@link UiStateReport}: the panel, sidebar and agent parts the CLIENT
 * reported, plus the canvas read straight off the table (spec
 * `canvas-agent-seat` §1.7). It used to answer with the client's last-sent
 * snapshot for the canvas too, which made this tool's answer a guess about a
 * copy in one window.
 *
 * @param session - The active session whose state to read (bound at tool creation)
 */
export function createGetUiStateHandler(session: UiToolSession) {
  return async () => {
    // In a room, the private session UI state is not what the agent is looking
    // at — the room's shared table is (spec `room-canvas` §5.8). Outside a room
    // turn this handler is unchanged, byte for byte.
    const roomTurn = session.roomTurn;
    if (roomTurn !== undefined) {
      const canvas = getRoomService().canvas;
      const documents = canvas.list(roomTurn.roomId);
      return jsonContent({
        surface: 'room',
        roomId: roomTurn.roomId,
        // Live readers of this room's stream. One person with two tabs counts
        // twice and an agent counts zero, and the teaching says exactly that —
        // `0` means nobody is looking right now.
        viewers: canvas.viewers(roomTurn.roomId),
        // What a bare `update_canvas` would act on, named so the agent can see
        // the default rather than discover it.
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
      });
    }
    return jsonContent(sessionUiStateReport(session));
  };
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
 * @param session - The session being asked about.
 * @returns The report.
 */
function sessionUiStateReport(session: UiToolSession): UiStateReport {
  const state = session.uiState ?? DEFAULT_UI_STATE;
  const canvas = peekCanvasService();
  const sessionId = session.sdkSessionId;
  const documents = canvas && sessionId !== undefined ? canvas.list(sessionScope(sessionId)) : [];
  // The same helper the writer's LRU reads, so "the front document of this
  // view" is one rule over one table rather than two copies that can disagree.
  const frontOfView = frontOfViewIds(documents);
  return {
    canvas: {
      open: documents.length > 0,
      viewers: canvas && sessionId !== undefined ? canvas.viewers(sessionScope(sessionId)) : 0,
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
 * service late — the rooms subsystem is registered during boot and a tool
 * created before it would otherwise capture nothing — and degrades a wiring
 * failure into a refusal the model can read rather than a stack trace.
 *
 * @param session - The session taking the turn, for the directory it stands in.
 * @param roomTurn - Where this turn is happening.
 * @param command - The validated command.
 * @returns What was written, or why nothing was.
 */
function applyToRoomCanvas(
  session: UiToolSession,
  roomTurn: NonNullable<UiToolSession['roomTurn']>,
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
      ...((roomTurn.cwd ?? session.cwd) ? { cwd: roomTurn.cwd ?? session.cwd } : {}),
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

/**
 * Returns the UI control tool definitions for registration with the MCP server.
 *
 * When `session` is provided (per-query), tool handlers emit real SSE events,
 * project UI state, and read actual state. Without a session there is no UI to
 * control — both tools return an MCP error result rather than falsely reporting
 * success or a fabricated default state.
 *
 * @param _deps - Shared tool dependencies (unused by UI tools)
 * @param session - Per-query session for event emission and state access
 */
export function getUiTools(_deps: McpToolDeps, session?: UiToolSession) {
  const controlUiHandler = session
    ? createControlUiHandler(session)
    : async (input: Record<string, unknown>) =>
        jsonContent(
          { ...SESSIONLESS_UI_ERROR, action: (input as { action?: string }).action },
          true
        );

  const getUiStateHandler = session
    ? createGetUiStateHandler(session)
    : async () => jsonContent(SESSIONLESS_UI_ERROR, true);

  return [
    tool('control_ui', CONTROL_UI_DESCRIPTION, CONTROL_UI_INPUT, async (input) =>
      controlUiHandler(input)
    ),
    tool(
      'get_ui_state',
      'Get the current DorkOS UI state — what is on the canvas right now, which panels are open, the active agent, and (embedded app only) the sidebar tab. The canvas part is a LIVE read of the table: every document on it, what each one is, what it is called, whether you or the person put it there ("agent" or "owner"), which one is at the front of its view, and how many windows are open on this session (windows, not people — 0 means nobody is looking). Each document\'s id is what the canvas-reading tool takes to read that one back. The panels, sidebar and agent parts reflect the last state the client reported at the start of this turn, merged with the UI commands issued this turn, so they are intent rather than a live read; sidebar.activeTab is null in the web app, which has no sidebar tab strip.',
      {},
      async () => getUiStateHandler()
    ),
  ];
}

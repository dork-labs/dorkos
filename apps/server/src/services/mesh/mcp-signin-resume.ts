/**
 * Bringing an agent back the moment a sign-in it asked for lands (DOR-1004).
 *
 * The product promise is that a person tells their agent to connect something,
 * signs in, comes back, and finds the work already done. Something has to notice
 * the token arriving and restart the turn, and WHERE that something lives is the
 * whole decision.
 *
 * ## Why this is server-side
 *
 * It started in the browser: the card polled its own flow and POSTed a
 * `ui_action` when it saw `connected`. That works exactly as long as the tab
 * that started the sign-in is still open and has not been reloaded — and an
 * OAuth round trip is precisely the moment a person is most likely to reload,
 * close the tab, or finish on their phone. Worse, "which tab may act" then has
 * to be answered in client memory, so every reload silently forfeited the
 * resume and every extra tab was a near-miss for a duplicate turn.
 *
 * Here there is no such question. The token exchange happens once, in one
 * process, under the refresher's per-target lock, and the flow transitions to
 * `connected` exactly once — so fire-once is structural rather than defended.
 * It works with no browser open at all.
 *
 * ## One resume per sign-in, and never a late one
 *
 * The resume is a wake (spec `turns-survive-restarts` §6.3, T7), keyed by the
 * flow's id and saved the moment the flow connects, so a restart before the
 * turn starts loses nothing and a second report of one flow sends nothing
 * more. It carries a short deadline (`WAKE_NOT_LATE_MS`) where it used to refuse
 * a busy chat: it waits for a turn already running to end, and past the
 * deadline it is dropped, since the newly-connected server's tools reach the
 * agent on its next turn regardless.
 *
 * ## Where the working directory comes from (DOR-981)
 *
 * The flow itself carries it. It used to come from the session's live projector,
 * which is minted by a client's `/events` connect — and that is precisely what a
 * restart or an eviction destroys, while a sign-in routinely outlives both
 * (a person can spend minutes in a browser). With no projector left to ask, the
 * resume fell back to `DEFAULT_CWD`, so every session rooted anywhere else
 * cold-started against the wrong directory and found nothing to resume.
 *
 * So the directory is captured at SIGN-IN START, on the flow record beside
 * `originSessionId`, and preferred here. The projector is still consulted, as
 * the fallback for a flow that recorded none — a sessionless start, or one begun
 * on a surface that does not carry a cwd.
 *
 * @module services/mesh/mcp-signin-resume
 */
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import type { SessionEvent } from '@dorkos/shared/session-stream';

import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { logger } from '../../lib/logger.js';
import { peekProjector } from '../session/index.js';
import { WAKE_NOT_LATE_MS, type WakeRequest } from '@dorkos/shared/turn-port';
import { ceilingForContinuation } from '../core/turn-power/continuation-hold.js';

/**
 * The `mcp_signin_resolved` event as an adapter produces it — the projector
 * stamps `seq`. Written as a distributed `Extract` rather than
 * `Omit<RawSessionEvent, …>`: omitting a key from the whole union collapses it
 * to the members' common keys, which is exactly the shape this event is not.
 */
type RawSigninResolved = Omit<Extract<SessionEvent, { type: 'mcp_signin_resolved' }>, 'seq'>;

/** The `actionId` a resume rides, so the agent can tell it from a widget click. */
const RESUME_ACTION_ID = 'mcp_signin_connected';

/**
 * What the resumed agent is told to do.
 *
 * The whole promise is that a person comes back to find the work already done,
 * so the one thing the agent must NOT do is announce itself. "I'm connected!" is
 * a turn spent telling someone what they just watched happen.
 */
const RESUME_INSTRUCTIONS =
  'The sign-in finished and this server’s tools are ready to use. Continue the task the ' +
  'user originally asked for, using them. Do not describe or narrate the sign-in: do not ' +
  'announce that you are connected, do not thank the user for signing in, and do not ' +
  'summarize what just happened. Pick the job back up and do it.';

/** A sign-in that started inside a session has finished. */
export interface McpSigninConnectedEvent {
  /** ULID of the agent that owns the server. */
  agentId: string;
  /** The managed server that just connected. */
  serverName: string;
  /** The session the sign-in was asked for in — where the agent is resumed. */
  sessionId: string;
  /** The sign-in flow, so its card in that session can be settled into a receipt. */
  flowId: string;
  /**
   * The directory that session runs in, captured when the sign-in started
   * (DOR-981). Preferred over the live projector, which a restart takes with it
   * — see the module doc.
   */
  originCwd?: string;
  /** How many tools the connect probe found, when it answered. */
  toolCount?: number;
}

/**
 * The port the OAuth engine calls when a sign-in that began in a session
 * connects. Injected at boot so the engine keeps no opinion about sessions, and
 * absent in tests that only care about the token exchange.
 */
export type McpSigninConnectedPort = (event: McpSigninConnectedEvent) => void;

/**
 * Settle the session's sign-in card into a terminal receipt.
 *
 * Ingested straight into the projector rather than pushed onto a turn's event
 * queue, because there is no turn: the sign-in finished between turns, which is
 * the normal case. The projector fans it out to every connected client and
 * carries it into later snapshots, so a tab opened afterwards sees the receipt
 * too.
 */
function settleCard(event: McpSigninConnectedEvent): void {
  const projector = peekProjector(event.sessionId);
  if (!projector) return;
  const resolved: RawSigninResolved = {
    type: 'mcp_signin_resolved',
    flowId: event.flowId,
    outcome: 'connected',
    ...(event.toolCount === undefined ? {} : { toolCount: event.toolCount }),
  };
  projector.ingest(resolved);
}

/**
 * Resume the agent in the session that asked for this sign-in: settle its card
 * and save the wake that starts the turn.
 *
 * Never throws: it runs from an HTTP callback the person's browser is waiting
 * on, so a failure here must not turn their "you can close this tab" page into
 * an error. Every way it can decline is a log line.
 *
 * @param event - The connected sign-in, naming its session and server.
 * @param wake - Saves the wake: the run record's `wakeChat`, handed in at startup.
 * @param now - The clock, epoch ms; tests pin it.
 */
export function resumeAfterMcpSignin(
  event: McpSigninConnectedEvent,
  wake: (request: WakeRequest) => boolean,
  now = Date.now()
): void {
  const { sessionId, serverName } = event;
  try {
    settleCard(event);
    // WHERE the turn runs. The flow's own recorded directory wins: it survives
    // the restart that empties the projector registry, which is the case that
    // used to silently resume in the wrong place (DOR-981).
    const cwd = event.originCwd ?? peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
    const content = formatUiActionMessage({
      actionId: RESUME_ACTION_ID,
      widgetTitle: `Sign-in: ${serverName}`,
      payload: {
        server: serverName,
        ...(event.toolCount === undefined ? {} : { toolCount: event.toolCount }),
        instructions: RESUME_INSTRUCTIONS,
      },
    });
    wake({
      sourceKind: 'signin',
      eventId: event.flowId,
      start: {
        sessionId,
        cwd,
        content,
        // DorkOS carries the bound chat on: it adds no power to it.
        origin: { kind: 'resume' },
        tier: 'owner',
        // Not late: worth sending only while the agent waits for it (see the module doc).
        notAfter: now + WAKE_NOT_LATE_MS,
        // Held when the chat's latest turn was, as every turn nobody asked for is (DOR-3037).
        ...ceilingForContinuation(sessionId),
      },
      // A sign-in outlives a restart and an eviction; a chat stored nowhere is
      // gone for good, and there is nothing to resume.
      onlyIfChatExists: { cwd },
    });
  } catch (err) {
    logger.warn('[mcp-signin-resume] could not resume', {
      sessionId,
      serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

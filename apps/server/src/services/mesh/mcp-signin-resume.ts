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
 * ## What it deliberately does NOT do
 *
 * A locked session is skipped, quietly. A lock means a turn is already running,
 * which is usually the agent doing the very work the resume would ask for, and
 * the newly-connected server's tools are injected on its next turn regardless.
 * Queueing or retrying would buy a duplicate turn in the common case and a
 * retry storm in the bad one; one log line is the honest cost.
 *
 * ## Known bound: restart recovery is default-directory only
 *
 * The working directory comes from the session's live projector, which is minted
 * by a client's `/events` connect. If the server restarts (or the session is
 * evicted) while a person is off in their browser, there is no projector left to
 * ask and this falls back to `DEFAULT_CWD` — so a session rooted anywhere else
 * cold-starts against the wrong directory and the storage probe finds nothing to
 * resume. The sign-in itself is unaffected: the token is stored, the row shows
 * connected, and the agent picks the server up on the next turn a person starts.
 * Only the automatic resume is lost, and only across a restart.
 *
 * Fixing it means persisting the session's cwd somewhere a cold process can read
 * it, which is a session-storage question rather than a sign-in one. Written
 * down here rather than worked around, because a wrong-directory cold start is
 * worse than an honest miss.
 *
 * @module services/mesh/mcp-signin-resume
 */
import { formatUiActionMessage } from '@dorkos/shared/ui-widget';
import type { SessionEvent } from '@dorkos/shared/session-stream';

import { runtimeRegistry } from '../core/runtime-registry.js';
import { DEFAULT_CWD } from '../../lib/resolve-root.js';
import { logger } from '../../lib/logger.js';
import {
  getOrCreateProjector,
  peekProjector,
  persistenceModeFor,
  rekeyProjector,
  triggerTurn,
} from '../session/index.js';

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
 * Resume the agent in the session that asked for this sign-in.
 *
 * Never throws and never rejects: it runs detached from an HTTP callback the
 * person's browser is waiting on, so a failure here must not turn their "you can
 * close this tab" page into an error. Every way it can decline is a log line.
 *
 * @param event - The connected sign-in, naming its session and server.
 */
export async function resumeAfterMcpSignin(event: McpSigninConnectedEvent): Promise<void> {
  const { sessionId, serverName } = event;
  try {
    settleCard(event);

    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // WHERE the turn runs, resolved once and threaded through every hop that
    // takes one — the storage probe, the projector, and the trigger — exactly as
    // `session-ui-action-handler` threads its request `cwd`. A projector minted
    // by this session's own `/events` connect knows the real directory; see the
    // module TSDoc for what happens when there isn't one.
    const cwd = peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
    // The live session map empties on restart and on eviction, while a sign-in
    // outlives both — a person can take minutes in a browser. A stored session
    // cold-starts through `triggerTurn`; one that exists nowhere is gone for
    // good and there is nothing to resume.
    if (!runtime.hasSession(sessionId)) {
      if (!(await runtime.getSession(cwd, sessionId))) {
        logger.info('[mcp-signin-resume] session is gone — nothing to resume', {
          sessionId,
          serverName,
        });
        return;
      }
    }

    const content = formatUiActionMessage({
      actionId: RESUME_ACTION_ID,
      widgetTitle: `Sign-in: ${serverName}`,
      payload: {
        server: serverName,
        ...(event.toolCount === undefined ? {} : { toolCount: event.toolCount }),
        instructions: RESUME_INSTRUCTIONS,
      },
    });

    const projector = getOrCreateProjector(sessionId, cwd, {
      persist: persistenceModeFor(runtime.getCapabilities()),
    });
    projector.cwd = cwd;

    const result = await triggerTurn({
      sessionId,
      clientId: `mcp-signin-${event.flowId}`,
      content,
      cwd,
      projector,
      deps: {
        acquireLock: (sid, cid, lifecycle, token) =>
          runtime.acquireLock(sid, cid, lifecycle, token),
        releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
        sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
        interruptQuery: (sid) => runtime.interruptQuery(sid),
        getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
        rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
        getCapabilities: () => runtime.getCapabilities(),
      },
      onError: (err) => {
        logger.warn('[mcp-signin-resume] detached turn error', {
          sessionId,
          serverName,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });

    if (!result.accepted) {
      // The expected non-happy path, and deliberately terminal. A turn is already
      // running — most often the agent already working — and the server's tools
      // inject on its next turn either way.
      logger.info('[mcp-signin-resume] session busy — the agent gets the server next turn', {
        sessionId,
        serverName,
      });
    }
  } catch (err) {
    logger.warn('[mcp-signin-resume] could not resume', {
      sessionId,
      serverName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

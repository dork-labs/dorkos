/**
 * Inline CARDS a capability can draw in the conversation it was called from
 * (DOR-1004) — the non-blocking sibling of `capability-approval-hold.ts`.
 *
 * A hold stops the tool call and waits for a person. A card does not: it pushes
 * a surface into the session, lets the call return its ordinary result, and lets
 * the turn end. That difference is the whole design for OAuth sign-in. A browser
 * round trip — open a page, log in, approve scopes, come back — routinely
 * outlasts any hold a turn can safely afford, so the sign-in card is drawn, the
 * agent says one short line, the turn ends, and the client brings the agent back
 * when the token lands.
 *
 * ## Why the projection, not the handler, does this
 *
 * A capability's `invoke` runs on every surface: the in-session `dorkos` MCP
 * server, the external `/mcp` server, and HTTP. Only the first has a
 * conversation to draw a card in. So the handler stays surface-agnostic — it
 * returns the same payload everywhere, link and disclosure included — and THIS
 * module, which runs only when a live session was threaded through, both pushes
 * the card and rewrites the payload's agent-facing `message` to stop repeating
 * what the card now owns. The sessionless surfaces never reach here, so their
 * caller still receives the link. One surface owns the disclosure, and which one
 * it is depends on which surfaces exist.
 *
 * @module services/core/capabilities/in-session-card
 */
import { z } from 'zod';
import type { StreamEvent } from '@dorkos/shared/types';
import { McpSigninRequiredEventSchema } from '@dorkos/shared/schemas';
import type { CapabilityHoldSession } from './capability-approval-hold.js';

/**
 * Which inline card a capability draws in the session that called it, declared
 * on {@link CapabilityDefinition.inSessionCard}.
 *
 * - `signin` — `mcp.signin`: draws the sign-in card and hands the disclosure to
 *   it.
 * - `signin_resolved` — `mcp.poll_signin`: retires that card once the agent's
 *   own check reaches a terminal answer.
 */
export type InSessionCardKind = 'signin' | 'signin_resolved';

/** The `(agentId, name)` shape every managed-MCP capability takes as input. */
const AgentServerShape = z.object({ agentId: z.string().min(1), name: z.string().min(1) });

/**
 * The part of `mcp.signin`'s result a sign-in card is built from.
 *
 * `authorizeUrl` is validated against the SAME schema the wire event uses, and
 * that is the point: a card is a button a person is being told it is safe to
 * press, so a link the event schema would reject must not be turned into one
 * here. Checking it at the emitter rather than only at the boundary is what makes
 * the refusal graceful — the card is skipped, the capability's own prose result
 * (link and disclosure included) is returned untouched, and the person still gets
 * a sign-in link from the agent. Validating only downstream would drop the frame
 * silently and leave them with nothing at all.
 */
const SigninResultShape = z.object({
  flowId: z.string().min(1),
  authorizeUrl: McpSigninRequiredEventSchema.shape.authorizeUrl,
  disclosure: z.string().min(1),
});

/** The part of `mcp.poll_signin`'s input/result a resolution is built from. */
const PollInputShape = z.object({ flowId: z.string().min(1) });
const PollResultShape = z.object({ status: z.enum(['pending', 'connected', 'failed']) });

/**
 * What the agent is told once the card is on screen, replacing the markdown
 * carrying the link and the disclosure.
 *
 * The card renders the disclosure above the link, in the consent order, and it
 * is the only place either appears — an agent that pasted them again would put a
 * second, unstyled copy of a consent sentence in the transcript and invite the
 * person to click whichever they saw first.
 *
 * @param serverName - The managed server being signed in to.
 */
function signinCardMessage(serverName: string): string {
  return (
    `The sign-in card for ${serverName} is already on screen, with the link and the ` +
    `disclosure on it. Say one short line naming what you are connecting, then stop. Do not ` +
    `repeat the link or the disclosure, and do not ask the user to tell you when they are ` +
    `done — you will be brought back automatically once the sign-in lands.`
  );
}

/** Push an event onto the session's queue and wake its drain loop. */
function push(session: CapabilityHoldSession, event: StreamEvent): void {
  session.eventQueue.push(event);
  session.eventQueueNotify?.();
}

/**
 * Draw the sign-in card, and hand the disclosure to it.
 *
 * No card is drawn when the result carries no USABLE `authorizeUrl`: an
 * already-connected server has nothing for a person to do, and a link the schema
 * refuses is one nobody should be invited to click. Either way the payload passes
 * through untouched, so the agent still reads "you're already signed in" — or
 * still has the provider's link to show in prose, which is strictly better than a
 * card that silently never appears.
 *
 * @returns The result to return to the agent: the same payload with a `message`
 *   that no longer repeats what the card now shows, or the original when no card
 *   was drawn.
 */
function projectSigninCard(
  session: CapabilityHoldSession,
  input: unknown,
  result: unknown
): unknown {
  const target = AgentServerShape.safeParse(input);
  const started = SigninResultShape.safeParse(result);
  if (!target.success || !started.success) return result;
  push(session, {
    type: 'mcp_signin_required',
    data: {
      serverName: target.data.name,
      agentId: target.data.agentId,
      flowId: started.data.flowId,
      authorizeUrl: started.data.authorizeUrl,
      disclosure: started.data.disclosure,
    },
  } as StreamEvent);
  return { ...(result as object), message: signinCardMessage(target.data.name) };
}

/**
 * Retire the sign-in card on the agent's own terminal check.
 *
 * Only the two terminal answers resolve anything: a `pending` poll is the agent
 * asking early, and retiring a live card on it would delete the link the person
 * is still walking through.
 */
function projectSigninResolved(
  session: CapabilityHoldSession,
  input: unknown,
  result: unknown
): unknown {
  const flow = PollInputShape.safeParse(input);
  const polled = PollResultShape.safeParse(result);
  if (!flow.success || !polled.success || polled.data.status === 'pending') return result;
  push(session, {
    type: 'mcp_signin_resolved',
    data: { flowId: flow.data.flowId, outcome: polled.data.status },
  } as StreamEvent);
  return result;
}

/**
 * Draw (or retire) the inline card a capability declared, and return the result
 * the in-session caller should receive.
 *
 * Called ONLY from the in-session MCP projection, and only for a capability that
 * declares `inSessionCard`. Every malformed shape falls through to the untouched
 * result: a card that cannot be built is a card nobody sees, and the payload the
 * sessionless surfaces return — link and disclosure included — is exactly the
 * right thing to fall back to.
 *
 * @param kind - The card the capability declared.
 * @param session - The live session whose event queue carries the card.
 * @param input - The validated capability input (names the agent and server).
 * @param result - The capability's plain result.
 * @returns The result to hand back to the agent.
 */
export function projectInSessionCard(
  kind: InSessionCardKind,
  session: CapabilityHoldSession,
  input: unknown,
  result: unknown
): unknown {
  if (kind === 'signin') return projectSigninCard(session, input, result);
  return projectSigninResolved(session, input, result);
}

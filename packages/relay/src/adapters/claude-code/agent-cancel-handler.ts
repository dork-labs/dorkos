/**
 * Stop-request handling for agent turns the Claude Code adapter is executing.
 *
 * A turn started over the relay — an A2A `message/send`, say — runs here, not
 * in the process that asked for it, so that process has no handle to abort when
 * its caller gives up (DOR-791). This module is that handle: the adapter keeps a
 * registry of the turns it currently owns, and a subscription on
 * {@link AGENT_CANCEL_SUBJECT_PREFIX} turns an `agent_cancel` envelope into the
 * same abort the turn's own TTL budget uses — which the agent handler carries
 * all the way to `interruptQuery`, because abandoning a stream stops nothing.
 *
 * It travels by SUBSCRIPTION rather than adapter delivery, exactly like tool
 * approvals and run stops: `deliver()` holds a concurrency slot for the whole
 * turn, so a stop routed through it would queue behind the turn it exists to
 * end.
 *
 * @module relay/adapters/claude-code-agent-cancel-handler
 */

import {
  AGENT_CANCEL_SUBJECT_PREFIX,
  A2A_GATEWAY_PRINCIPAL,
  AgentCancelPayloadSchema,
} from '@dorkos/shared/relay-schemas';
import type { AgentCancelReason, RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, SubscriberVerdict, Unsubscribe } from '../../types.js';
import type { AbortRegistry } from '../../lib/abort-registry.js';

/** Subject pattern covering a stop request for any turn. */
export const AGENT_CANCEL_SUBJECT_PATTERN = `${AGENT_CANCEL_SUBJECT_PREFIX}>`;

/**
 * Abort reason that marks a turn as stopped by whoever asked for it.
 *
 * A turn has two ways to end early and they read differently to the consumer of
 * its reply stream, so the reason has to survive the abort: this object means
 * "the caller stopped waiting", and its absence means the turn outlived the
 * TTL budget of the message that started it.
 */
export interface CallerCancel {
  /** Discriminator, so a plain `abort()` elsewhere can never be mistaken for this. */
  readonly kind: 'caller-cancel';
  /** Whether the caller cancelled outright or simply timed out. */
  readonly reason: AgentCancelReason;
}

/**
 * Build the abort reason for a caller-requested stop.
 *
 * @param reason - Cancel or timeout, as the requester described it.
 */
function callerCancel(reason: AgentCancelReason): CallerCancel {
  return { kind: 'caller-cancel', reason };
}

/**
 * Whether an abort signal's reason says a caller stopped this turn.
 *
 * @param reason - `AbortSignal.reason`, which is `undefined` for a plain abort.
 */
export function isCallerCancel(reason: unknown): reason is CallerCancel {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    (reason as CallerCancel).kind === 'caller-cancel'
  );
}

/**
 * Handle one turn stop request.
 *
 * Never throws: it runs inside the publish pipeline, where a throw is swallowed
 * and would leave the caller with no answer at all. Every refusal comes back as
 * a {@link SubscriberVerdict}, which is what makes the publisher's
 * `deliveredTo` an honest report of whether the turn was actually reached — the
 * whole point of the change, since the gateway must not tell an A2A client that
 * a turn stopped when nothing stopped it.
 *
 * @param envelope - The relay envelope carrying the `agent_cancel` payload.
 * @param running - The adapter's in-flight turn registry.
 * @param log - Logger for diagnostics.
 * @returns A refusal verdict when nothing was stopped; nothing when it was.
 */
export function handleAgentCancel(
  envelope: RelayEnvelope,
  running: AbortRegistry,
  log: Pick<Console, 'warn' | 'debug'>
): SubscriberVerdict | void {
  // Stopping somebody's turn is the server's business. `from` is stamped by the
  // publish pipeline and is not reachable from a model, so this is what stands
  // between "the A2A caller cancelled" and "an agent with relay_send guessed a
  // reply subject and killed a stranger's turn".
  if (envelope.from !== A2A_GATEWAY_PRINCIPAL) {
    log.warn(
      `[CCA] agent-cancel: refusing a stop from ${envelope.from} on ${envelope.subject} — ` +
        `only ${A2A_GATEWAY_PRINCIPAL} may stop a turn`
    );
    return { handled: false, reason: 'only the A2A gateway may stop a turn' };
  }

  const parsed = AgentCancelPayloadSchema.safeParse(envelope.payload);
  if (!parsed.success) {
    log.warn(
      `[CCA] agent-cancel: malformed payload on ${envelope.subject} — ` +
        "expected type='agent_cancel' with replyTo and reason"
    );
    return { handled: false, reason: 'stop request was not an agent_cancel payload' };
  }

  const { replyTo, reason } = parsed.data;
  if (!running.stop(replyTo, callerCancel(reason))) {
    // The honest answer for a turn that already finished, and for an adapter
    // that restarted since the turn began. Both are no-ops, neither is an error
    // — and both must reach the caller as "not stopped", never as success.
    log.debug?.(`[CCA] agent-cancel: no turn replying to ${replyTo} is executing here`);
    return { handled: false, reason: `no turn replying to ${replyTo} is executing here` };
  }

  log.debug?.(`[CCA] agent-cancel: stopping the turn replying to ${replyTo} (${reason})`);
}

/**
 * Subscribe to turn stop requests on behalf of the CCA adapter.
 *
 * @param relay - The RelayPublisher to subscribe through.
 * @param running - The adapter's in-flight turn registry.
 * @param log - Logger for diagnostics.
 * @returns An unsubscribe function that must be called on adapter stop.
 */
export function subscribeAgentCancelHandler(
  relay: RelayPublisher,
  running: AbortRegistry,
  log: Pick<Console, 'warn' | 'debug'>
): Unsubscribe {
  return relay.subscribe(AGENT_CANCEL_SUBJECT_PATTERN, (envelope) =>
    handleAgentCancel(envelope, running, log)
  );
}

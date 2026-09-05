/**
 * Agent message handling for the Claude Code adapter.
 *
 * Handles routing inbound messages to Claude Agent SDK sessions,
 * session ID resolution via binding strategies, trace span creation,
 * and response streaming back to the relay.
 *
 * @module relay/adapters/claude-code-agent-handler
 */

import { randomUUID } from 'node:crypto';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { StreamEventTypeSchema, type PermissionMode } from '@dorkos/shared/schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { defuseSystemTags } from '@dorkos/shared/untrusted-text';
// One answer to "is this error the turn failing?", shared with the scheduled-run
// tracker that reads the same streams (DOR-1658). The denylist and the reasoning
// behind its direction live there.
import { isNonFatalErrorCode } from '@dorkos/shared/run-outcome';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  TraceStoreLike,
} from '../../types.js';
import { extractPayloadContent, extractSenderIdentity } from '../../lib/payload-utils.js';
import { extractSessionIdFromSubject } from '../../lib/subjects.js';
import type {
  AgentRuntimeLike,
  AgentSessionStoreLike,
  ExecutionSettingsResolver,
  SessionRuntimeBinder,
  TurnExecutionSettings,
} from './types.js';
import {
  publishAgentResult,
  publishDispatchProgress,
  publishResponseWithCorrelation,
} from './publish.js';
import { isCallerCancel } from './agent-cancel-handler.js';
import { interruptTurn } from './interrupt.js';
import type { InboundTurnBudgets } from '../../inbound-turn-budgets.js';
import { describeError } from '../../lib/describe-error.js';
// One answer to "has this message run out of time?", shared with the publish
// gate, the scheduled-run handler and the capacity line so the four cannot
// disagree. The policy — an expired envelope never runs — is written down there,
// along with why the boundary takes a number rather than an envelope.
import { isExpired, ttlRemainingMs } from '../../lib/envelope-ttl.js';

/** Dependencies required by the agent handler. */
export interface AgentHandlerDeps {
  agentManager: AgentRuntimeLike;
  /**
   * Which runtime {@link AgentHandlerDeps.agentManager} is, as the settings
   * resolver must be asked about it.
   *
   * Passed rather than read off `agentManager.type` so the answer is the one
   * the ADAPTER resolved for this message — every tier below the session row
   * is a per-runtime answer, and a mismatch there is how a codex turn gets
   * handed a Claude model alias. Optional so a host that never wired a
   * resolver, and every test double, keep working: absent falls back to the
   * runtime's own declared type.
   */
  runtimeType?: string;
  traceStore: TraceStoreLike;
  agentSessionStore?: AgentSessionStoreLike;
  /** What model and effort this turn runs on — see {@link ExecutionSettingsResolver}. */
  resolveExecutionSettings?: ExecutionSettingsResolver;
  /**
   * This turn's stop handle, owned by the caller (DOR-791).
   *
   * Created and registered in `deliver()` BEFORE the concurrency line and the
   * per-session queue, because a turn is cancelable from the moment its message
   * arrives — not from the moment it reaches the head of its queue. Already
   * aborted on entry means the turn was stopped while it waited, and it must
   * not start: `sendMessage` is what starts, and bills, it.
   *
   * Required, not optional: a handler that ran without one would be a turn
   * nothing can stop, which is the exact bug this exists to close.
   */
  turnController: AbortController;
  /**
   * Where a STARTED turn records which runtime owns its conversation — see
   * {@link SessionRuntimeBinder}.
   *
   * Passed by the adapter for an agent-scoped mesh subject and for nothing else,
   * because that is the one shape whose runtime is resolved per turn and so the
   * one shape that can be re-decided mid-conversation (DOR-1774). A session
   * subject already carries its owner in the subject; a legacy subject names a
   * session the cockpit binds.
   */
  bindSessionRuntime?: SessionRuntimeBinder;
  /**
   * Where this turn records the envelope it is answering, so the agent's own
   * `relay_send*` calls continue that budget instead of minting a fresh one
   * (DOR-791). Absent means no threading — the pre-existing behaviour.
   */
  inboundBudgets?: InboundTurnBudgets;
  /**
   * This turn's clock, injectable so a test can pin the TTL boundary instead of
   * racing it (DOR-1729).
   *
   * The deadline below is `envelope.budget.ttl - now()`, and reading the wall
   * clock for it makes the handler's own startup path part of the sum: a
   * fixture with a millisecond-scale TTL is out of budget before `sendMessage`
   * on a machine under load, so the turn is refused outright instead of being
   * stopped mid-stream — which is a different path from the one the test is
   * about. A test that hands over a fixed clock spends the budget in the unit
   * the code spends rather than in whatever the runner had left.
   *
   * Defaults to `Date.now`, which is what every host gets: nothing wires this.
   */
  now?: () => number;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Who an agent-addressed message is for, and the key its turn runs under. */
export interface AgentTurnIdentity {
  /** The agent the subject names. Aliases `sessionId` in the subject's slot. */
  agentId: string;
  /** The payload's `conversationId`, when it named one. */
  conversationId?: string;
  /**
   * The stable key this conversation is remembered by: the agent alone, or the
   * agent and its conversation. What {@link AgentSessionStoreLike} is keyed on.
   */
  scope: string;
  /** The SDK session id a previous turn on this scope persisted, if any. */
  persistedSdkSessionId?: string;
  /**
   * The key this turn actually runs under — the persisted SDK session id once
   * one exists, and the scope until then.
   */
  key: string;
}

/**
 * Who an agent-addressed message is for, and the key its turn will run under.
 *
 * **Exported because the adapter has to ask the same question before the handler
 * runs.** Which runtime answers is a question about the SESSION now (DOR-1774),
 * and the adapter resolves that before it takes a concurrency slot — so it needs
 * the key this turn will run under, computed the one way, here. Two derivations
 * of that key would bind one id and resume another.
 *
 * The scope is the agent alone unless the payload threads a conversation:
 * `conversationId` lets one caller hold a distinct conversation with the same
 * agent (an A2A `contextId` lands here). TRUST MODEL: it is caller-supplied, so
 * it is a partition key and not a per-principal boundary — a caller who learns
 * another's conversationId can deliberately join that session. Callers must
 * treat it as a shared secret (unguessable values, e.g. UUIDs); per-principal
 * isolation is future work. See contributing/api-reference.md § A2A Gateway →
 * Deployment security. Platform sources that omit it keep the legacy agent-wide
 * session, behavior-preserving.
 *
 * @param subject - The subject the message arrived on.
 * @param envelope - The envelope, for a payload `conversationId`.
 * @param store - The host's agent-key → SDK-session-id map, when it wired one.
 * @returns `null` when the subject names no agent at all.
 */
export function resolveAgentTurnIdentity(
  subject: string,
  envelope: RelayEnvelope,
  store: AgentSessionStoreLike | undefined
): AgentTurnIdentity | null {
  const agentId = extractAgentId(subject);
  if (!agentId) return null;
  const payload =
    typeof envelope.payload === 'object' && envelope.payload !== null
      ? (envelope.payload as Record<string, unknown>)
      : null;
  const conversationId =
    typeof payload?.conversationId === 'string' && payload.conversationId.length > 0
      ? payload.conversationId
      : undefined;
  const scope = conversationId ? `${agentId}:${conversationId}` : agentId;
  const persistedSdkSessionId = store?.get(scope);
  return {
    agentId,
    ...(conversationId ? { conversationId } : {}),
    scope,
    ...(persistedSdkSessionId ? { persistedSdkSessionId } : {}),
    key: persistedSdkSessionId ?? scope,
  };
}

/** Platform response context set by inbound chat adapters (Slack, Telegram, third-party). */
interface ResponseContext {
  platform?: string;
  maxLength?: number;
  supportedFormats?: string[];
  formattingInstructions?: string;
}

/**
 * The event source for a turn that never started.
 *
 * An empty (synchronous) iterable, which `for await` consumes just as happily
 * as the runtime's own stream — so a stopped-before-start turn walks the same
 * path as one stopped mid-stream, and publishes the same terminal error and
 * done to whoever is reading its replies.
 */
const NO_EVENTS: readonly StreamEvent[] = [];

/**
 * How a stopped turn is described to everything downstream of it.
 *
 * A turn ends early for two different reasons and they are not interchangeable:
 * the message ran out of time, or whoever started it stopped waiting. Both used
 * to read as "TTL budget expired", which sent anyone reading a trace row or a
 * chat error looking for a budget problem that never happened.
 *
 * The out-of-time wording is deliberately plain, and it splits again by whether
 * the turn ever began. This string is read by PEOPLE — it lands in a chat where
 * somebody was waiting for an answer — and "TTL budget expired" tells them
 * nothing they can act on. Since DOR-1770 refuses messages that were already
 * stale on arrival, that is a sentence a person can now see, so it says what
 * actually happened: their message sat too long before the agent got to it.
 *
 * @param signal - The turn's abort signal.
 * @param started - Whether the turn reached the runtime at all. False for one
 *   refused before it began.
 * @returns The reason, or `undefined` for a turn that was not stopped at all.
 */
function abortText(signal: AbortSignal, started: boolean): string | undefined {
  if (!signal.aborted) return undefined;
  if (isCallerCancel(signal.reason)) {
    return signal.reason.reason === 'caller_timeout'
      ? 'Stopped: the caller stopped waiting for this turn'
      : 'Stopped: the caller cancelled this turn';
  }
  return started
    ? 'The message ran out of time before the agent finished'
    : 'The message expired before the agent could start';
}

/**
 * StreamEvent types that are skipped to prevent infinite loops (Bug 1 guard).
 *
 * A hand-set `replyTo: relay.agent.*` can route any StreamEvent back to an
 * agent as if it were a prompt; this set is what tells that case apart from a
 * real message. Derived from {@link StreamEventTypeSchema}'s own enum values
 * (DOR-804) rather than a hand-copied literal list: `thinking_delta`,
 * `tool_progress`, and `system_status` were missing from an earlier literal
 * copy of this set, each added only after it round-tripped as a prompt in
 * production — three instances of the same class of gap. Deriving from the
 * schema closes the class instead of the instances: a stream event type added
 * to `StreamEventTypeSchema` automatically joins this guard, with nothing
 * left to remember to update here.
 *
 * The fixture test pins its own literal expected list rather than importing
 * this set, on purpose — an import would move in lockstep with a regression
 * here instead of catching it; the test separately asserts this set's
 * coverage against the schema so a mismatch between the two is still caught.
 */
const STREAM_EVENT_TYPES: ReadonlySet<string> = new Set(StreamEventTypeSchema.options);

/**
 * Handle a relay.agent.{agentId} message.
 *
 * Resolves the agent ID, records trace spans, formats the prompt with
 * relay context, and streams the agent response back to envelope.replyTo.
 *
 * @param startTime - When delivery began, for the `durationMs` this reports.
 *   An ARGUMENT rather than a clock read, so it sits outside the fence
 *   {@link AgentHandlerDeps.now} draws: source it from the same clock you
 *   inject there, or the two disagree and the duration comes out negative.
 */
export async function handleAgentMessage(
  subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  startTime: number,
  deps: AgentHandlerDeps,
  relay: RelayPublisher | null
): Promise<DeliveryResult> {
  // Every clock read in this turn, so a test that pins one pins all of them —
  // a handler that took its deadline from an injected clock and its trace
  // timestamps from the wall clock would report a turn that ended before it
  // started. See {@link AgentHandlerDeps.now}.
  const now = deps.now ?? Date.now;
  const identity = resolveAgentTurnIdentity(subject, envelope, deps.agentSessionStore);
  if (!identity) {
    return {
      success: false,
      error: `Could not extract agentId from subject: ${subject}`,
      durationMs: now() - startTime,
    };
  }
  const { agentId, conversationId, scope: sessionScope, persistedSdkSessionId } = identity;

  const log = deps.logger ?? console;

  if (!deps.agentSessionStore) {
    log.warn(
      '[CCA] agentSessionStore not provided — SDK session mapping will not persist across restarts'
    );
  }

  // Extract binding-enriched fields from payload
  const payloadObj =
    typeof envelope.payload === 'object' && envelope.payload !== null
      ? (envelope.payload as Record<string, unknown>)
      : null;

  // The session scope, the persisted SDK id and the key this turn runs under all
  // come from `resolveAgentTurnIdentity` above — the same call the adapter makes
  // to decide which runtime answers, so the key that gets bound and the key the
  // next turn resumes under cannot disagree (DOR-1774).
  const ccaSessionKey = identity.key;
  log.debug?.(
    `[CCA] session lookup: agentId=${agentId}, conversationId=${conversationId ?? '(none)'}, sessionScope=${sessionScope}, persistedSdkSessionId=${persistedSdkSessionId ?? '(none)'}, hasStarted=${!!persistedSdkSessionId}`
  );

  // Record trace span as pending
  deps.traceStore.insertSpan({
    messageId: envelope.id,
    traceId: randomUUID(),
    spanId: randomUUID(),
    parentSpanId: context?.trace?.parentSpanId ?? null,
    subject: envelope.subject,
    fromEndpoint: envelope.from,
    toEndpoint: `agent:${agentId}/${ccaSessionKey}`,
    status: 'pending',
    budgetHopsUsed: envelope.budget.hopCount,
    budgetTtlRemainingMs: envelope.budget.ttl - now(),
    sentAt: now(),
    deliveredAt: null,
    processedAt: null,
    error: null,
  });

  // Extract binding-enriched fields from the payload resolved above.
  const bindingPerms = payloadObj?.__bindingPermissions as
    { permissionMode?: PermissionMode } | undefined;
  const responseContext = payloadObj?.responseContext as ResponseContext | undefined;

  // Resolve CWD: payload cwd > Mesh agent context directory > deferred
  const payloadCwd = payloadObj?.cwd as string | undefined;
  const effectiveCwd = payloadCwd ?? context?.agent?.directory;
  // A fallback is correct HERE and nowhere upstream: this reads a JSON payload
  // off the relay bus, so the field can be absent for reasons the binding never
  // controls (an older publisher, a hand-built envelope). It lands on the
  // prompting mode — absence is not consent (DOR-604). The in-process readers
  // that used to default to 'acceptEdits' were the bug and are gone.
  const effectivePermissionMode: PermissionMode = bindingPerms?.permissionMode ?? 'default';

  // Which model an agent is, is a property of the AGENT — so the manifest is
  // looked for where the agent lives, and NOT at `effectiveCwd`. The two differ
  // exactly when a payload names its own working directory: that moves where
  // the turn runs, which is a fact about this message, and it must not silently
  // re-decide who the answering agent is. Falls back to the payload's directory
  // only when nothing resolved an agent at all, because a project directory is
  // a better guess at a manifest than nothing.
  const agentManifestDir = context?.agent?.directory ?? payloadCwd;

  // What this turn runs on. Asked BEFORE `ensureSession`, because that call is
  // the only one that can answer it: the claude-code runtime reads
  // `session.model` when it launches a query, and that field is written once,
  // when the session record is created. A model handed over afterwards reaches
  // nothing (see `messaging/launch-resolver.ts`).
  const executionSettings = await resolveTurnSettings(deps, ccaSessionKey, agentManifestDir, log);

  log.debug?.(
    `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
      `payloadCwd=${payloadCwd ?? '(none)'}, context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
      `resolvedCwd=${effectiveCwd ?? '(deferred to session)'}, permissionMode=${effectivePermissionMode}, ` +
      `model=${executionSettings.model ?? '(runtime default)'}`
  );

  const controller = deps.turnController;

  // **One reading of the clock decides both halves of this turn's deadline** —
  // whether the message may run at all, and, if it may, how long it has. The two
  // are the same question and must come from the same number: an envelope live
  // by three milliseconds when the first question is asked is dead by the time a
  // second reading answers the second, and then NEITHER bounds it — no refusal,
  // and no deadline either, because there is no positive remainder left to
  // schedule. The turn runs with no deadline at all, holding a capacity slot and
  // its session's queue entry until the model stops on its own.
  //
  // So `ttlRemaining` is read here, once, and everything below derives from it.
  const ttlRemaining = ttlRemainingMs(envelope, now);
  const expired = isExpired(ttlRemaining);

  // An expired envelope never runs (`lib/envelope-ttl.ts`). This handler used to
  // be the one seam that disagreed: a message with no time left fell through to
  // a fresh `defaultTimeoutMs` deadline and answered as if it had just arrived,
  // while the scheduled-run path beside it refused the same envelope (DOR-1770).
  //
  // The refusal is an abort of this turn's own handle, taken BEFORE anything
  // starts, because that is the door the turn already has: everything downstream
  // treats it exactly as it treats a turn stopped while it queued — no session,
  // no `sendMessage`, no bill — and still publishes the terminal error and
  // `done` that a reply reader settles on. Refusing by returning early here
  // would be silence, and silence is what hangs callers.
  if (expired) {
    log.debug?.(
      `[CCA] refusing ${envelope.id} for ${agentId}: the message expired before this turn could start`
    );
    controller.abort();
  }

  // Stopped before it could start — expired above, or stopped while it waited in
  // the concurrency line or in its session's queue behind another turn. Nothing
  // about it may start: no session, no `sendMessage`, no bill. The terminal error
  // and done still go out below, so whoever is reading the reply stream settles
  // instead of hanging (DOR-791).
  const stoppedBeforeStart = controller.signal.aborted;

  // Only mark hasStarted when we have a real SDK session ID from the persistent
  // store.  Without one, the runtime would attempt to resume using the DorkOS-
  // generated UUID (which the SDK never assigned), causing a "No conversation
  // found" error before the self-healing retry creates a fresh session.
  if (!stoppedBeforeStart) {
    deps.agentManager.ensureSession(ccaSessionKey, {
      permissionMode: effectivePermissionMode,
      hasStarted: !!persistedSdkSessionId,
      ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
      ...executionSettings,
    });
  }
  deps.traceStore.updateSpan(envelope.id, { status: 'delivered', deliveredAt: now() });

  if (!envelope.replyTo) {
    log.warn(
      `ClaudeCodeAdapter: envelope ${envelope.id} has no replyTo — response events will not be published`
    );
  }

  // Skip StreamEvent payloads to prevent infinite loops
  if (payloadObj?.type && STREAM_EVENT_TYPES.has(payloadObj.type as string)) {
    log.debug?.(
      `[CCA] skipping sendMessage for StreamEvent payload type=${String(payloadObj.type)}`
    );
    deps.traceStore.updateSpan(envelope.id, { status: 'processed', processedAt: now() });
    return { success: true, durationMs: now() - startTime };
  }

  const correlationId = payloadObj?.correlationId as string | undefined;
  const prompt = formatPromptWithContext(
    extractPayloadContent(envelope.payload),
    envelope,
    agentId,
    ccaSessionKey,
    now
  );
  const formatBlock = buildResponseFormatBlock(responseContext);

  // The deadline, from the SAME reading the refusal above was decided on.
  // Whatever the envelope had left is the whole of it: no floor, no fallback,
  // because a turn granted more time than its message has left is the bug above
  // wearing a different hat. `expired` is the only branch that skips the timer,
  // and it is the branch where the turn was already refused — so a turn that
  // started always has a deadline, by construction rather than by luck.
  const timeout = expired ? undefined : setTimeout(() => controller.abort(), ttlRemaining);
  // Stopping has to reach the RUNTIME, not just the loop below: `sendMessage`
  // takes no signal, so breaking out of the stream leaves the model running and
  // billing until it finishes on its own. That was true of the TTL deadline too
  // — this listener ends both kinds of stop at the agent (DOR-791).
  //
  // Interrupting by SESSION KEY is only safe because the adapter runs one turn
  // per session at a time (`runtimeAdapter.enqueue`, keyed by the same id): the
  // in-flight turn on this key is necessarily this one, so a stop can never
  // reach into a bystander's turn. A future change that lets two turns share a
  // session key concurrently has to give the runtime a narrower handle first.
  controller.signal.addEventListener(
    'abort',
    () => {
      void interruptTurn(deps.agentManager, ccaSessionKey, `turn ${ccaSessionKey}`, deps.logger);
    },
    { once: true }
  );
  // Tie this turn to the envelope that started it, for as long as it runs
  // (DOR-791). Anything the agent sends with `relay_send*` while it runs
  // continues THIS budget — decremented — instead of minting a fresh full one,
  // which is what let two agents trade messages forever with a hop counter that
  // reset every lap. Bound BEFORE `sendMessage`, because the tool server is
  // built as the query starts, and not at all for a turn that never starts:
  // there is nothing for a turn that will not run to inherit.
  const releaseInboundBudget = stoppedBeforeStart
    ? undefined
    : deps.inboundBudgets?.bind(ccaSessionKey, envelope.budget);

  const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
  const eventStream = stoppedBeforeStart
    ? NO_EVENTS
    : deps.agentManager.sendMessage(ccaSessionKey, prompt, {
        permissionMode: effectivePermissionMode,
        ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
        ...(formatBlock ? { systemPromptAppend: formatBlock } : {}),
        // Sent again, for the same reason the permission mode and the cwd are:
        // the runtime contract resolves a turn as per-send override → persisted
        // → its own default, and a runtime whose sessions are not held in
        // memory sees this call and not the one above.
        ...executionSettings,
      });

  let eventCount = 0,
    collectedText = '',
    stepCounter = 0,
    messageBuffer = '';
  let streamedDone = false,
    streamError: string | undefined;
  // An `error` event the turn emitted and then carried on from, ending with a
  // normal `done`. Kept apart from `streamError` (a THROWN iterator) on purpose:
  // `streamError` decides this delivery's success flag and trace-span status,
  // and an upstream API 500 inside an otherwise-complete turn is not a delivery
  // failure — the message arrived and was processed. What it must change is the
  // ANSWER the caller reads, which is the `agent_result` below (DOR-1337 / F6).
  let inStreamError: string | undefined;

  try {
    for await (const event of eventStream) {
      if (controller.signal.aborted) break;
      eventCount++;
      if (event.type === 'done') streamedDone = true;

      if (envelope.replyTo && relay) {
        if (isInboxReplyTo) {
          if (event.type === 'error') {
            const data = event.data as { message?: string; code?: string } | undefined;
            if (!isNonFatalErrorCode(data?.code)) {
              // First failure wins: a turn that reports several is described by
              // the one that started it, not by whatever landed last.
              inStreamError ??= data?.message ?? 'Agent turn reported an error';
            }
          }
          if (event.type === 'text_delta') {
            const data = event.data as { text: string };
            messageBuffer += data.text;
            collectedText += data.text;
          }
          if (event.type === 'tool_call_start' && messageBuffer) {
            stepCounter++;
            await publishDispatchProgress(
              envelope,
              stepCounter,
              'message',
              messageBuffer,
              ccaSessionKey,
              relay
            );
            messageBuffer = '';
          }
          if (event.type === 'tool_result') {
            stepCounter++;
            const data = event.data as { content?: string; tool_use_id?: string };
            await publishDispatchProgress(
              envelope,
              stepCounter,
              'tool_result',
              typeof data.content === 'string' ? data.content : JSON.stringify(data),
              ccaSessionKey,
              relay
            );
          }
        } else {
          await publishResponseWithCorrelation(
            envelope,
            event,
            ccaSessionKey,
            relay,
            log,
            correlationId,
            { agentId }
          );
        }
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err.message : String(err);
    log.error('[CCA] Streaming error:', describeError(err));
    deps.traceStore.updateSpan(envelope.id, {
      status: 'failed',
      processedAt: now(),
      error: streamError,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    // Released when the QUERY is over, which is not the same instant the
    // iteration stops (DOR-791).
    //
    // A clean end and a thrown iterator both mean the query is done, so the
    // binding goes. A STOPPED turn — its TTL, or a caller that cancelled — does
    // not: the abort listener above asks the runtime to interrupt, but
    // `interruptTurn` is bounded and best-effort by design ("this bound only
    // decides how long we wait to learn the outcome"), so the turn may still be
    // producing for a moment. A `relay_send` landing in that window and
    // inheriting NOTHING would mint a FRESH full budget — hop zero, ten calls,
    // another hour — which is the chain escaping on exactly the stop that was
    // supposed to end it.
    //
    // So a stopped turn KEEPS its binding, exactly as it stood: a TTL death
    // leaves an expired budget, which the publish gate refuses as `ttl_expired`,
    // and a cancel leaves a live one, which is still the chain's own and still
    // decrements. Nothing is leaked — one entry per session, replaced by that
    // session's next inbound message, and bounded by the registry's LRU cap.
    if (controller.signal.aborted) {
      log.debug?.(
        `[CCA] stopped turn: holding the inbound budget for ${ccaSessionKey} so a late send ` +
          `cannot start a fresh chain on a turn that was told to end`
      );
    } else {
      releaseInboundBudget?.();
    }
    if (!streamedDone && envelope.replyTo && relay) {
      // On a crashed (thrown iterator) or TTL-aborted turn, emit an explicit
      // error signal BEFORE the synthesized done. Reply consumers (the A2A
      // executor's reply-events parser, relay_send_and_wait) otherwise read a
      // bare done as a successful completion and surface the partial streamed
      // text as a finished answer. The `{ type: 'error', data: { message } }`
      // event matches ErrorEventSchema, so those consumers fail the turn.
      const failureMessage = streamError ?? abortText(controller.signal, !stoppedBeforeStart);
      if (failureMessage) {
        try {
          await publishResponseWithCorrelation(
            envelope,
            { type: 'error', data: { message: failureMessage } },
            ccaSessionKey,
            relay,
            log,
            correlationId
          );
        } catch {
          log.warn('[CCA] Failed to publish terminal error event');
        }
      }
      try {
        await publishResponseWithCorrelation(
          envelope,
          { type: 'done', data: { sessionId: ccaSessionKey } },
          ccaSessionKey,
          relay,
          log,
          correlationId
        );
      } catch {
        log.warn('[CCA] Failed to publish terminal done event');
      }
    }
  }

  // Flush and publish final result for relay.inbox.* replyTos
  if (isInboxReplyTo && envelope.replyTo && relay) {
    if (messageBuffer) {
      stepCounter++;
      await publishDispatchProgress(
        envelope,
        stepCounter,
        'message',
        messageBuffer,
        ccaSessionKey,
        relay
      );
    }
    // Every way this turn can have failed, on the ONE payload an inbox reader is
    // told is terminal. A thrown iterator and a TTL abort also publish a separate
    // error event from the `finally` above, which is enough for the synchronous
    // waiter (it settles on the first non-progress payload) but not for a poller:
    // that one reads a list, is told `done:true` ends it, and would otherwise see
    // an error event next to a clean-looking result and have to guess which won.
    const failure =
      inStreamError ?? streamError ?? abortText(controller.signal, !stoppedBeforeStart);
    await publishAgentResult(envelope, collectedText, ccaSessionKey, relay, failure);
  }

  // Persist SDK session UUID for future messages. A runtime that does not
  // rename its own sessions (codex, opencode) declares no `getSdkSessionId`,
  // and there is nothing to persist: the key this turn ran under is already the
  // durable id, so the next message resolves the same session without a mapping.
  //
  // Whatever comes out of this is the id the NEXT message on this scope will
  // resume under, which is the only id worth binding below.
  let durableSessionKey = ccaSessionKey;
  if (deps.agentSessionStore && !persistedSdkSessionId) {
    const actualSdkId = deps.agentManager.getSdkSessionId?.(ccaSessionKey);
    if (actualSdkId && actualSdkId !== sessionScope) {
      deps.agentSessionStore.set(sessionScope, actualSdkId);
      durableSessionKey = actualSdkId;
      log.info(`[CCA] persisted session mapping: ${sessionScope} → ${actualSdkId}`);
    } else {
      log.debug?.(
        `[CCA] no session mapping to persist: sessionScope=${sessionScope}, ` +
          `ccaSessionKey=${ccaSessionKey}, actualSdkId=${actualSdkId ?? '(none)'}`
      );
    }
  }

  // **Which runtime owns this conversation, recorded once the turn is known to
  // have STARTED** (DOR-1774). Without it the manifest is re-read every turn and
  // an edit made mid-conversation hands the remaining turns to a program that
  // has no transcript for the key it is given — the DOR-764 shape, on the one
  // subject family that had no memory of its own.
  //
  // Three things about the timing, all of them load-bearing, and each mirroring
  // the same call in `room-turn-runner.ts`:
  //
  // - **Only for a turn that ran.** `eventCount > 0` is this handler's version
  //   of the room's `result.accepted`: `sendMessage` hands back a lazy
  //   generator, so nothing has reached the runtime until it yields, and a turn
  //   refused, stopped before it started, or thrown out of on the first pull
  //   produced no transcript for anyone to be bound to. Writing on arrival
  //   instead would mint one row per message that never ran, and afterwards
  //   nothing can tell those rows from real bindings.
  // - **Not only for a turn that SUCCEEDED.** A turn that streamed and then
  //   crashed or ran out of time still wrote a transcript under this id, so its
  //   owner is a fact whatever the ending was. Gating on success would leave the
  //   very conversation most likely to be resumed unbound.
  // - **Below everything that publishes, and its failure is LOGGED rather than
  //   thrown.** This is bookkeeping about a turn whose answer has already gone
  //   out. A `SQLITE_BUSY` here must not turn an answered turn into a failed
  //   delivery — what is lost is one attribution row, which the next turn on
  //   this conversation writes again.
  if (deps.bindSessionRuntime && eventCount > 0) {
    try {
      await deps.bindSessionRuntime({
        sessionId: durableSessionKey,
        runtimeType: deps.runtimeType ?? deps.agentManager.type ?? 'claude-code',
        ...(agentManifestDir ? { agentDirectory: agentManifestDir } : {}),
      });
    } catch (err) {
      log.warn(
        `[CCA] could not record which runtime owns ${durableSessionKey}; the next turn on this ` +
          `conversation will resolve it from the agent's manifest again`,
        describeError(err)
      );
    }
  }

  log.info(
    `ClaudeCodeAdapter: published ${eventCount} event(s) to ${envelope.replyTo ?? '(no replyTo)'}`
  );

  const aborted = controller.signal.aborted;
  const failed = !!streamError || aborted;
  if (!streamError) {
    deps.traceStore.updateSpan(envelope.id, {
      status: aborted ? 'failed' : 'processed',
      processedAt: now(),
      ...(aborted && { error: abortText(controller.signal, !stoppedBeforeStart) }),
    });
  }

  return {
    success: !failed,
    error: streamError ?? abortText(controller.signal, !stoppedBeforeStart),
    deadLettered: aborted,
    durationMs: now() - startTime,
  };
}

// === Private: pure helpers ===

/**
 * Ask the host what this turn should run on, and never let the answer stop it.
 *
 * Three ways to get nothing, and all three mean the same thing — no preference,
 * so the runtime picks, which is what every relay turn did before this existed:
 * a host that wired no resolver, an agent whose directory is unknown, and a
 * lookup that threw. The last one is the reason this is a function rather than
 * an inline `await`: reading a manifest or a settings row can fail for reasons
 * that have nothing to do with the message, and a dropped agent-to-agent
 * message is a far worse outcome than a turn on the default model.
 *
 * @param deps - The handler's dependencies; the resolver is optional on them.
 * @param sessionId - The key this turn runs under (`ccaSessionKey`).
 * @param agentDirectory - Where the turn runs, which is where its manifest is.
 * @param log - Where a failed lookup is reported.
 */
async function resolveTurnSettings(
  deps: AgentHandlerDeps,
  sessionId: string,
  agentDirectory: string | undefined,
  log: NonNullable<AgentHandlerDeps['logger']> | Console
): Promise<TurnExecutionSettings> {
  if (!deps.resolveExecutionSettings) return {};
  try {
    return await deps.resolveExecutionSettings({
      sessionId,
      runtimeType: deps.runtimeType ?? deps.agentManager.type ?? 'claude-code',
      ...(agentDirectory ? { agentDirectory } : {}),
    });
  } catch (err) {
    log.warn(
      `[CCA] could not resolve execution settings for ${sessionId}; running on the runtime default`,
      describeError(err)
    );
    return {};
  }
}

/**
 * Extract agent ID from a `relay.agent.*` subject.
 *
 * Historically `agentId` and `sessionId` alias the same slot here (see the
 * ID glossary at the top of `claude-code-adapter.ts`). Delegates to the shared
 * {@link extractSessionIdFromSubject} helper so both the legacy shape
 * (`relay.agent.<sessionId>`) and the runtime-scoped shape
 * (`relay.agent.<runtimeType>.<sessionId>`) are handled consistently.
 */
function extractAgentId(subject: string): string | null {
  return extractSessionIdFromSubject(subject);
}

/**
 * Build a `<response_format>` system prompt block from platform response context.
 *
 * The function is a thin wrapper: it adds a platform header and passes through
 * whatever formatting instructions the adapter provided. When no adapter-supplied
 * `formattingInstructions` are present, a generic fallback is used for platforms
 * that don't support Markdown.
 *
 * Returns an empty string when no platform context is available, so the agent
 * behaves identically to today for non-adapter message sources.
 *
 * @internal Exported for testing only.
 */
export function buildResponseFormatBlock(ctx: ResponseContext | undefined): string {
  if (!ctx?.platform) return '';

  const lines = [
    `Platform: ${ctx.platform}`,
    ctx.maxLength ? `Maximum response length: ${ctx.maxLength} characters` : '',
  ];

  if (ctx.formattingInstructions) {
    lines.push('', ctx.formattingInstructions);
  } else if (ctx.supportedFormats && !ctx.supportedFormats.includes('markdown')) {
    lines.push('', 'FORMATTING RULES (you MUST follow these):');
    lines.push(
      '- Avoid complex Markdown formatting (tables, headings) — use plain text with bullet points.'
    );
  }

  return `<response_format>\n${lines.filter(Boolean).join('\n')}\n</response_format>`;
}

/**
 * Tags that mean something to a runtime and must not be forgeable by a stranger
 * on Telegram or Slack.
 *
 * Driven off the shared {@link CONTEXT_TAG} map plus `system-reminder`, exactly
 * as the rooms preamble does, so a new context kind is covered here the day it
 * is added rather than the day somebody remembers this list exists.
 */
const SYSTEM_TAGS = [...Object.values(CONTEXT_TAG), 'system-reminder'];

/**
 * Format the user prompt with a <relay_context> XML block.
 *
 * When the envelope's payload carries a sender name and/or chat title
 * (Telegram/Slack inbound), a `Sender:`/`Chat:` line is inserted right after
 * `From:` so the agent knows who it is talking to. Absent either field, the
 * block is byte-identical to the plain envelope-metadata format.
 *
 * ## The message body is somebody else's words
 *
 * Everything after the block is written by whoever sent the message, and a
 * chat platform will happily carry `</relay_context>` or `<system-reminder>` in
 * a message. Written straight through, those close the block early and let a
 * stranger add lines the agent reads as DorkOS's own instructions. The body is
 * therefore run through {@link defuseSystemTags}, which escapes the opening `<`
 * of a system tag and leaves ordinary prose and code (`Vec<T>`, `a < b`,
 * `<div>`) exactly as written — people paste code into chat, and mangling it
 * would be a real cost. The identity lines are a different job and were already
 * handled: {@link extractSenderIdentity} runs `sanitizeIdentity` over them.
 *
 * ## Known residual: no nonce fence here
 *
 * The strongest form of this boundary is a per-turn nonce fence — markers a
 * writer cannot predict, which is what makes the boundary unforgeable rather
 * than merely hard to spell. Rooms have one; relay does not, because the fence
 * helper currently lives in the server's runtime layer
 * (`services/runtimes/shared/room-context-block.ts`) and is not importable from
 * this package. Defusal is the whole boundary here rather than defence in
 * depth, so this is a real gap, narrowed but not closed. Extracting the fence
 * into `@dorkos/shared` so both callers share it is filed as follow-up.
 */
function formatPromptWithContext(
  content: string,
  envelope: RelayEnvelope,
  agentId: string,
  sdkSessionId: string,
  now: () => number
): string {
  const { sender, chat } = extractSenderIdentity(envelope.payload);
  const lines = [
    `Agent-ID: ${agentId}`,
    `Session-ID: ${sdkSessionId}`,
    `From: ${envelope.from}`,
    ...(sender !== undefined ? [`Sender: ${sender}`] : []),
    ...(chat !== undefined ? [`Chat: ${chat}`] : []),
    `Message-ID: ${envelope.id}`,
    `Subject: ${envelope.subject}`,
    `Sent: ${envelope.createdAt}`,
    '',
    'Budget remaining:',
    `- Hops: ${envelope.budget.hopCount} of ${envelope.budget.maxHops} used`,
    `- TTL: ${Math.max(0, Math.round((envelope.budget.ttl - now()) / 1000))} seconds remaining`,
    `- Max turns: ${envelope.budget.callBudgetRemaining}`,
  ];
  if (envelope.replyTo) {
    lines.push(
      '',
      `Reply to: ${envelope.replyTo}`,
      "If you cannot complete the task within the budget, summarize what you've done and stop."
    );
  }
  return (
    `<${CONTEXT_TAG.relay_context}>\n${lines.join('\n')}\n</${CONTEXT_TAG.relay_context}>\n\n` +
    defuseSystemTags(content, SYSTEM_TAGS)
  );
}

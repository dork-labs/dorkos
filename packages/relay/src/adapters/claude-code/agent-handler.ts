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
import type { PermissionMode } from '@dorkos/shared/schemas';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import { defuseSystemTags } from '@dorkos/shared/untrusted-text';
import type {
  RelayPublisher,
  AdapterContext,
  DeliveryResult,
  TraceStoreLike,
} from '../../types.js';
import { extractPayloadContent, extractSenderIdentity } from '../../lib/payload-utils.js';
import { extractSessionIdFromSubject } from '../../lib/subjects.js';
import type { AgentRuntimeLike, AgentSessionStoreLike } from './types.js';
import {
  publishAgentResult,
  publishDispatchProgress,
  publishResponseWithCorrelation,
} from './publish.js';

/** Dependencies required by the agent handler. */
export interface AgentHandlerDeps {
  agentManager: AgentRuntimeLike;
  traceStore: TraceStoreLike;
  agentSessionStore?: AgentSessionStoreLike;
  logger?: import('@dorkos/shared/logger').Logger;
}

/** Resolved config values needed by the agent handler. */
export interface AgentHandlerConfig {
  defaultTimeoutMs: number;
}

/** Platform response context set by inbound chat adapters (Slack, Telegram, third-party). */
interface ResponseContext {
  platform?: string;
  maxLength?: number;
  supportedFormats?: string[];
  formattingInstructions?: string;
}

/**
 * `error` events that do NOT mean the turn failed.
 *
 * A DENYLIST, not an allowlist, and the direction is the whole decision. Most
 * genuinely fatal errors reaching this adapter carry no `code` at all — a
 * boundary violation, an empty stream, a crashed sender all publish
 * `{ type: 'error', data: { message } }` — so an allowlist of "fatal codes"
 * would silently pass every one of them off as a successful empty answer, which
 * is precisely the bug this whole change exists to fix (DOR-1337 / F6). A
 * denylist fails the other way: an error nobody has classified yet is reported
 * as a failure, and being told about a failure that was survivable costs a
 * retry, while being told nothing about a real one costs the answer.
 *
 * `hook_failure` is on it because a hook is the OPERATOR'S own script, not the
 * agent's work. The claude-code runtime escalates any non-tool hook that exits
 * non-zero (Stop, SubagentStop, SessionStart — this repo configures all three)
 * to a stream `error` event, and the turn then ends with a normal `done`
 * carrying the complete answer. Folding that in would turn a correct reply into
 * an `AGENT_ERROR` whose `partialText` is the whole answer nobody reads.
 *
 * Runtime-neutral by construction: this module receives `StreamEvent`s from any
 * `AgentRuntimeLike`, so the rule is about the code's MEANING, not about which
 * runtime emitted it. A new runtime that invents a non-fatal error code adds it
 * here; until then its errors are treated as failures, which is the safe half.
 */
const NON_FATAL_ERROR_CODES: ReadonlySet<string> = new Set(['hook_failure']);

/**
 * Whether an `error` event's code marks it as survivable rather than turn-fatal.
 *
 * @param code - The `data.code` of an `error` StreamEvent, when it has one.
 */
function isNonFatalErrorCode(code: string | undefined): boolean {
  return code !== undefined && NON_FATAL_ERROR_CODES.has(code);
}

/** StreamEvent types that are skipped to prevent infinite loops (Bug 1 guard). */
const STREAM_EVENT_TYPES = new Set([
  'text_delta',
  'tool_call_start',
  'tool_call_end',
  'tool_call_delta',
  'tool_result',
  'session_status',
  'approval_required',
  'question_prompt',
  'error',
  'done',
  'task_update',
  'relay_message',
  'relay_receipt',
  'message_delivered',
]);

/**
 * Handle a relay.agent.{agentId} message.
 *
 * Resolves the agent ID, records trace spans, formats the prompt with
 * relay context, and streams the agent response back to envelope.replyTo.
 */
export async function handleAgentMessage(
  subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  startTime: number,
  config: AgentHandlerConfig,
  deps: AgentHandlerDeps,
  relay: RelayPublisher | null
): Promise<DeliveryResult> {
  const agentId = extractAgentId(subject);
  if (!agentId) {
    return {
      success: false,
      error: `Could not extract agentId from subject: ${subject}`,
      durationMs: Date.now() - startTime,
    };
  }

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

  // Session scope: an inbound payload may carry a conversationId to thread a
  // distinct conversation with the same agent (e.g. an external caller's A2A
  // contextId lands here as StandardPayload.conversationId). Callers using
  // distinct conversationIds get distinct sessions instead of sharing one
  // long-lived agent session. TRUST MODEL: conversationId is caller-supplied,
  // so this is a partition key, not a per-principal boundary — a caller who
  // learns another's conversationId can deliberately join that session.
  // Callers must treat it as a shared secret (unguessable values, e.g. UUIDs);
  // per-principal isolation is future work. See contributing/api-reference.md
  // § A2A Gateway → Deployment security. Platform sources that omit it keep
  // the legacy agent-wide session (scope === agentId), behavior-preserving.
  const conversationId =
    typeof payloadObj?.conversationId === 'string' && payloadObj.conversationId.length > 0
      ? payloadObj.conversationId
      : undefined;
  const sessionScope = conversationId ? `${agentId}:${conversationId}` : agentId;

  // Resolve canonical SDK session ID from persistent store
  const persistedSdkSessionId = deps.agentSessionStore?.get(sessionScope);
  const ccaSessionKey = persistedSdkSessionId ?? sessionScope;
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
    budgetTtlRemainingMs: envelope.budget.ttl - Date.now(),
    sentAt: Date.now(),
    deliveredAt: null,
    processedAt: null,
    error: null,
  });

  // Extract binding-enriched fields from the payload resolved above.
  const bindingPerms = payloadObj?.__bindingPermissions as
    | { permissionMode?: PermissionMode }
    | undefined;
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
  log.debug?.(
    `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
      `payloadCwd=${payloadCwd ?? '(none)'}, context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
      `resolvedCwd=${effectiveCwd ?? '(deferred to session)'}, permissionMode=${effectivePermissionMode}`
  );

  // Only mark hasStarted when we have a real SDK session ID from the persistent
  // store.  Without one, the runtime would attempt to resume using the DorkOS-
  // generated UUID (which the SDK never assigned), causing a "No conversation
  // found" error before the self-healing retry creates a fresh session.
  deps.agentManager.ensureSession(ccaSessionKey, {
    permissionMode: effectivePermissionMode,
    hasStarted: !!persistedSdkSessionId,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });
  deps.traceStore.updateSpan(envelope.id, { status: 'delivered', deliveredAt: Date.now() });

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
    deps.traceStore.updateSpan(envelope.id, { status: 'processed', processedAt: Date.now() });
    return { success: true, durationMs: Date.now() - startTime };
  }

  const correlationId = payloadObj?.correlationId as string | undefined;
  const prompt = formatPromptWithContext(
    extractPayloadContent(envelope.payload),
    envelope,
    agentId,
    ccaSessionKey
  );
  const formatBlock = buildResponseFormatBlock(responseContext);

  // Set up timeout from TTL budget
  const ttlRemaining = envelope.budget.ttl - Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    ttlRemaining > 0 ? ttlRemaining : config.defaultTimeoutMs
  );
  const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
  const eventStream = deps.agentManager.sendMessage(ccaSessionKey, prompt, {
    permissionMode: effectivePermissionMode,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
    ...(formatBlock ? { systemPromptAppend: formatBlock } : {}),
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
    log.error('[CCA] Streaming error:', err);
    deps.traceStore.updateSpan(envelope.id, {
      status: 'failed',
      processedAt: Date.now(),
      error: streamError,
    });
  } finally {
    clearTimeout(timeout);
    if (!streamedDone && envelope.replyTo && relay) {
      // On a crashed (thrown iterator) or TTL-aborted turn, emit an explicit
      // error signal BEFORE the synthesized done. Reply consumers (the A2A
      // executor's reply-events parser, relay_send_and_wait) otherwise read a
      // bare done as a successful completion and surface the partial streamed
      // text as a finished answer. The `{ type: 'error', data: { message } }`
      // event matches ErrorEventSchema, so those consumers fail the turn.
      const failureMessage =
        streamError ?? (controller.signal.aborted ? 'TTL budget expired' : undefined);
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
      inStreamError ??
      streamError ??
      (controller.signal.aborted ? 'TTL budget expired' : undefined);
    await publishAgentResult(envelope, collectedText, ccaSessionKey, relay, failure);
  }

  // Persist SDK session UUID for future messages
  if (deps.agentSessionStore && !persistedSdkSessionId) {
    const actualSdkId = deps.agentManager.getSdkSessionId(ccaSessionKey);
    if (actualSdkId && actualSdkId !== sessionScope) {
      deps.agentSessionStore.set(sessionScope, actualSdkId);
      log.info(`[CCA] persisted session mapping: ${sessionScope} → ${actualSdkId}`);
    } else {
      log.debug?.(
        `[CCA] no session mapping to persist: sessionScope=${sessionScope}, ` +
          `ccaSessionKey=${ccaSessionKey}, actualSdkId=${actualSdkId ?? '(none)'}`
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
      processedAt: Date.now(),
      ...(aborted && { error: 'TTL budget expired' }),
    });
  }

  return {
    success: !failed,
    error: streamError ?? (aborted ? 'TTL budget expired' : undefined),
    deadLettered: aborted,
    durationMs: Date.now() - startTime,
  };
}

// === Private: pure helpers ===

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
  sdkSessionId: string
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
    `- TTL: ${Math.max(0, Math.round((envelope.budget.ttl - Date.now()) / 1000))} seconds remaining`,
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

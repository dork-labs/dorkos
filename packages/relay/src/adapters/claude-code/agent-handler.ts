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
import type { RelayPublisher, AdapterContext, DeliveryResult, TraceStoreLike } from '../../types.js';
import { extractPayloadContent } from '../../lib/payload-utils.js';
import type { AgentRuntimeLike, AgentSessionStoreLike } from './types.js';
import { publishAgentResult, publishDispatchProgress, publishResponseWithCorrelation } from './publish.js';

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

/** StreamEvent types that are skipped to prevent infinite loops (Bug 1 guard). */
const STREAM_EVENT_TYPES = new Set([
  'text_delta', 'tool_call_start', 'tool_call_end', 'tool_call_delta',
  'tool_result', 'session_status', 'approval_required', 'question_prompt',
  'error', 'done', 'task_update', 'relay_message', 'relay_receipt', 'message_delivered',
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
  relay: RelayPublisher | null,
): Promise<DeliveryResult> {
  const agentId = extractAgentId(subject);
  if (!agentId) {
    return { success: false, error: `Could not extract agentId from subject: ${subject}`, durationMs: Date.now() - startTime };
  }

  // Resolve canonical SDK session ID from persistent store
  const persistedSdkSessionId = deps.agentSessionStore?.get(agentId);
  const ccaSessionKey = persistedSdkSessionId ?? agentId;
  const log = deps.logger ?? console;

  // Record trace span as pending
  deps.traceStore.insertSpan({
    messageId: envelope.id, traceId: randomUUID(), spanId: randomUUID(),
    parentSpanId: context?.trace?.parentSpanId ?? null,
    subject: envelope.subject, fromEndpoint: envelope.from,
    toEndpoint: `agent:${agentId}/${ccaSessionKey}`, status: 'pending',
    budgetHopsUsed: envelope.budget.hopCount, budgetTtlRemainingMs: envelope.budget.ttl - Date.now(),
    sentAt: Date.now(), deliveredAt: null, processedAt: null, error: null,
  });

  // Extract binding-enriched fields from payload
  const payloadObj = typeof envelope.payload === 'object' && envelope.payload !== null
    ? (envelope.payload as Record<string, unknown>) : null;
  const bindingPerms = payloadObj?.__bindingPermissions as
    { permissionMode?: string } | undefined;

  // Resolve CWD: payload cwd > Mesh agent context directory > deferred
  const payloadCwd = payloadObj?.cwd as string | undefined;
  const effectiveCwd = payloadCwd ?? context?.agent?.directory;
  const effectivePermissionMode = bindingPerms?.permissionMode ?? 'default';
  log.debug?.(
    `[CCA] handleAgentMessage agentId=${agentId} ccaSessionKey=${ccaSessionKey}, ` +
    `payloadCwd=${payloadCwd ?? '(none)'}, context.agent.directory=${context?.agent?.directory ?? '(none)'}, ` +
    `resolvedCwd=${effectiveCwd ?? '(deferred to session)'}, permissionMode=${effectivePermissionMode}`,
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
    log.warn(`ClaudeCodeAdapter: envelope ${envelope.id} has no replyTo — response events will not be published`);
  }

  // Skip StreamEvent payloads to prevent infinite loops
  if (payloadObj?.type && STREAM_EVENT_TYPES.has(payloadObj.type as string)) {
    log.debug?.(`[CCA] skipping sendMessage for StreamEvent payload type=${String(payloadObj.type)}`);
    deps.traceStore.updateSpan(envelope.id, { status: 'processed', processedAt: Date.now() });
    return { success: true, durationMs: Date.now() - startTime };
  }

  const correlationId = payloadObj?.correlationId as string | undefined;
  const prompt = formatPromptWithContext(extractPayloadContent(envelope.payload), envelope, agentId, ccaSessionKey);

  // Set up timeout from TTL budget
  const ttlRemaining = envelope.budget.ttl - Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ttlRemaining > 0 ? ttlRemaining : config.defaultTimeoutMs);
  const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
  const eventStream = deps.agentManager.sendMessage(ccaSessionKey, prompt, {
    permissionMode: effectivePermissionMode,
    ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
  });

  let eventCount = 0, collectedText = '', stepCounter = 0, messageBuffer = '';
  let streamedDone = false, streamError: string | undefined;

  try {
    for await (const event of eventStream) {
      if (controller.signal.aborted) break;
      eventCount++;
      if (event.type === 'done') streamedDone = true;

      if (envelope.replyTo && relay) {
        if (isInboxReplyTo) {
          if (event.type === 'text_delta') {
            const data = event.data as { text: string };
            messageBuffer += data.text;
            collectedText += data.text;
          }
          if (event.type === 'tool_call_start' && messageBuffer) {
            stepCounter++;
            await publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey, relay);
            messageBuffer = '';
          }
          if (event.type === 'tool_result') {
            stepCounter++;
            const data = event.data as { content?: string; tool_use_id?: string };
            await publishDispatchProgress(envelope, stepCounter, 'tool_result',
              typeof data.content === 'string' ? data.content : JSON.stringify(data), ccaSessionKey, relay);
          }
        } else {
          await publishResponseWithCorrelation(envelope, event, ccaSessionKey, relay, log, correlationId, { agentId });
        }
      }
    }
  } catch (err) {
    streamError = err instanceof Error ? err.message : String(err);
    log.error('[CCA] Streaming error:', err);
    deps.traceStore.updateSpan(envelope.id, { status: 'failed', processedAt: Date.now(), error: streamError });
  } finally {
    clearTimeout(timeout);
    if (!streamedDone && envelope.replyTo && relay) {
      try {
        await publishResponseWithCorrelation(envelope, { type: 'done', data: { sessionId: ccaSessionKey } },
          ccaSessionKey, relay, log, correlationId);
      } catch { log.warn('[CCA] Failed to publish terminal done event'); }
    }
  }

  // Flush and publish final result for relay.inbox.* replyTos
  if (isInboxReplyTo && envelope.replyTo && relay) {
    if (messageBuffer) {
      stepCounter++;
      await publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey, relay);
    }
    await publishAgentResult(envelope, collectedText, ccaSessionKey, relay);
  }

  // Persist SDK session UUID for future messages
  if (deps.agentSessionStore && !persistedSdkSessionId) {
    const actualSdkId = deps.agentManager.getSdkSessionId(ccaSessionKey);
    if (actualSdkId && actualSdkId !== agentId) {
      deps.agentSessionStore.set(agentId, actualSdkId);
      log.debug?.(`[CCA] persisted session mapping: ${agentId} → ${actualSdkId}`);
    } else {
      log.debug?.(`[CCA] no session mapping to persist: agentId=${agentId}, ` +
        `ccaSessionKey=${ccaSessionKey}, actualSdkId=${actualSdkId ?? '(none)'}`);
    }
  }

  log.info(`ClaudeCodeAdapter: published ${eventCount} event(s) to ${envelope.replyTo ?? '(no replyTo)'}`);

  const aborted = controller.signal.aborted;
  const failed = !!streamError || aborted;
  if (!streamError) {
    deps.traceStore.updateSpan(envelope.id, {
      status: aborted ? 'failed' : 'processed', processedAt: Date.now(),
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

/** Extract agent ID from relay.agent.{agentId} subject. */
function extractAgentId(subject: string): string | null {
  const segments = subject.split('.');
  if (segments.length < 3 || segments[0] !== 'relay' || segments[1] !== 'agent') return null;
  return segments[2] || null;
}

/** Format the user prompt with a <relay_context> XML block. */
function formatPromptWithContext(content: string, envelope: RelayEnvelope, agentId: string, sdkSessionId: string): string {
  const lines = [
    `Agent-ID: ${agentId}`, `Session-ID: ${sdkSessionId}`,
    `From: ${envelope.from}`, `Message-ID: ${envelope.id}`,
    `Subject: ${envelope.subject}`, `Sent: ${envelope.createdAt}`,
    '', 'Budget remaining:',
    `- Hops: ${envelope.budget.hopCount} of ${envelope.budget.maxHops} used`,
    `- TTL: ${Math.max(0, Math.round((envelope.budget.ttl - Date.now()) / 1000))} seconds remaining`,
    `- Max turns: ${envelope.budget.callBudgetRemaining}`,
  ];
  if (envelope.replyTo) {
    lines.push('', `Reply to: ${envelope.replyTo}`,
      "If you cannot complete the task within the budget, summarize what you've done and stop.");
  }
  return `<relay_context>\n${lines.join('\n')}\n</relay_context>\n\n${content}`;
}

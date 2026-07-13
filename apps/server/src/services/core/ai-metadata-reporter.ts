/**
 * Opt-in AI-run metadata reporter (DOR-319, ADR 260713-143958 Phase 7 — the
 * Tier 2 bridge).
 *
 * Buffers one PostHog-native `$ai_generation` event per completed runtime turn
 * and flushes them in small batches to the owned ingest at
 * https://dorkos.ai/api/telemetry/events — the same pipe the usage and
 * `$exception` events ride, so no vendor SDK is ever embedded in a client.
 *
 * This is a thin SIBLING of the usage reporter, not a rider on its queue, on
 * purpose:
 *   - `$ai_generation` is a `$`-prefixed PostHog-native event OUTSIDE the curated
 *     `TelemetryEventSchema` union (exactly like `$exception`, which also has its
 *     own sender), so it can't validate through the usage queue.
 *   - It is gated by a DIFFERENT, independently-toggleable consent channel
 *     (`telemetry.aiMetadata`, opt-in) than the usage channel
 *     (`telemetry.usage`, Tier 1 opt-out) — coupling them would leak one
 *     consent choice into the other.
 *
 * Consent (folded into the single `enabled` boolean by the caller):
 *   - `config.telemetry.aiMetadata` must be on (defaults FALSE — the user
 *     turning it on IS the explicit opt-in), AND
 *   - no env kill switch is set (`resolveTelemetryConsent` folds in
 *     `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`).
 * The Tier 1 notice gate does NOT apply — this is opt-in, so the choice is the
 * consent. When `enabled` is false, registration is a complete no-op (no timer,
 * no bridge install, no network) and the observability bridge stays uninstalled,
 * so the runtime-wrap seam never even harvests.
 *
 * In debug mode (`DORKOS_TELEMETRY_DEBUG`), each flush prints the exact batch to
 * stderr and sends nothing, so a power user can audit the wire format. Errors are
 * swallowed everywhere — telemetry must never surface to the user.
 *
 * @module services/core/ai-metadata-reporter
 */
import { randomUUID } from 'crypto';

import { AiGenerationEventSchema, type AiGenerationEvent } from '@dorkos/shared/telemetry-events';

import type { AiTurnMetadata } from '../observability/index.js';
import { setAiMetadataBridge } from '../observability/index.js';
import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger } from '../../lib/logger.js';

/** Where AI-metadata batches are delivered (the shared owned ingest). */
export const AI_METADATA_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/** Default gap between automatic flushes (60s), matching the usage reporter. */
export const AI_METADATA_FLUSH_INTERVAL_MS = 60_000;

/**
 * Hard cap on the in-memory queue. If the endpoint is unreachable and events
 * pile up, the oldest are dropped past this bound so a wedged network can never
 * grow memory without limit. Metadata is best-effort; losing the tail is fine.
 */
export const AI_METADATA_QUEUE_MAX = 500;

/** Max events sent in a single batch POST (matches the ingest's batch bound). */
export const AI_METADATA_BATCH_MAX = 100;

/** A queued turn: the harvested metadata plus the capture timestamp. */
interface QueuedTurn {
  metadata: AiTurnMetadata;
  /** ISO-8601 instant captured when the turn completed. */
  timestamp: string;
}

/** Options for {@link registerAiMetadataReporter}. */
export interface AiMetadataReporterOptions {
  /**
   * The final consent word: `config.telemetry.aiMetadata` folded through
   * `resolveTelemetryConsent` (env kill switch). When false, registration is a
   * complete no-op and the observability bridge is torn down.
   */
  enabled: boolean;
  /** Debug mode (`DORKOS_TELEMETRY_DEBUG`): print each batch to stderr, send nothing. */
  debug: boolean;
  /** Resolved dorkHome path (for the anonymous per-install instance id). */
  dorkHome: string;
  /** Current DorkOS version, stamped into every event's envelope. */
  dorkosVersion: string;
  /** Override the flush interval (tests). Defaults to {@link AI_METADATA_FLUSH_INTERVAL_MS}. */
  flushIntervalMs?: number;
  /** Override the ingest endpoint (tests). Defaults to {@link AI_METADATA_ENDPOINT}. */
  endpoint?: string;
  /** Override `fetch` (tests). Defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** Live reporter state; `null` when not registered or consent is off. */
interface ReporterState {
  debug: boolean;
  dorkHome: string;
  dorkosVersion: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  queue: QueuedTurn[];
  timer: NodeJS.Timeout | null;
  /** Cached anonymous instance id, resolved lazily on the first flush. */
  instanceId: string | null;
  /** Guards against overlapping async flushes. */
  flushing: boolean;
}

let state: ReporterState | null = null;

/**
 * Register the AI-metadata reporter for the lifetime of the server, and install
 * (or, when disabled, clear) the observability bridge that feeds it. No-op when
 * `options.enabled` is false — no timer is scheduled, the bridge stays null (so
 * the runtime-wrap seam never harvests for the bridge), and nothing is read or
 * sent. When enabled, it starts an `unref()`ed flush interval so it never keeps
 * the process alive, and installs {@link reportAiTurn} as the bridge sink.
 *
 * Calling it again replaces any prior registration (the previous timer is
 * cleared, the bridge is reinstalled), so a re-register cannot leak timers.
 *
 * @param options - Consent, identity, and delivery inputs.
 */
export function registerAiMetadataReporter(options: AiMetadataReporterOptions): void {
  // A re-register (or a disable) tears down any prior timer + bridge first.
  if (state?.timer) clearTimeout(state.timer);
  if (!options.enabled) {
    state = null;
    setAiMetadataBridge(null);
    return;
  }

  state = {
    debug: options.debug,
    dorkHome: options.dorkHome,
    dorkosVersion: options.dorkosVersion,
    endpoint: options.endpoint ?? AI_METADATA_ENDPOINT,
    fetchImpl: options.fetchImpl ?? fetch,
    queue: [],
    timer: null,
    instanceId: null,
    flushing: false,
  };

  const intervalMs = options.flushIntervalMs ?? AI_METADATA_FLUSH_INTERVAL_MS;
  const tick = (): void => {
    void flushAiMetadata().finally(() => {
      if (state) {
        state.timer = setTimeout(tick, intervalMs);
        state.timer.unref();
      }
    });
  };
  state.timer = setTimeout(tick, intervalMs);
  state.timer.unref();

  // Install the bridge so the runtime-wrap seam hands us each completed turn.
  setAiMetadataBridge(reportAiTurn);

  logger.info('[Telemetry] AI-metadata reporter registered (owned ingest → PostHog, opt-in)');
}

/**
 * Enqueue one completed turn's metadata for the next flush. Installed as the
 * observability bridge sink; a no-op when the reporter is not registered.
 * Synchronous and cheap: it only records the metadata + a timestamp.
 *
 * @param metadata - The non-content turn metadata harvested at the runtime seam.
 */
export function reportAiTurn(metadata: AiTurnMetadata): void {
  if (!state) return;
  state.queue.push({ metadata, timestamp: new Date().toISOString() });
  if (state.queue.length > AI_METADATA_QUEUE_MAX) {
    state.queue.splice(0, state.queue.length - AI_METADATA_QUEUE_MAX);
  }
}

/**
 * Build the strict, allowlisted `$ai_generation` event for one turn. A fresh
 * random `$ai_trace_id` is minted per turn (an opaque, ephemeral correlation id
 * PostHog requires on every AI event — never derived from content). Optional
 * fields are included only when known, so the strict schema is satisfied.
 * `$ai_latency` is seconds (PostHog's unit); `$process_person_profile` is pinned
 * false so the event never creates a PostHog person.
 *
 * @param turn - The queued turn (metadata + timestamp).
 * @param distinctId - The anonymous per-install id (a UUID, not a user id).
 * @param dorkosVersion - The emitting build, stamped into the envelope.
 */
function buildAiGenerationEvent(
  turn: QueuedTurn,
  distinctId: string,
  dorkosVersion: string
): AiGenerationEvent {
  const { metadata } = turn;
  return {
    event: '$ai_generation',
    properties: {
      $ai_trace_id: randomUUID(),
      $ai_provider: metadata.runtime,
      ...(metadata.model !== undefined ? { $ai_model: metadata.model } : {}),
      ...(metadata.inputTokens !== undefined ? { $ai_input_tokens: metadata.inputTokens } : {}),
      ...(metadata.outputTokens !== undefined ? { $ai_output_tokens: metadata.outputTokens } : {}),
      $ai_latency: metadata.latencyMs / 1000,
      ...(metadata.costUsd !== undefined ? { $ai_total_cost_usd: metadata.costUsd } : {}),
      $process_person_profile: false,
    },
    distinctId,
    timestamp: turn.timestamp,
    dorkosVersion,
  };
}

/**
 * Flush queued turns now: drain up to {@link AI_METADATA_BATCH_MAX} into one
 * batch and deliver it. In debug mode the batch is printed to stderr and not
 * sent. No-op when unregistered, already flushing, or the queue is empty. Errors
 * are swallowed; on a send failure the drained events are dropped (best-effort).
 *
 * Called on the interval and once more at graceful shutdown.
 */
export async function flushAiMetadata(): Promise<void> {
  const s = state;
  if (!s || s.flushing || s.queue.length === 0) return;
  s.flushing = true;
  try {
    const drained = s.queue.splice(0, AI_METADATA_BATCH_MAX);

    if (s.instanceId == null) {
      try {
        s.instanceId = await getOrCreateInstanceId(s.dorkHome);
      } catch {
        // Can't identify the install — drop this batch; a later flush retries.
        return;
      }
    }

    const events: AiGenerationEvent[] = [];
    for (const turn of drained) {
      const candidate = buildAiGenerationEvent(turn, s.instanceId, s.dorkosVersion);
      // Defensive: the registry is the source of truth. A malformed event is
      // dropped, never sent — this is the send-side no-content contract.
      const parsed = AiGenerationEventSchema.safeParse(candidate);
      if (parsed.success) events.push(parsed.data);
    }
    if (events.length === 0) return;

    if (s.debug) {
      process.stderr.write(
        `[Telemetry] DORKOS_TELEMETRY_DEBUG: AI-metadata batch NOT sent. Would POST to ${s.endpoint}:\n` +
          `${JSON.stringify({ events }, null, 2)}\n`
      );
      return;
    }

    await s.fetchImpl(s.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
    });
  } catch {
    // Telemetry must never fail user operations.
  } finally {
    if (state) state.flushing = false;
  }
}

/**
 * Stop the reporter, clear the bridge, and flush any remaining events. Called at
 * graceful shutdown so a clean exit doesn't drop the tail of the queue.
 * Idempotent.
 */
export async function shutdownAiMetadataReporter(): Promise<void> {
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  setAiMetadataBridge(null);
  await flushAiMetadata();
  state = null;
}

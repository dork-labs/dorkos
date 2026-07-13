/**
 * Anonymous feature-usage reporter (DOR-315, ADR 260713-143958 Phase 3).
 *
 * Buffers curated product-usage events (from the shared registry in
 * `@dorkos/shared/telemetry-events`) and flushes them in small batches to the
 * owned ingest at https://dorkos.ai/api/telemetry/events — the single pipe all
 * four client surfaces ride (Transport → server → owned ingest), so no vendor
 * SDK is ever embedded in the cockpit, desktop, or Obsidian.
 *
 * Consent, exactly like the heartbeat and install channels:
 *   - `config.telemetry.usage` must be on (defaults `true`, Tier 1), AND
 *   - no env kill switch is set (`resolveTelemetryConsent` folds in
 *     `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED`), AND
 *   - the Tier 1 notice gate captured at boot is open (`decideTier1Boot`'s
 *     pre-notice `sendGate` snapshot, evaluated via the shared
 *     `hasTier1SendGate`) so a never-prompted install stays silent.
 * The call site (`index.ts`) resolves all three into the single `enabled`
 * boolean this module treats as the final word; `registerUsageReporter` is a
 * complete no-op (no timer, no id read, no network) when `enabled` is false.
 *
 * In debug mode (`DORKOS_TELEMETRY_DEBUG`), each flush prints the exact batch to
 * stderr and sends nothing, so a power user can audit the wire format.
 *
 * Errors are swallowed everywhere — telemetry must never surface to the user or
 * destabilize the server.
 *
 * @module services/core/usage-reporter
 */

import {
  TelemetryEventSchema,
  TelemetryEventInputSchema,
  type TelemetryEvent,
  type TelemetryEventInput,
} from '@dorkos/shared/telemetry-events';

import { getOrCreateInstanceId } from '../../lib/instance-id.js';
import { logger } from '../../lib/logger.js';

/** Where usage-event batches are delivered. */
export const USAGE_ENDPOINT = 'https://dorkos.ai/api/telemetry/events';

/** Default gap between automatic flushes (60s). */
export const USAGE_FLUSH_INTERVAL_MS = 60_000;

/**
 * Hard cap on the in-memory queue. If the endpoint is unreachable and events
 * pile up, the oldest are dropped past this bound so a wedged network can never
 * grow memory without limit. Usage events are best-effort; losing the tail of a
 * backlog is acceptable.
 */
export const USAGE_QUEUE_MAX = 500;

/** Max events sent in a single batch POST (matches the ingest's batch bound). */
export const USAGE_BATCH_MAX = 100;

/** A queued event: the caller-supplied half plus the capture timestamp. */
interface QueuedEvent {
  input: TelemetryEventInput;
  /** ISO-8601 instant captured when the event was enqueued (its true time). */
  timestamp: string;
}

/** Options for {@link registerUsageReporter}. */
export interface UsageReporterOptions {
  /**
   * The final consent word: `config.telemetry.usage` folded through
   * `resolveTelemetryConsent` (env kill switch) AND the captured Tier 1
   * notice gate (`decideTier1Boot().sendGate`). When false, registration is a
   * complete no-op.
   */
  enabled: boolean;
  /**
   * Debug mode (`DORKOS_TELEMETRY_DEBUG`): print each batch to stderr instead of
   * sending it over the network.
   */
  debug: boolean;
  /** Resolved dorkHome path (for the anonymous instance id). */
  dorkHome: string;
  /** Current DorkOS version, stamped into every event's envelope. */
  dorkosVersion: string;
  /** Override the flush interval (tests). Defaults to {@link USAGE_FLUSH_INTERVAL_MS}. */
  flushIntervalMs?: number;
  /** Override the ingest endpoint (tests). Defaults to {@link USAGE_ENDPOINT}. */
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
  queue: QueuedEvent[];
  timer: NodeJS.Timeout | null;
  /** Cached anonymous instance id, resolved lazily on the first flush. */
  instanceId: string | null;
  /** Guards against overlapping async flushes. */
  flushing: boolean;
}

let state: ReporterState | null = null;

/**
 * Register the usage reporter for the lifetime of the server. No-op when
 * `options.enabled` is false — no timer is scheduled and nothing is read or
 * sent. When enabled, it starts an `unref()`ed flush interval so it never keeps
 * the process alive, and {@link reportUsageEvent} begins buffering events.
 *
 * Calling it again replaces any prior registration (the previous timer is
 * cleared), so a re-register cannot leak timers.
 *
 * @param options - Consent, identity, and delivery inputs.
 */
export function registerUsageReporter(options: UsageReporterOptions): void {
  // A re-register (or a disable) tears down any prior timer first.
  if (state?.timer) clearTimeout(state.timer);
  if (!options.enabled) {
    state = null;
    return;
  }

  state = {
    debug: options.debug,
    dorkHome: options.dorkHome,
    dorkosVersion: options.dorkosVersion,
    endpoint: options.endpoint ?? USAGE_ENDPOINT,
    fetchImpl: options.fetchImpl ?? fetch,
    queue: [],
    timer: null,
    instanceId: null,
    flushing: false,
  };

  const intervalMs = options.flushIntervalMs ?? USAGE_FLUSH_INTERVAL_MS;
  const tick = (): void => {
    void flushUsageEvents().finally(() => {
      // Re-arm only while still registered.
      if (state) {
        state.timer = setTimeout(tick, intervalMs);
        state.timer.unref();
      }
    });
  };
  state.timer = setTimeout(tick, intervalMs);
  state.timer.unref();

  logger.info('[Telemetry] Usage reporter registered (consent: opt-out, notice-gated)');
}

/**
 * Enqueue one product-usage event for the next flush. A no-op when the reporter
 * is not registered (consent off) or the event fails registry validation —
 * producers can call this unconditionally from anywhere in the app. Cheap and
 * synchronous: it only validates and appends.
 *
 * @param input - The `{ event, properties }` half; the envelope is filled at flush.
 */
export function reportUsageEvent(input: TelemetryEventInput): void {
  if (!state) return;
  // Defensive: the registry is the source of truth even though the input is
  // typed. A malformed event is dropped, never sent.
  const parsed = TelemetryEventInputSchema.safeParse(input);
  if (!parsed.success) return;

  state.queue.push({ input: parsed.data, timestamp: new Date().toISOString() });
  // Bound the queue: drop the oldest overflow so a wedged endpoint can't grow
  // memory without limit.
  if (state.queue.length > USAGE_QUEUE_MAX) {
    state.queue.splice(0, state.queue.length - USAGE_QUEUE_MAX);
  }
}

/**
 * Flush queued events now: drain up to {@link USAGE_BATCH_MAX} into one batch
 * and deliver it. In debug mode the batch is printed to stderr and not sent.
 * No-op when unregistered, already flushing, or the queue is empty. Errors are
 * swallowed; on a send failure the drained events are dropped (best-effort — we
 * do not re-queue, to avoid an unbounded retry backlog).
 *
 * Called on the interval and once more at graceful shutdown.
 */
export async function flushUsageEvents(): Promise<void> {
  const s = state;
  if (!s || s.flushing || s.queue.length === 0) return;
  s.flushing = true;
  try {
    const drained = s.queue.splice(0, USAGE_BATCH_MAX);

    // Resolve the anonymous instance id once and cache it.
    if (s.instanceId == null) {
      try {
        s.instanceId = await getOrCreateInstanceId(s.dorkHome);
      } catch {
        // Can't identify the install — drop this batch; a later flush retries.
        return;
      }
    }

    const events: TelemetryEvent[] = [];
    for (const item of drained) {
      const candidate = {
        event: item.input.event,
        properties: item.input.properties,
        distinctId: s.instanceId,
        timestamp: item.timestamp,
        dorkosVersion: s.dorkosVersion,
      };
      const parsed = TelemetryEventSchema.safeParse(candidate);
      if (parsed.success) events.push(parsed.data);
    }
    if (events.length === 0) return;

    const body = JSON.stringify({ events });

    if (s.debug) {
      process.stderr.write(
        `[Telemetry] DORKOS_TELEMETRY_DEBUG: usage batch NOT sent. Would POST to ${s.endpoint}:\n` +
          `${JSON.stringify({ events }, null, 2)}\n`
      );
      return;
    }

    await s.fetchImpl(s.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
  } catch {
    // Telemetry must never fail user operations.
  } finally {
    if (state) state.flushing = false;
  }
}

/**
 * Stop the reporter and flush any remaining events. Called at graceful
 * shutdown so a clean exit doesn't drop the tail of the queue. Idempotent.
 */
export async function shutdownUsageReporter(): Promise<void> {
  if (!state) return;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  await flushUsageEvents();
  state = null;
}

/**
 * The curated catalog of first-party product-usage events DorkOS may send to
 * dorkos.ai (Plane 1, Tier 1 — anonymous, opt-out; ADR 260713-143958 Phase 3).
 *
 * This module is the **single source of truth for event names and their exact
 * property shapes**. No event name lives anywhere else in the app: the server
 * usage-reporter builds events against these schemas, and the owned-ingest route
 * at `apps/site/src/app/api/telemetry/events/route.ts` mirrors this catalog with
 * a route-local copy (per ADR-0235 the site keeps route-local schemas rather
 * than importing `@dorkos/shared`) — the two carry cross-reference comments so a
 * reviewer catches drift.
 *
 * Design rules, enforced here:
 *   - Event names are snake_case `[object]_[verb]` (`app_started`,
 *     `session_created`).
 *   - Every event's property object is a **strict allowlist** — unknown
 *     properties are rejected, so a stray field (a path, a prompt, an email) can
 *     never ride along. This is the load-bearing half of the no-PII contract on
 *     the send side.
 *   - The wire envelope is `{ event, properties, distinctId, timestamp,
 *     dorkosVersion }`; a batch is `{ events: [...] }`. `distinctId` is the app's
 *     anonymous per-install `instanceId`, never a user id.
 *
 * @module telemetry-events
 */

import { z } from 'zod';

/** Maximum length for the free-form string properties carried by an event. */
const MAX_STRING_LEN = 64;

/**
 * The complete set of product-usage event names DorkOS may emit. Adding a name
 * here (with a matching property schema below) is the only way a new event can
 * exist. Kept as a `const` tuple so it doubles as the {@link TelemetryEventName}
 * union.
 */
export const TELEMETRY_EVENT_NAMES = ['app_started', 'session_created'] as const;

/** One of the curated {@link TELEMETRY_EVENT_NAMES}. */
export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];

/**
 * Properties for `app_started`: emitted once when the DorkOS server boots.
 * `os` is the coarse platform-arch string (e.g. `darwin-arm64`);
 * `runtimesConfigured` is how many agent runtimes are enabled — a count, never
 * the runtime names, and never anything machine-identifying.
 */
export const AppStartedProperties = z
  .object({
    os: z.string().min(1).max(MAX_STRING_LEN),
    runtimesConfigured: z.number().int().min(0).max(64),
  })
  .strict();

/**
 * Properties for `session_created`: emitted once when a new agent session is
 * first bound to a runtime. Carries only which runtime owns the session (e.g.
 * `claude-code`) — never the cwd, prompt, agent name, or session id.
 */
export const SessionCreatedProperties = z
  .object({
    runtime: z.string().min(1).max(MAX_STRING_LEN),
  })
  .strict();

/**
 * The shared wire-envelope fields every event carries. `distinctId` is the
 * anonymous per-install `instanceId` (a UUID, not a user id); `timestamp` is an
 * ISO-8601 instant captured when the event occurred; `dorkosVersion` is the
 * emitting build.
 */
const envelopeFields = {
  distinctId: z.string().uuid(),
  timestamp: z.string().datetime(),
  dorkosVersion: z.string().min(1).max(MAX_STRING_LEN),
};

/**
 * A single fully-enveloped telemetry event, discriminated on `event` so the
 * `properties` shape is correlated to the name at the type level. Strict at both
 * levels: unknown envelope keys and unknown property keys are both rejected.
 */
export const TelemetryEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('app_started'),
      properties: AppStartedProperties,
      ...envelopeFields,
    })
    .strict(),
  z
    .object({
      event: z.literal('session_created'),
      properties: SessionCreatedProperties,
      ...envelopeFields,
    })
    .strict(),
]);

/** A single fully-enveloped, registry-validated telemetry event. */
export type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

/** Maximum number of events accepted in one batch POST to the owned ingest. */
export const TELEMETRY_EVENT_BATCH_MAX = 100;

/**
 * A batch of events — the body shape POSTed to `/api/telemetry/events`. Bounded
 * so a single request can never carry an unbounded payload.
 */
export const TelemetryEventBatchSchema = z
  .object({
    events: z.array(TelemetryEventSchema).min(1).max(TELEMETRY_EVENT_BATCH_MAX),
  })
  .strict();

/** A registry-validated batch of telemetry events. */
export type TelemetryEventBatch = z.infer<typeof TelemetryEventBatchSchema>;

/**
 * The caller-supplied half of an event: just `event` + `properties`. The server
 * usage-reporter fills the envelope (`distinctId`, `timestamp`, `dorkosVersion`)
 * at send time, so producers only ever describe *what happened*. Strict, and
 * discriminated on `event` like {@link TelemetryEventSchema}.
 */
export const TelemetryEventInputSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('app_started'), properties: AppStartedProperties }).strict(),
  z.object({ event: z.literal('session_created'), properties: SessionCreatedProperties }).strict(),
]);

/** The caller-supplied `{ event, properties }` half of a telemetry event. */
export type TelemetryEventInput = z.infer<typeof TelemetryEventInputSchema>;

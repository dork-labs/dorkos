/**
 * `POST /api/telemetry/events` — the owned ingest for anonymous, curated app
 * usage events (DOR-315, ADR 260713-143958 Phase 3 — "one owned ingest,
 * event-stream-first").
 *
 * Runs as a Vercel Edge Function, mirroring the install/heartbeat telemetry
 * routes. Unlike those, there is **no Neon table**: Neon stays system-of-record
 * only for install + heartbeat sinks. Usage events fan out server-side to
 * PostHog's `/batch/` endpoint and nowhere else, so the PostHog project key
 * lives only in site env and no client surface embeds a vendor SDK.
 *
 * Ingest posture (differs from install/heartbeat on purpose):
 *   - **Always 200, graceful degrade.** This is a fire-and-forget event stream;
 *     the app must never learn about backend health or retry. Malformed JSON, a
 *     non-batch body, and per-event validation failures all still return
 *     `200 { ok: true, accepted }` — invalid events are dropped, valid ones
 *     accepted (partial-batch acceptance).
 *   - **Per-event allowlist validation.** Each event is validated against the
 *     route-LOCAL schema below, which MIRRORS the shared registry at
 *     `packages/shared/src/telemetry-events.ts`. Per ADR-0235 the site keeps
 *     route-local schemas rather than importing `@dorkos/shared`; the two carry
 *     cross-reference comments so a reviewer catches drift. Keep them in
 *     lockstep — every strict property allowlist here must match the registry.
 *   - **Accept-and-drop when unconfigured.** With `POSTHOG_PROJECT_KEY` unset,
 *     valid events are accepted and simply not forwarded (zero errors, zero
 *     PostHog requests).
 *
 * Privacy contract: request headers (IP, cookies, user agent) are never read.
 * `distinct_id` is the payload's own `distinctId` (the app's anonymous
 * per-install `instanceId`), never a user id. Public payload docs:
 * https://dorkos.ai/telemetry
 *
 * @module app/api/telemetry/events
 */

import { z } from 'zod';

import { env } from '@/env';

export const runtime = 'edge';

const MAX_STRING_LEN = 64;
const MAX_BATCH = 100;

// --- Route-local mirror of `@dorkos/shared/telemetry-events` (ADR-0235) --------
// MUST match the shared registry's property allowlists and event names exactly.
// If you add/rename an event or property there, mirror it here (and vice versa).

/** Mirrors `AppStartedProperties` in the shared registry. */
const AppStartedProperties = z
  .object({
    os: z.string().min(1).max(MAX_STRING_LEN),
    runtimesConfigured: z.number().int().min(0).max(64),
  })
  .strict();

/** Mirrors `SessionCreatedProperties` in the shared registry. */
const SessionCreatedProperties = z
  .object({
    runtime: z.string().min(1).max(MAX_STRING_LEN),
  })
  .strict();

/** Mirrors the envelope fields in the shared registry. */
const envelopeFields = {
  distinctId: z.string().uuid(),
  timestamp: z.string().datetime(),
  dorkosVersion: z.string().min(1).max(MAX_STRING_LEN),
};

/** Mirrors `TelemetryEventSchema` (strict, discriminated on `event`). */
const TelemetryEventSchema = z.discriminatedUnion('event', [
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

type TelemetryEvent = z.infer<typeof TelemetryEventSchema>;

// --- Exception events (crash reporting) — mirrors the shared `$exception` -------
// section in `@dorkos/shared/telemetry-events` (DOR-318, ADR 260713-143958
// Phase 6). PostHog-native `$exception` events ride the SAME batch endpoint but
// are a documented carve-out from the `[object]_[verb]` convention. Keep this in
// lockstep with the shared `ExceptionEventSchema`.

const MAX_FRAME_STRING_LEN = 1024;
const MAX_STACK_FRAMES = 200;

/** Mirrors `ExceptionStackFrameSchema` in the shared registry. */
const ExceptionStackFrameSchema = z
  .object({
    platform: z.string().min(1).max(MAX_STRING_LEN),
    filename: z.string().max(MAX_FRAME_STRING_LEN),
    function: z.string().max(MAX_FRAME_STRING_LEN),
    lineno: z.number().int().min(0).optional(),
    colno: z.number().int().min(0).optional(),
    in_app: z.boolean(),
  })
  .strict();

/** Mirrors `ExceptionValueSchema` in the shared registry. */
const ExceptionValueSchema = z
  .object({
    type: z.string().max(MAX_FRAME_STRING_LEN),
    value: z.string().max(MAX_STRING_LEN),
    mechanism: z.object({ handled: z.boolean(), synthetic: z.boolean() }).strict(),
    stacktrace: z
      .object({
        type: z.literal('raw'),
        frames: z.array(ExceptionStackFrameSchema).max(MAX_STACK_FRAMES),
      })
      .strict(),
  })
  .strict();

/** Mirrors `ExceptionEventPropertiesSchema` in the shared registry. */
const ExceptionEventPropertiesSchema = z
  .object({
    $exception_list: z.array(ExceptionValueSchema).min(1).max(10),
    $exception_level: z.literal('error'),
    $process_person_profile: z.literal(false),
    surface: z.string().min(1).max(MAX_STRING_LEN),
    release: z.string().min(1).max(MAX_STRING_LEN),
    environment: z.string().min(1).max(MAX_STRING_LEN),
    os: z.string().min(1).max(MAX_STRING_LEN),
  })
  .strict();

/** Mirrors `ExceptionEventSchema` (strict, shares the envelope fields). */
const ExceptionEventSchema = z
  .object({
    event: z.literal('$exception'),
    properties: ExceptionEventPropertiesSchema,
    ...envelopeFields,
  })
  .strict();

type ExceptionEvent = z.infer<typeof ExceptionEventSchema>;

/** Any event this ingest accepts: a curated usage event OR a `$exception` crash. */
type AcceptedEvent = TelemetryEvent | ExceptionEvent;

// --- end mirror ----------------------------------------------------------------

// --- Route-local mirror of the FEEDBACK section of `@dorkos/shared/telemetry-events`
// (ADR-0235; DOR-317). Self-contained: keep in lockstep with the shared registry's
// feedback schemas. Feedback carries the ONLY free-text this ingest accepts —
// `message`/`contact` are user-volunteered and deliberately submitted, so the
// no-PII allowlist that governs usage events above does not apply to them.

const MAX_FEEDBACK_MESSAGE_LEN = 4000;
const MAX_FEEDBACK_CONTACT_LEN = 254;
const MAX_FEEDBACK_ROUTE_LEN = 256;

/** Mirrors `FeedbackSubmittedProperties` in the shared registry. */
const FeedbackSubmittedProperties = z
  .object({
    kind: z.enum(['feedback', 'bug']),
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_FEEDBACK_CONTACT_LEN).optional(),
    surface: z.enum(['cockpit', 'site']),
    route: z.string().min(1).max(MAX_FEEDBACK_ROUTE_LEN).optional(),
    dorkosVersion: z.string().min(1).max(MAX_STRING_LEN).optional(),
  })
  .strict();

/** Mirrors `FeatureRequestedProperties` in the shared registry. */
const FeatureRequestedProperties = z
  .object({
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_FEEDBACK_CONTACT_LEN).optional(),
    surface: z.enum(['cockpit', 'site']),
    route: z.string().min(1).max(MAX_FEEDBACK_ROUTE_LEN).optional(),
    dorkosVersion: z.string().min(1).max(MAX_STRING_LEN).optional(),
  })
  .strict();

/** Mirrors the lighter feedback envelope (no envelope `dorkosVersion`, lenient id). */
const feedbackEnvelopeFields = {
  distinctId: z.string().min(1).max(200),
  timestamp: z.string().datetime(),
};

/** Mirrors `FeedbackEventSchema` (strict, discriminated on `event`). */
const FeedbackEventSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('feedback_submitted'),
      properties: FeedbackSubmittedProperties,
      ...feedbackEnvelopeFields,
    })
    .strict(),
  z
    .object({
      event: z.literal('feature_requested'),
      properties: FeatureRequestedProperties,
      ...feedbackEnvelopeFields,
    })
    .strict(),
]);

type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;

// --- end feedback mirror -------------------------------------------------------

/**
 * Handle a usage-event batch POST. Always returns `200 { ok: true, accepted }`
 * — this is a fire-and-forget event stream and the app must never retry.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // Malformed JSON is a dropped batch, not a client error to retry.
    return Response.json({ ok: true, accepted: 0 });
  }

  // Honeypot (DOR-317): the feedback forms include a hidden `website` field no
  // human fills in. A non-empty value is a bot — accept (still 200, so it learns
  // nothing) but drop the whole batch without forwarding anything.
  if (
    body != null &&
    typeof body === 'object' &&
    typeof (body as { website?: unknown }).website === 'string' &&
    (body as { website: string }).website.trim() !== ''
  ) {
    return Response.json({ ok: true, accepted: 0 });
  }

  // Accept a `{ events: [...] }` batch; anything else drops with zero accepted.
  const rawEvents =
    body != null && typeof body === 'object' && Array.isArray((body as { events?: unknown }).events)
      ? (body as { events: unknown[] }).events
      : [];

  // Three event families, each validated independently so a mixed batch is
  // fine: the curated usage union, then feedback (user-volunteered, the only
  // free-text; DOR-317), then the `$exception` crash carve-out (DOR-318).
  // Anything matching none of the strict schemas is silently dropped
  // (allowlist rejection), never persisted.
  const valid: AcceptedEvent[] = [];
  const validFeedback: FeedbackEvent[] = [];
  for (const raw of rawEvents.slice(0, MAX_BATCH)) {
    const usage = TelemetryEventSchema.safeParse(raw);
    if (usage.success) {
      valid.push(usage.data);
      continue;
    }
    const feedback = FeedbackEventSchema.safeParse(raw);
    if (feedback.success) {
      validFeedback.push(feedback.data);
      continue;
    }
    const exception = ExceptionEventSchema.safeParse(raw);
    if (exception.success) valid.push(exception.data);
  }

  if (valid.length > 0) {
    await forwardToPostHog(valid);
  }
  if (validFeedback.length > 0) {
    await forwardFeedbackToPostHog(validFeedback);
  }

  return Response.json({ ok: true, accepted: valid.length + validFeedback.length });
}

/**
 * Fan valid events out to PostHog's `/batch/` endpoint, server-side. No-op when
 * `POSTHOG_PROJECT_KEY` is unset (accept-and-drop). Errors are swallowed and
 * logged so a PostHog hiccup never turns into a non-200 the app might retry on.
 *
 * `distinct_id` is the event's own anonymous `distinctId`; the DorkOS version
 * rides in `properties` as `dorkos_version`. A `$exception` event carries its
 * PostHog Error Tracking fields (`$exception_list`, …) in `properties`, which
 * spread through unchanged — PostHog groups it into an Issue server-side.
 */
async function forwardToPostHog(events: AcceptedEvent[]): Promise<void> {
  const apiKey = env.POSTHOG_PROJECT_KEY;
  if (!apiKey) return; // Unconfigured deploy: accept, forward nothing.

  // `NEXT_PUBLIC_POSTHOG_HOST` is the region-specific ingest host
  // (`https://us.i.posthog.com` | `https://eu.i.posthog.com`); the batch capture
  // endpoint is `<host>/batch/`.
  const url = `${env.NEXT_PUBLIC_POSTHOG_HOST.replace(/\/+$/, '')}/batch/`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        historical_migration: false,
        batch: events.map((e) => ({
          event: e.event,
          distinct_id: e.distinctId,
          timestamp: e.timestamp,
          properties: {
            ...e.properties,
            dorkos_version: e.dorkosVersion,
            // Marks these as owned-ingest events (vs the site's browser SDK).
            $lib: 'dorkos-owned-ingest',
          },
        })),
      }),
    });
  } catch (error) {
    console.error('[api/telemetry/events] PostHog forward failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Fan user-volunteered feedback events out to PostHog's `/batch/` endpoint
 * (DOR-317). Mirrors {@link forwardToPostHog} but reads the feedback envelope,
 * which keeps `dorkosVersion` in `properties` (optional) rather than the wire
 * envelope. The volunteered `message`/`contact` ride along in `properties` on
 * purpose — this is content the user chose to send. No-op when
 * `POSTHOG_PROJECT_KEY` is unset; errors are swallowed (always-200 posture).
 */
async function forwardFeedbackToPostHog(events: FeedbackEvent[]): Promise<void> {
  const apiKey = env.POSTHOG_PROJECT_KEY;
  if (!apiKey) return; // Unconfigured deploy: accept, forward nothing.

  const url = `${env.NEXT_PUBLIC_POSTHOG_HOST.replace(/\/+$/, '')}/batch/`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        historical_migration: false,
        batch: events.map((e) => ({
          event: e.event,
          distinct_id: e.distinctId,
          timestamp: e.timestamp,
          properties: {
            ...e.properties,
            // Marks these as owned-ingest events (vs the site's browser SDK).
            $lib: 'dorkos-owned-ingest',
          },
        })),
      }),
    });
  } catch (error) {
    console.error('[api/telemetry/events] PostHog feedback forward failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

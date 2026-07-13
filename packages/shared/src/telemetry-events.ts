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

// ============================================================================
// Feedback events (user-volunteered) — DOR-317, ADR 260713-143958 Phase 5
// ============================================================================
//
// Feedback is a MESSAGE a person deliberately writes and presses Send on — not
// passive telemetry. That deliberate act is itself the consent, so feedback is
// governed differently from the Tier 1 usage events above:
//
//   - It BYPASSES the `telemetry.usage` config channel, the Tier 1 first-run
//     notice gate, AND the `DO_NOT_TRACK` / `DORKOS_TELEMETRY_DISABLED` env kill
//     switches. Those controls govern *tracking* — data collected about a user
//     as a side effect of using the app. A person who types a bug report and
//     clicks Send has asked us to receive it; honoring DO_NOT_TRACK by silently
//     dropping their message would be a bug, not a privacy win. (The server-side
//     `feedback-reporter` therefore does no consent resolution at all — see
//     `apps/server/src/services/core/feedback-reporter.ts`.)
//
//   - The no-PII invariant that governs the usage events above DOES NOT apply to
//     the volunteered fields here. `message` and `contact` are user-typed and
//     deliberately submitted, so they are the ONLY free-text this registry
//     permits. Every usage event stays a strict allowlist of enums/counts; only
//     feedback carries prose, and only because the user chose to send it. The
//     registry tests assert exactly this split.
//
// These events still ride the SAME owned ingest (`/api/telemetry/events`); they
// simply reach it through their own path (Transport.sendFeedback → server
// feedback-reporter, or the site form posting from the browser) rather than the
// buffered usage-reporter. The ingest's route-local mirror carries a matching
// delimited section.

/**
 * Maximum length of a feedback `message`. Generous (a few paragraphs) because
 * this is deliberately-submitted prose, but still bounded so a single request
 * can never carry an unbounded payload.
 */
export const MAX_FEEDBACK_MESSAGE_LEN = 4000;

/** Maximum length of an optional `contact` string (fits any real email/handle). */
export const MAX_FEEDBACK_CONTACT_LEN = 254;

/** Maximum length of the optional `route` context prop (e.g. `/agents`). */
export const MAX_FEEDBACK_ROUTE_LEN = 256;

/**
 * The kind of feedback a `feedback_submitted` event carries. `idea` is modeled
 * separately as {@link FeatureRequestedProperties} (the `feature_requested`
 * event), so this enum covers only the two non-idea kinds.
 */
export const FEEDBACK_KINDS = ['feedback', 'bug'] as const;

/** One of the {@link FEEDBACK_KINDS}. */
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

/**
 * Properties for `feedback_submitted`: a person volunteered general feedback or
 * a bug report. `message` (and optional `contact`) are the ONLY free-text this
 * registry allows — deliberately submitted content, exempt from the no-PII
 * allowlist that governs the usage events above. `surface` says where the form
 * lived; `route`/`dorkosVersion` are best-effort context (absent from the site).
 */
export const FeedbackSubmittedProperties = z
  .object({
    kind: z.enum(FEEDBACK_KINDS),
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_FEEDBACK_CONTACT_LEN).optional(),
    surface: z.enum(['cockpit', 'site']),
    route: z.string().min(1).max(MAX_FEEDBACK_ROUTE_LEN).optional(),
    dorkosVersion: z.string().min(1).max(MAX_STRING_LEN).optional(),
  })
  .strict();

/**
 * Properties for `feature_requested`: the same shape as
 * {@link FeedbackSubmittedProperties} minus `kind` (the event name already says
 * this is a feature idea). `message`/`contact` carry the same volunteered-text
 * exemption.
 */
export const FeatureRequestedProperties = z
  .object({
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_FEEDBACK_CONTACT_LEN).optional(),
    surface: z.enum(['cockpit', 'site']),
    route: z.string().min(1).max(MAX_FEEDBACK_ROUTE_LEN).optional(),
    dorkosVersion: z.string().min(1).max(MAX_STRING_LEN).optional(),
  })
  .strict();

/** The feedback event names. */
export const FEEDBACK_EVENT_NAMES = ['feedback_submitted', 'feature_requested'] as const;

/** One of the {@link FEEDBACK_EVENT_NAMES}. */
export type FeedbackEventName = (typeof FEEDBACK_EVENT_NAMES)[number];

/**
 * The feedback event envelope. Lighter than the usage {@link envelopeFields} on
 * purpose: `dorkosVersion` lives in `properties` (optional — the site has none),
 * and `distinctId` is a lenient pseudonymous id rather than a strict install
 * UUID, because the site form uses PostHog's own distinct id (or a random UUID)
 * while the cockpit uses the anonymous `instanceId`.
 */
const feedbackEnvelopeFields = {
  distinctId: z.string().min(1).max(200),
  timestamp: z.string().datetime(),
};

/**
 * A single fully-enveloped feedback event, discriminated on `event`. Strict at
 * both levels. Kept separate from {@link TelemetryEventSchema} so the free-text
 * exemption is isolated to feedback and the usage catalog stays allowlist-only.
 */
export const FeedbackEventSchema = z.discriminatedUnion('event', [
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

/** A single fully-enveloped, registry-validated feedback event. */
export type FeedbackEvent = z.infer<typeof FeedbackEventSchema>;

/**
 * The client→server feedback submission payload: what a cockpit form hands to
 * {@link import('./transport.js').Transport.sendFeedback} (and what the server
 * `POST /api/feedback` route validates). The server fills the rest — `surface`,
 * `distinctId`, `timestamp`, `dorkosVersion` — so a producer only ever describes
 * *what the person wrote*.
 *
 * `kind` here includes `idea` (which maps to a `feature_requested` event); the
 * two non-idea kinds map to `feedback_submitted`.
 */
export const FeedbackSubmissionSchema = z
  .object({
    kind: z.enum(['feedback', 'bug', 'idea']),
    message: z.string().min(1).max(MAX_FEEDBACK_MESSAGE_LEN),
    contact: z.string().min(1).max(MAX_FEEDBACK_CONTACT_LEN).optional(),
    route: z.string().min(1).max(MAX_FEEDBACK_ROUTE_LEN).optional(),
  })
  .strict();

/** The `{ kind, message, contact?, route? }` half a client submits. */
export type FeedbackSubmission = z.infer<typeof FeedbackSubmissionSchema>;

/** The kind selectable in a feedback form: the two feedback kinds plus `idea`. */
export type FeedbackSubmissionKind = FeedbackSubmission['kind'];

/** Envelope context the sender fills in around a {@link FeedbackSubmission}. */
export interface FeedbackEventContext {
  /** Where the form lived. */
  surface: 'cockpit' | 'site';
  /** Pseudonymous sender id: the app `instanceId`, or a site distinct id/UUID. */
  distinctId: string;
  /** ISO-8601 instant the feedback was submitted. */
  timestamp: string;
  /** Emitting DorkOS build, when known (the cockpit has one; the site does not). */
  dorkosVersion?: string;
}

/**
 * Build a fully-enveloped {@link FeedbackEvent} from a submission plus its
 * context. The single place the `kind → event name` mapping lives, shared by
 * the server feedback-reporter and the in-process (Obsidian) sender so both wire
 * the same shape: `idea` → `feature_requested`; `feedback`/`bug` →
 * `feedback_submitted` (carrying `kind`).
 *
 * The result is NOT validated here (callers that need a guarantee run it through
 * {@link FeedbackEventSchema}); this is a pure shape builder.
 *
 * @param submission - The user-typed `{ kind, message, contact?, route? }`.
 * @param context - The `surface`/`distinctId`/`timestamp`/`dorkosVersion` envelope.
 */
export function buildFeedbackEvent(
  submission: FeedbackSubmission,
  context: FeedbackEventContext
): FeedbackEvent {
  const { kind, message, contact, route } = submission;
  const { surface, distinctId, timestamp, dorkosVersion } = context;

  // Only include optional props when present so the strict schema is satisfied
  // (an explicit `undefined` key would still fail `.strict()` on some paths).
  const shared = {
    message,
    surface,
    ...(contact ? { contact } : {}),
    ...(route ? { route } : {}),
    ...(dorkosVersion ? { dorkosVersion } : {}),
  };

  if (kind === 'idea') {
    return {
      event: 'feature_requested',
      properties: shared,
      distinctId,
      timestamp,
    };
  }
  return {
    event: 'feedback_submitted',
    properties: { kind, ...shared },
    distinctId,
    timestamp,
  };
}

// ===========================================================================
// Exception events (crash reporting) — ADR 260713-143958 Phase 6, DOR-318
//
// A DOCUMENTED CARVE-OUT from the `[object]_[verb]` convention above: the
// PostHog-native `$exception` event. Its `$`-prefixed name and property keys
// (`$exception_list`, `$exception_level`, `$process_person_profile`) are what
// PostHog Error Tracking expects on the wire, so we mirror that shape verbatim
// rather than renaming it into our convention. These events ride the SAME owned
// ingest and envelope as the Tier 1 usage events above, but are gated by the
// separate Tier 2 error-reporting opt-in (`telemetry.errorReporting`), not the
// Tier 1 notice gate. The scrubbed payload is built by `@dorkos/shared/
// error-report` (`buildExceptionEvent`); this section is only the wire schema.
// Kept self-contained so it validates independently of the usage union.
// ===========================================================================

/** Max stack-frame filename / function length (repo-relative paths can exceed the 64-char cap). */
const MAX_FRAME_STRING_LEN = 1024;

/** Max stack depth accepted in one `$exception` (bounds an adversarial payload). */
const MAX_STACK_FRAMES = 200;

/**
 * One scrubbed stack frame in PostHog's `raw` stacktrace shape: structural
 * location only — never source lines, never locals, never an absolute path. The
 * scrubber in `error-report.ts` guarantees `filename` is repo-relative.
 */
const ExceptionStackFrameSchema = z
  .object({
    /** Frame language/platform tag, e.g. `node:javascript` or `web:javascript`. */
    platform: z.string().min(1).max(MAX_STRING_LEN),
    /** Repo-relative filename (never absolute, never a home dir). */
    filename: z.string().max(MAX_FRAME_STRING_LEN),
    /** Function name, or `<anonymous>`. */
    function: z.string().max(MAX_FRAME_STRING_LEN),
    lineno: z.number().int().min(0).optional(),
    colno: z.number().int().min(0).optional(),
    /** Whether the frame is DorkOS/app code (vs a dependency under node_modules). */
    in_app: z.boolean(),
  })
  .strict();

/** One exception in `$exception_list`: type + (always-empty) value + a raw stacktrace. */
const ExceptionValueSchema = z
  .object({
    /** The scrubbed error type (e.g. `TypeError`). */
    type: z.string().max(MAX_FRAME_STRING_LEN),
    /** Always the empty string — the raw message is never sent (see buildErrorEvent). */
    value: z.string().max(MAX_STRING_LEN),
    /** PostHog exception mechanism metadata. */
    mechanism: z.object({ handled: z.boolean(), synthetic: z.boolean() }).strict(),
    /** The raw (pre-scrubbed, no source-map) stacktrace. */
    stacktrace: z
      .object({
        type: z.literal('raw'),
        frames: z.array(ExceptionStackFrameSchema).max(MAX_STACK_FRAMES),
      })
      .strict(),
  })
  .strict();

/**
 * Strict allowlist of a `$exception` event's properties. `$process_person_profile`
 * is pinned `false` so crash events never create a PostHog person (anonymous by
 * construction); `surface`/`release`/`environment`/`os` mirror the old
 * `ErrorEvent` fields so crashes stay filterable.
 */
export const ExceptionEventPropertiesSchema = z
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

/** The `$exception` event property bag (built by `error-report.ts`'s mapper). */
export type ExceptionEventProperties = z.infer<typeof ExceptionEventPropertiesSchema>;

/**
 * A single fully-enveloped `$exception` event — the crash-report wire shape.
 * Shares {@link envelopeFields} (`distinctId`/`timestamp`/`dorkosVersion`) with
 * the usage events, so it POSTs to the same `/api/telemetry/events` batch
 * endpoint; the site route validates it against a route-local mirror of this
 * schema and forwards it to PostHog Error Tracking.
 */
export const ExceptionEventSchema = z
  .object({
    event: z.literal('$exception'),
    properties: ExceptionEventPropertiesSchema,
    ...envelopeFields,
  })
  .strict();

/** A registry-validated, fully-enveloped `$exception` crash event. */
export type ExceptionEvent = z.infer<typeof ExceptionEventSchema>;

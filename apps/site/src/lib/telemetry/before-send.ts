/**
 * The PostHog `before_send` hook for dorkos.ai (DOR-4992).
 *
 * `/privacy` says the site does not log what you type. Two things PostHog
 * sends on its own would break that, so every event passes through
 * {@link scrubAnalyticsEvent} on its way out:
 *
 * - **Page URLs.** Every event carries the page's URL (`$current_url`, and the
 *   first one a visitor landed on in `$initial_current_url`), and the URL can
 *   carry a search, like `/marketplace?q=…`. Each URL property keeps only the
 *   two catalog filters (`type`, `category`) and loses the rest of its query
 *   string and its hash. Campaign tags survive: PostHog records them as their
 *   own `utm_*` properties before this hook runs.
 * - **Error text.** PostHog Error Tracking captures uncaught errors itself
 *   (`capture_exceptions` in `instrumentation-client.ts`) as well as the ones
 *   the error boundaries hand it. Each `$exception` leaves with its message
 *   emptied, the fields that repeat it dropped, and the query strings taken
 *   off its stack frames' URLs (an inline script's frame names the page URL).
 *
 * @module lib/telemetry/before-send
 */
import type { CaptureResult } from 'posthog-js';

/** The query parameters a URL property may keep: the catalog's own filters. */
const KEPT_PARAMS = ['type', 'category'] as const;

/** Event properties that hold a URL PostHog read from the browser. */
const URL_PROPERTIES = [
  '$current_url',
  '$referrer',
  '$initial_current_url',
  '$initial_referrer',
  '$pathname',
  '$initial_pathname',
] as const;

/** Fields PostHog may put on an `$exception` that carry message text. */
const MESSAGE_FIELDS = ['$exception_message', '$exception_values', '$exception_steps'] as const;

/** Stack frame fields that hold a script URL. */
const FRAME_URL_FIELDS = ['filename', 'abs_path'] as const;

/** A throwaway origin so a bare path still parses as a URL. */
const PATH_BASE = 'https://path.invalid';

/**
 * Cut a URL down to what analytics may keep: no hash, and no query parameter
 * except `type` and `category`. Anything that is not a string, or carries no
 * `?` or `#`, comes back as it was. A value that does not parse loses
 * everything from its first `?` or `#`.
 *
 * @param value - A URL, a path, or anything else PostHog put in a URL field.
 */
export function scrubUrl(value: unknown): unknown {
  if (typeof value !== 'string' || !/[?#]/.test(value)) return value;
  const isPath = value.startsWith('/');
  let url: URL;
  try {
    url = new URL(value, isPath ? PATH_BASE : undefined);
  } catch {
    return value.replace(/[?#][\s\S]*$/, '');
  }
  const kept = new URLSearchParams();
  for (const key of KEPT_PARAMS) {
    const v = url.searchParams.get(key);
    if (v !== null) kept.set(key, v);
  }
  const query = kept.toString();
  const base = isPath ? url.pathname : `${url.origin}${url.pathname}`;
  return query ? `${base}?${query}` : base;
}

/** Scrub every URL property in one property bag (top level, `$set`, `$set_once`). */
function scrubUrlProperties(bag: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...bag };
  for (const key of URL_PROPERTIES) {
    if (key in out) out[key] = scrubUrl(out[key]);
  }
  const info = out.$initial_person_info;
  if (info && typeof info === 'object') {
    const { u, r, ...rest } = info as { u?: unknown; r?: unknown };
    out.$initial_person_info = { ...rest, u: scrubUrl(u), r: scrubUrl(r) };
  }
  return out;
}

/** Strip the query and hash off a stack frame's script URL fields. */
function scrubFrame(frame: unknown): unknown {
  if (!frame || typeof frame !== 'object') return frame;
  const out: Record<string, unknown> = { ...(frame as Record<string, unknown>) };
  for (const key of FRAME_URL_FIELDS) {
    if (typeof out[key] === 'string') out[key] = (out[key] as string).replace(/[?#][\s\S]*$/, '');
  }
  return out;
}

/** Empty one `$exception_list` entry's message and clean its frames. */
function scrubException(entry: unknown): unknown {
  if (!entry || typeof entry !== 'object') return entry;
  const out: Record<string, unknown> = { ...(entry as Record<string, unknown>), value: '' };
  const stacktrace = out.stacktrace as { frames?: unknown } | undefined;
  if (stacktrace && typeof stacktrace === 'object' && Array.isArray(stacktrace.frames)) {
    out.stacktrace = { ...stacktrace, frames: stacktrace.frames.map(scrubFrame) };
  }
  return out;
}

/**
 * PostHog `before_send` hook: scrub page URLs on every event, and error text
 * on every `$exception`, keeping the type, level and frames Error Tracking
 * groups on. A `null` (an event an earlier hook dropped) passes through.
 *
 * @param event - The event PostHog is about to send.
 */
export function scrubAnalyticsEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event) return event;
  let properties = scrubUrlProperties({ ...event.properties });
  for (const key of ['$set', '$set_once'] as const) {
    const bag = properties[key];
    if (bag && typeof bag === 'object') {
      properties[key] = scrubUrlProperties(bag as Record<string, unknown>);
    }
  }
  if (event.event === '$exception') {
    for (const field of MESSAGE_FIELDS) delete properties[field];
    const list = properties.$exception_list;
    if (Array.isArray(list))
      properties = { ...properties, $exception_list: list.map(scrubException) };
  }
  const scrubbed: CaptureResult = { ...event, properties };
  if (event.$set) scrubbed.$set = scrubUrlProperties(event.$set);
  if (event.$set_once) scrubbed.$set_once = scrubUrlProperties(event.$set_once);
  return scrubbed;
}

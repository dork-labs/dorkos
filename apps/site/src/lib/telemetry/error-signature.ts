/**
 * Keep error text out of the site's analytics (DOR-4992).
 *
 * An error message can hold anything the page had in hand when it broke,
 * including words a visitor typed, and `/privacy` says the site does not log
 * what you type. Two seams keep that true:
 *
 * - {@link errorSignature} names an error for a custom event by its type and
 *   the first stack frame, with no message text.
 * - {@link scrubExceptionEvent} is the PostHog `before_send` hook. PostHog
 *   Error Tracking captures uncaught errors on its own (`capture_exceptions`
 *   in `instrumentation-client.ts`) as well as the ones the error boundaries
 *   hand it, so the message has to come off on the send path, where every
 *   `$exception` passes, rather than at each call site.
 *
 * @module lib/telemetry/error-signature
 */
import type { CaptureResult } from 'posthog-js';

/** The longest error type kept; a real one is a class name. */
const MAX_NAME_LENGTH = 64;
/** The longest frame kept. */
const MAX_FRAME_LENGTH = 240;
/** The shortest message cut out of a frame that repeats it. */
const MIN_MESSAGE_TO_CUT = 4;

/** A V8 frame (`at fn (url:1:2)`) or a Firefox/Safari one (`fn@url:1:2`). */
const FRAME_PATTERN = /^at\s|@\S*:\d+(?::\d+)?$/;

/**
 * A query string or hash inside a frame's URL, up to the `:line:col` that ends
 * it. A frame from an inline script names the page URL, and the page URL can
 * carry a search.
 */
const URL_QUERY_PATTERN = /[?#][^\s()]*?(?=:\d+(?::\d+)?\)?$)/;

/**
 * Name an error by its type and the first frame of its stack, never its
 * message. The frame is read from after the message, so a message that spans
 * lines never reaches the result, and a frame that repeats the message has it
 * cut out.
 *
 * @param error - The error to name.
 * @returns e.g. `TypeError at renderGrid (https://dorkos.ai/_next/static/chunks/app.js:1:234)`,
 *   or just the type when the stack has no frame.
 */
export function errorSignature(error: Error): string {
  const name = (error.name || 'Error').slice(0, MAX_NAME_LENGTH);
  const message = typeof error.message === 'string' ? error.message : '';
  let stack = typeof error.stack === 'string' ? error.stack : '';
  // V8 opens the stack with `Name: message`, which can span lines; read only
  // what comes after it. Firefox and Safari start straight at the frames.
  if (message) {
    const at = stack.indexOf(message);
    if (at >= 0) stack = stack.slice(at + message.length);
  }
  let frame = stack
    .split('\n')
    .map((line) => line.trim())
    .find((line) => FRAME_PATTERN.test(line));
  if (!frame) return name;
  // A frame can repeat the message, e.g. an eval'd function named after it.
  // Too short a message is not worth cutting out: it would only mangle a frame.
  if (message.length >= MIN_MESSAGE_TO_CUT) frame = frame.split(message).join('');
  return `${name} ${frame.replace(URL_QUERY_PATTERN, '').slice(0, MAX_FRAME_LENGTH)}`;
}

/** Fields PostHog may put on an `$exception` that carry message text. */
const MESSAGE_FIELDS = ['$exception_message', '$exception_values', '$exception_steps'] as const;

/**
 * PostHog `before_send` hook: empty every exception's message and drop the
 * fields that repeat it, keeping the type, level and stack frames that Error
 * Tracking groups on. Every other event passes through untouched.
 *
 * @param event - The event PostHog is about to send, or `null` when an earlier
 *   hook dropped it.
 */
export function scrubExceptionEvent(event: CaptureResult | null): CaptureResult | null {
  if (!event || event.event !== '$exception') return event;
  const properties: Record<string, unknown> = { ...event.properties };
  for (const field of MESSAGE_FIELDS) delete properties[field];
  const list = properties.$exception_list;
  if (Array.isArray(list)) {
    properties.$exception_list = list.map((entry: unknown) =>
      entry && typeof entry === 'object' ? { ...entry, value: '' } : entry
    );
  }
  return { ...event, properties };
}

/**
 * Name an error for analytics without its text (DOR-4992).
 *
 * An error message can hold anything the page had in hand when it broke,
 * including words a visitor typed, and `/privacy` says the site does not log
 * what you type. {@link errorSignature} names an error for the site's custom
 * error events by its type and its first stack frame instead. The PostHog
 * Error Tracking copy of the same error is scrubbed on the send path, in
 * `lib/telemetry/before-send.ts`.
 *
 * @module lib/telemetry/error-signature
 */

/** The longest error type kept; a real one is a class name. */
const MAX_NAME_LENGTH = 64;
/** The longest frame kept. */
const MAX_FRAME_LENGTH = 240;
/** The shortest message cut out of a frame that repeats it. */
const MIN_MESSAGE_TO_CUT = 4;

/** What an error type looks like: an identifier, like `TypeError`. */
const NAME_PATTERN = /^[A-Za-z_$][\w$]*$/;
/** A V8 frame line: indented, then `at `. Anything before the first one is message. */
const V8_FRAME = /^\s+at\s/;
/**
 * A Firefox or Safari frame line: `fn@<path or URL>:line:col`, where the
 * location has a slash or a file extension. A line of message text that only
 * happens to contain an `@` does not match.
 */
const OTHER_FRAME = /@[^\s@]*(?:\/|\.[A-Za-z]\w*)[^\s@]*:\d+:\d+$/;
/** A query string or hash inside a frame's URL, up to the `:line` that follows it. */
const URL_QUERY = /[?#][^\s():]*(?=:\d+)/g;
/**
 * The same, for a query that itself holds a `:`: everything from `?` or `#`
 * up to the `:line:col` that ends the frame.
 */
const TRAILING_URL_QUERY = /[?#][^\s()]*?(?=:\d+(?::\d+)?\)?$)/;

/** The first stack frame, or `undefined` when the stack has none we trust. */
function firstFrame(stack: string): string | undefined {
  const lines = stack.split('\n');
  // V8: the message runs until the first indented `at ` line, whatever it says.
  const v8 = lines.find((line) => V8_FRAME.test(line));
  if (v8) return v8.trim();
  return lines.map((line) => line.trim()).find((line) => OTHER_FRAME.test(line));
}

/**
 * Name an error by its type and the first frame of its stack, never its
 * message. In a V8 stack everything before the first indented `at ` line is
 * treated as message, even after the message was changed; in a Firefox or
 * Safari stack only a line naming a script location counts as a frame. A
 * frame that repeats the message has it cut out, and every frame URL loses
 * its query string and hash.
 *
 * @param error - The error to name.
 * @returns e.g. `TypeError at renderGrid (https://dorkos.ai/_next/static/chunks/app.js:1:234)`,
 *   or just the type when the stack has no frame.
 */
export function errorSignature(error: Error): string {
  const rawName = typeof error.name === 'string' ? error.name : '';
  const name = NAME_PATTERN.test(rawName) ? rawName.slice(0, MAX_NAME_LENGTH) : 'Error';
  const message = typeof error.message === 'string' ? error.message : '';
  let stack = typeof error.stack === 'string' ? error.stack : '';
  // Skip a V8 header that still matches the message exactly.
  const header = `${rawName}: ${message}`;
  if (message && stack.startsWith(header)) stack = stack.slice(header.length);
  let frame = firstFrame(stack);
  if (!frame) return name;
  // A frame can repeat the message, e.g. an eval'd function named after it.
  // Too short a message is not worth cutting out: it would only mangle a frame.
  if (message.length >= MIN_MESSAGE_TO_CUT) frame = frame.split(message).join('');
  frame = frame.replace(URL_QUERY, '').replace(TRAILING_URL_QUERY, '');
  return `${name} ${frame.slice(0, MAX_FRAME_LENGTH)}`;
}

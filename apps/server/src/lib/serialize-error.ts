/**
 * Turn log context into something JSON can actually carry, Errors included.
 *
 * `{ ...new Error('boom') }` is `{}` and `JSON.stringify(new Error('boom'))` is
 * `{}` too: `message` and `stack` are own properties but NOT enumerable, so
 * every path that spreads or stringifies an error silently drops the only two
 * fields worth reading. The NDJSON file reporter did exactly that, which is why
 * incidents landed in `~/.dork/logs/dorkos.log` as a bare message prefix with no
 * reason attached (DOR-802). An errno error survived by luck — `errno`, `code`,
 * `syscall` and `path` ARE enumerable — and everything else survived not at all.
 *
 * Fixing it here rather than at the call sites means every present and future
 * `logger.error(msg, err)` and `logger.error(msg, { err })` is covered without
 * anyone remembering to wrap.
 *
 * Two consumers share the walk and the size bounds below, because a runaway
 * error is a runaway on either destination:
 *
 * - {@link normalizeLogContext} — the NDJSON file reporter, which needs Errors
 *   turned into plain JSON-able objects.
 * - {@link clipLogArgs} — the console reporter, which needs Errors left as
 *   Errors so consola still renders them as errors, and only wants them cut
 *   down to size (DOR-1728).
 *
 * @module lib/serialize-error
 */

/**
 * How far the walk descends before it stops.
 *
 * One budget covers both directions of nesting — links in a `cause` chain and
 * levels of a context object — because a runaway is a runaway either way. At the
 * limit an Error collapses to its `Name: message` summary, so the reason
 * survives even where the structure does not.
 */
const MAX_DEPTH = 5;

/**
 * Longest `message` and `stack` written before they are clipped.
 *
 * A log line is a whole line: the reporter appends it in one write, rotation is
 * only checked at startup, and `log-excerpt.ts` reads whole files back for bug
 * reports. So one error carrying a megabyte-long message — a subprocess dump, a
 * stringified response body — would bloat the file and every reader of it. These
 * caps are far above any real stack (a deep Node stack is a few KB) and far
 * below the size where one line becomes a problem.
 */
const MAX_MESSAGE_LEN = 4 * 1024;
/** See {@link MAX_MESSAGE_LEN}. Stacks are legitimately longer than messages. */
const MAX_STACK_LEN = 16 * 1024;

/**
 * Clip an over-long string, naming its true size rather than trailing off silently.
 *
 * The marker carries the WHOLE length, not the dropped remainder: a reader who
 * hits it wants to know what they are dealing with — a 5 KB message they can
 * probably find in full elsewhere, or a 2 MB subprocess dump they cannot — and
 * making them add the cap back on to find out is a puzzle with no payoff.
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated, ${value.length} characters total]`;
}

/**
 * Where a V8 stack stops being the message and starts being the frames.
 *
 * A stack is `Name: message` followed by `\n    at …` lines, and the message is
 * embedded verbatim — newlines and all. So a megabyte-long message produces a
 * megabyte-long stack, and a flat clip of that stack returns a megabyte of
 * message and NOT ONE FRAME, which is the half an operator acts on.
 */
const STACK_FRAMES_PATTERN = /\n\s+at /;

/**
 * Clip a stack, budgeting the message header and the frames separately.
 *
 * The header gets {@link MAX_MESSAGE_LEN} — the same allowance the message
 * itself gets, since it is the same text — and the frames get whatever is left
 * of {@link MAX_STACK_LEN}, so both survive an error whose message is enormous.
 * A stack with no recognisable frames (a non-V8 shape, or a message that ate
 * them) falls back to the flat clip; it is still bounded, just less useful.
 */
function clipStack(stack: string): string {
  if (stack.length <= MAX_STACK_LEN) return stack;

  const framesAt = stack.search(STACK_FRAMES_PATTERN);
  if (framesAt === -1) return clip(stack, MAX_STACK_LEN);

  const header = clip(stack.slice(0, framesAt), MAX_MESSAGE_LEN);
  return header + clip(stack.slice(framesAt), Math.max(0, MAX_STACK_LEN - header.length));
}

/** A plain `{}` object, as opposed to a class instance, array, or null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * What a walk does when it reaches an Error.
 *
 * The two destinations want opposite things from the same traversal — the file
 * wants JSON, the terminal wants an Error it can still format — so the walk is
 * shared and only this step differs.
 */
type ErrorStep = (err: Error, depth: number) => unknown;

/**
 * Serialize one Error into a plain object, following its `cause` chain.
 *
 * Own enumerable properties are kept — that is where `errno`/`code`/`syscall`
 * live, and existing log readers already depend on them — and the authoritative
 * `name`/`message`/`stack` are written last so a stray own property of the same
 * name cannot displace them.
 *
 * `cause` and an `AggregateError`'s `errors` are pulled out by hand for the same
 * reason `message` and `stack` are: both are own but NOT enumerable, so both
 * vanish from a spread. An `AggregateError` that lost its `errors` is precisely
 * the reason-less line this module exists to prevent — every sub-error is where
 * the reason lives.
 */
function serializeError(err: Error, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(err)) {
    out[key] = walkValue(value, depth + 1, serializeStep);
  }

  const cause: unknown = (err as { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = walkValue(cause, depth + 1, serializeStep);

  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    out.errors = (err.errors as unknown[]).map((sub) => walkValue(sub, depth + 1, serializeStep));
  }

  out.name = err.name;
  out.message = clip(err.message, MAX_MESSAGE_LEN);
  if (err.stack !== undefined) out.stack = clipStack(err.stack);
  return out;
}

/** The NDJSON step: an Error becomes a plain object, or its summary at the depth limit. */
const serializeStep: ErrorStep = (err, depth) => {
  // Out of budget: keep the reason, drop the structure.
  if (depth >= MAX_DEPTH) return `${err.name}: ${clip(err.message, MAX_MESSAGE_LEN)}`;
  return serializeError(err, depth);
};

/** Define a property the way an Error carries `message`/`stack`/`cause`: own, but hidden. */
function defineHidden(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

/**
 * Copy one Error with its oversized parts cut down, and nothing else changed.
 *
 * The result is a real instance of the original's class, so `instanceof Error`
 * still holds and consola's reporter still takes its error-formatting path —
 * colours, indented frames, `[cause]:` chains and all. Own enumerable
 * properties (`errno`, `code`, a subclass's assigned `name`) are copied as they
 * were; `message`, `stack`, `cause` and `errors` are redefined hidden, which is
 * where an Error keeps them and where every formatter looks.
 *
 * The original comes back by identity when nothing needed clipping, so the
 * overwhelmingly common case — an ordinary error, well under the bounds —
 * prints byte-for-byte as it always did.
 */
function clipError(err: Error, depth: number): Error {
  const message = clip(err.message, MAX_MESSAGE_LEN);
  const stack = err.stack === undefined ? undefined : clipStack(err.stack);

  let changed = message !== err.message || stack !== err.stack;

  const cause: unknown = (err as { cause?: unknown }).cause;
  const clippedCause = cause === undefined ? undefined : walkValue(cause, depth + 1, clipStep);
  if (clippedCause !== cause) changed = true;

  let subErrors: unknown[] | undefined;
  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    const sources = err.errors as unknown[];
    subErrors = sources.map((sub) => walkValue(sub, depth + 1, clipStep));
    if (subErrors.some((sub, i) => sub !== sources[i])) changed = true;
  }

  const clippedOwn = Object.entries(err).map(([key, value]) => {
    const next = walkValue(value, depth + 1, clipStep);
    if (next !== value) changed = true;
    return [key, next] as const;
  });

  if (!changed) return err;

  const clone = Object.create(Object.getPrototypeOf(err) as object) as Record<string, unknown>;
  for (const [key, value] of clippedOwn) clone[key] = value;
  defineHidden(clone, 'message', message);
  if (stack !== undefined) defineHidden(clone, 'stack', stack);
  if (clippedCause !== undefined) defineHidden(clone, 'cause', clippedCause);
  if (subErrors !== undefined) defineHidden(clone, 'errors', subErrors);
  return clone as unknown as Error;
}

/** The console step: an Error stays an Error, just a smaller one. */
const clipStep: ErrorStep = (err, depth) => {
  // Out of budget: keep the reason, drop the structure — the same place the
  // NDJSON walk stops, so neither destination descends further than the other.
  if (depth >= MAX_DEPTH) return `${err.name}: ${clip(err.message, MAX_MESSAGE_LEN)}`;
  return clipError(err, depth);
};

/**
 * Walk a single log value, applying `onError` to every Error it finds or contains.
 *
 * Values that need no change come back by identity, so a line whose context
 * holds nothing oversized and no Error is emitted byte-for-byte as it was.
 */
function walkValue(value: unknown, depth: number, onError: ErrorStep): unknown {
  if (value instanceof Error) return onError(value, depth);
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = walkValue(item, depth + 1, onError);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }

  if (isPlainObject(value)) return walkObject(value, depth + 1, onError);

  return value;
}

/** Walk every value of a plain object, returning the original if nothing moved. */
function walkObject(
  obj: Record<string, unknown>,
  depth: number,
  onError: ErrorStep
): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const next = walkValue(value, depth, onError);
    if (next !== value) changed = true;
    out[key] = next;
  }
  return changed ? out : obj;
}

/**
 * Prepare a log call's context object for the NDJSON line.
 *
 * The reporter spreads the result into the line, so the two shapes callers
 * actually write both come out readable:
 *
 * - `logger.error(msg, err)` — the Error IS the context, and flattens onto the
 *   line as `error` (its message, matching what the `logError` helper has always
 *   written), plus `stack`, `name`, `cause`, and its own enumerable fields. The
 *   message is written to `error` rather than `message` because a line's `msg`
 *   already carries the call site's own text; two near-identical keys would be a
 *   coin toss for whoever reads the line. `name` keeps the spelling the repo's
 *   Error subclasses already put on the line — they assign `this.name`, which is
 *   an own enumerable property and so was never part of the loss.
 * - `logger.error(msg, { err })` — the Error is a value inside the context and
 *   becomes a nested object with `name`, `message` and `stack`, wherever in the
 *   object it sits.
 *
 * @param context - The object argument of a log call.
 * @returns A JSON-safe object; the same reference when there was nothing to fix.
 */
export function normalizeLogContext(context: Record<string, unknown>): Record<string, unknown> {
  if (context instanceof Error) {
    const { message, ...rest } = serializeError(context, 0);
    return { ...rest, error: message };
  }
  return walkObject(context, 0, serializeStep);
}

/**
 * Prepare a log call's arguments for the terminal.
 *
 * The console reporter had no clipping at all until DOR-1728: consola's own
 * reporter formats whatever it is handed, so one error carrying a subprocess
 * dump printed the whole thing — megabytes down a terminal, and down a CI log,
 * where a single line that size cost one run ten minutes of serialization
 * (DOR-1726). This applies the SAME bounds the NDJSON file reporter applies, so
 * the two destinations agree on what is too big and say so identically.
 *
 * Unlike {@link normalizeLogContext}, Errors stay Errors. The reporter formats
 * an error very differently from a plain object — indented frames, `[cause]:`
 * chains, colour — and turning it into `{ name, message, stack }` to bound it
 * would cost dev ergonomics on every line to fix the rare huge one.
 *
 * @param args - The arguments of a log call, as consola assembled them.
 * @returns The same array when nothing was oversized; otherwise a copy in which
 *   only the oversized parts were replaced.
 */
export function clipLogArgs(args: unknown[]): unknown[] {
  let changed = false;
  const clipped = args.map((arg) => {
    // Mirrors normalizeLogContext's entry depth so a context object is walked
    // exactly as deep on its way to the terminal as on its way to the file.
    const next = isPlainObject(arg) ? walkObject(arg, 0, clipStep) : walkValue(arg, 0, clipStep);
    if (next !== arg) changed = true;
    return next;
  });
  return changed ? clipped : args;
}

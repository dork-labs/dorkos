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

/** Clip an over-long string, saying how much was dropped rather than trailing off silently. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated, ${value.length - max} more characters]`;
}

/** A plain `{}` object, as opposed to a class instance, array, or null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

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
    out[key] = normalizeValue(value, depth + 1);
  }

  const cause: unknown = (err as { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = normalizeValue(cause, depth + 1);

  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    out.errors = (err.errors as unknown[]).map((sub) => normalizeValue(sub, depth + 1));
  }

  out.name = err.name;
  out.message = clip(err.message, MAX_MESSAGE_LEN);
  if (err.stack !== undefined) out.stack = clip(err.stack, MAX_STACK_LEN);
  return out;
}

/**
 * Normalize a single context value, replacing any Error it finds or contains.
 *
 * Values that need no change come back by identity, so a line whose context
 * holds no Error is written byte-for-byte as it was before.
 */
function normalizeValue(value: unknown, depth: number): unknown {
  if (value instanceof Error) {
    // Out of budget: keep the reason, drop the structure.
    if (depth >= MAX_DEPTH) return `${value.name}: ${clip(value.message, MAX_MESSAGE_LEN)}`;
    return serializeError(value, depth);
  }
  if (depth >= MAX_DEPTH) return value;

  if (Array.isArray(value)) {
    let changed = false;
    const mapped = value.map((item) => {
      const next = normalizeValue(item, depth + 1);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? mapped : value;
  }

  if (isPlainObject(value)) return normalizeObject(value, depth + 1);

  return value;
}

/** Normalize every value of a plain object, returning the original if nothing moved. */
function normalizeObject(obj: Record<string, unknown>, depth: number): Record<string, unknown> {
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const next = normalizeValue(value, depth);
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
  return normalizeObject(context, 0);
}

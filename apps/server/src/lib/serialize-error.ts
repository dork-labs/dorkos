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
 * Three consumers share the size bounds below, because a runaway error is a
 * runaway on either destination:
 *
 * - {@link normalizeLogContext} — the NDJSON file reporter, which needs Errors
 *   turned into plain JSON-able objects.
 * - {@link clipLogArgs} — the console reporter, which needs Errors left as
 *   Errors so consola still renders them as errors, and only wants them cut
 *   down to size (DOR-1728).
 * - {@link clipFlattenedError} — the shared helper for a call site that
 *   flattens an error into strings BEFORE either walk runs, and so has to
 *   bound it itself (DOR-1827).
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
 * A frame line, for the fallback boundary only. See {@link clipStack}.
 */
const STACK_FRAMES_PATTERN = /\n\s+at /;

/**
 * Clip a stack, budgeting the message header and the frames separately.
 *
 * A stack is `Name: message` followed by `\n    at …` lines, with the message
 * embedded verbatim — newlines and all. So a megabyte-long message produces a
 * megabyte-long stack, and a flat clip of that stack returns a megabyte of
 * message and NOT ONE FRAME, which is the half an operator acts on. The header
 * gets {@link MAX_MESSAGE_LEN} — the same allowance the message itself gets,
 * since it is the same text — and the frames get whatever is left of
 * {@link MAX_STACK_LEN}, so both survive.
 *
 * The boundary is computed from the message the caller already holds, NOT by
 * looking for the first frame line, because the errors this exists for are
 * exactly the ones that defeat that search: a subprocess dump — `git clone`
 * stderr, a failed `npm install` — carries a child process's OWN stack inside
 * the message. Searching for `\n    at ` then lands on a QUOTED line, handing
 * the header ~60 bytes and spending the entire frame budget on the child's
 * frames, so not one real frame survives. `indexOf` places the boundary exactly.
 *
 * The search is kept only as a fallback for a stack that does not embed its
 * message (a non-V8 shape, or a reassigned `stack`), and a flat clip as the
 * fallback to that. Both are still bounded, just less useful.
 *
 * @param stack - The error's `stack`.
 * @param message - The error's `message`, used to find where the frames begin.
 */
function clipStack(stack: string, message: string): string {
  if (stack.length <= MAX_STACK_LEN) return stack;

  const framesAt = findFramesBoundary(stack, message);
  if (framesAt === -1) return clip(stack, MAX_STACK_LEN);

  const header = clip(stack.slice(0, framesAt), MAX_MESSAGE_LEN);
  return header + clip(stack.slice(framesAt), Math.max(0, MAX_STACK_LEN - header.length));
}

/** Where the message ends and the frames begin, or -1 when neither can be located. */
function findFramesBoundary(stack: string, message: string): number {
  if (message.length > 0) {
    const messageAt = stack.indexOf(message);
    if (messageAt !== -1) return messageAt + message.length;
  }
  return stack.search(STACK_FRAMES_PATTERN);
}

/** A plain `{}` object, as opposed to a class instance, array, or null. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** The short reason text for a thrown value. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** One own enumerable property, and whether reading it worked. */
type SafeEntry = readonly [key: string, value: unknown, readable: boolean];

/**
 * `Object.entries`, except one property that refuses to be read costs only itself.
 *
 * `Object.entries` invokes every getter in one go, so a single hostile property
 * throws before any of its siblings have been seen — and the caller's only
 * recourse is to abandon the whole object. That is a real loss here rather than
 * a tidiness point: abandoning the object means abandoning its CLIPPING, so one
 * unrelated throwing getter beside a two-megabyte error puts the whole two
 * megabytes back on the terminal. Reading key by key contains the damage to the
 * key that caused it, which is named in place instead.
 */
function safeEntries(obj: object): SafeEntry[] {
  const out: SafeEntry[] = [];
  for (const key of Object.keys(obj)) {
    try {
      out.push([key, (obj as Record<string, unknown>)[key], true]);
    } catch (err) {
      out.push([key, `[unreadable property: ${clip(reasonOf(err), MAX_MESSAGE_LEN)}]`, false]);
    }
  }
  return out;
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
  for (const [key, value, readable] of safeEntries(err)) {
    out[key] = readable ? walkValue(value, depth + 1, serializeStep) : value;
  }

  const cause: unknown = (err as { cause?: unknown }).cause;
  if (cause !== undefined) out.cause = walkValue(cause, depth + 1, serializeStep);

  if (err instanceof AggregateError && Array.isArray(err.errors)) {
    out.errors = (err.errors as unknown[]).map((sub) => walkValue(sub, depth + 1, serializeStep));
  }

  out.name = err.name;
  out.message = clip(err.message, MAX_MESSAGE_LEN);
  if (err.stack !== undefined) out.stack = clipStack(err.stack, err.message);
  return out;
}

/**
 * How far the marker below counts before it gives up and says "or more".
 *
 * The count exists to size the loss, not to be exhaustive, and the walk that
 * produced it already refused to follow this chain — so it must not be the
 * thing that follows it forever.
 */
const MAX_COUNTED_CAUSES = 100;

/**
 * Summarize an Error the walk refuses to descend into, saying that it did.
 *
 * The depth limit replaces an Error with its `Name: message` line, which on its
 * own reads exactly like the natural END of a `cause` chain — nothing tells the
 * reader that seven more links were dropped, and nothing distinguishes this
 * from an error that genuinely had no cause. The size cut has said what it
 * dropped since DOR-802; this one now does too.
 */
function summarizeAtDepthLimit(err: Error): string {
  const summary = `${err.name}: ${clip(err.message, MAX_MESSAGE_LEN)}`;

  // A cause chain can be cyclic, so this is bounded twice over.
  const seen = new Set<unknown>([err]);
  let remaining = 0;
  let next: unknown = (err as { cause?: unknown }).cause;
  while (next instanceof Error && !seen.has(next) && remaining < MAX_COUNTED_CAUSES) {
    seen.add(next);
    remaining++;
    next = (next as { cause?: unknown }).cause;
  }

  if (remaining === 0) return `${summary} … [truncated at depth ${MAX_DEPTH}]`;
  const count = remaining >= MAX_COUNTED_CAUSES ? `${MAX_COUNTED_CAUSES}+` : `${remaining}`;
  return `${summary} … [cause chain truncated at depth ${MAX_DEPTH}, ${count} more levels]`;
}

/** The NDJSON step: an Error becomes a plain object, or its summary at the depth limit. */
const serializeStep: ErrorStep = (err, depth) => {
  // Out of budget: keep the reason, drop the structure.
  if (depth >= MAX_DEPTH) return summarizeAtDepthLimit(err);
  return serializeError(err, depth);
};

/**
 * Define an own property outright, rather than assigning it.
 *
 * Assignment consults the prototype chain, so `clone[key] = value` throws when
 * the original's class declares a getter-only accessor of that name — which is
 * the shape of half the Error subclasses that expose a computed `code` or
 * `status`. Defining the property never looks up the chain.
 */
function defineOwn(target: object, key: string, value: unknown, enumerable: boolean): void {
  Object.defineProperty(target, key, { value, enumerable, writable: true, configurable: true });
}

/** Define a property the way an Error carries `message`/`stack`/`cause`: own, but hidden. */
function defineHidden(target: object, key: string, value: unknown): void {
  defineOwn(target, key, value, false);
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
  const stack = err.stack === undefined ? undefined : clipStack(err.stack, err.message);

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

  const clippedOwn = safeEntries(err).map(([key, value, readable]) => {
    if (!readable) {
      changed = true;
      return [key, value] as const;
    }
    const next = walkValue(value, depth + 1, clipStep);
    if (next !== value) changed = true;
    return [key, next] as const;
  });

  if (!changed) return err;

  const clone = Object.create(Object.getPrototypeOf(err) as object) as object;
  for (const [key, value] of clippedOwn) defineOwn(clone, key, value, true);
  defineHidden(clone, 'message', message);
  if (stack !== undefined) defineHidden(clone, 'stack', stack);
  if (clippedCause !== undefined) defineHidden(clone, 'cause', clippedCause);
  if (subErrors !== undefined) defineHidden(clone, 'errors', subErrors);
  return clone as Error;
}

/** The console step: an Error stays an Error, just a smaller one. */
const clipStep: ErrorStep = (err, depth) => {
  // Out of budget: keep the reason, drop the structure — the same place the
  // NDJSON walk stops, so neither destination descends further than the other.
  if (depth >= MAX_DEPTH) return summarizeAtDepthLimit(err);
  return clipError(err, depth);
};

/**
 * Walk a single log value, applying `onError` to every Error it finds or contains.
 *
 * Values that need no change come back by identity, so a line whose context
 * holds nothing oversized and no Error is emitted byte-for-byte as it was.
 *
 * **A plain string is never clipped here, on purpose.** The bounds in this
 * module are error bounds: an error's `message` and `stack` have a known shape
 * and a known useful size, so cutting one at 4 KB loses nothing an operator
 * wanted. A string field does not — an operator who logs a request body, a
 * config dump or a diff is logging it precisely to read or `grep` it back, and
 * a cap that silently ate the tail would be a worse bug than the one this
 * module fixes. So the fix for a runaway error is applied where it can tell an
 * error from a payload — which includes {@link clipFlattenedError}, for a call
 * site that flattens an error into `message`/`stack` strings before this walk
 * ever sees it (DOR-1827). If a bare string ever does flood a log, bound THAT
 * call site; if it is really an error in disguise, hand over the Error itself.
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
  for (const [key, value, readable] of safeEntries(obj)) {
    if (!readable) {
      changed = true;
      out[key] = value;
      continue;
    }
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
 * That agreement covers every Error the logger is handed — as the context
 * argument, nested anywhere inside it, or already flattened to strings by
 * {@link clipFlattenedError}. What it does not cover is a bare string a call
 * site built itself: a hand-rolled `String(err)`, a hand-picked `err.message`
 * or `err.stack`, or a stringified response body logged as an ordinary field.
 * Nothing downstream can tell any of those from ordinary text, so bounding
 * them is the call site's job — and the way to get the bound for free is to
 * hand the Error over whole instead. The repo's two hand-flattened crash
 * handlers were converted to exactly that (`index.ts`, DOR-1827); ordinary
 * long strings are left alone deliberately, per the note in {@link walkValue}.
 *
 * Unlike {@link normalizeLogContext}, Errors stay Errors. The reporter formats
 * an error very differently from a plain object — indented frames, `[cause]:`
 * chains, colour — and turning it into `{ name, message, stack }` to bound it
 * would cost dev ergonomics on every line to fix the rare huge one.
 *
 * @param args - The arguments of a log call, as consola assembled them.
 * @returns The same array when nothing needed clipping; otherwise a copy in
 *   which only the oversized, over-deep or unreadable parts were replaced.
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

/**
 * Bound an error a call site is about to fold into a wider log context.
 *
 * Both walks above recognise an error by its type, and everything they do
 * follows from that. `logError()` in `lib/logger.ts` hands them a shape they
 * cannot recognise: it flattens the error into `{ error, stack }` — plain
 * strings — and the call site folds THAT into a context object, so by the time
 * either destination looks there is no Error left to clip. Measured, a
 * subprocess dump logged as `logger.error(msg, { ...logError(err) })` wrote a
 * 1,201,085-byte NDJSON line where the same error handed straight to the logger
 * wrote 9,368 (DOR-1827).
 *
 * Clipping at the moment of flattening is what fixes that for every one of the
 * ~92 call sites without touching any of them. The bounds, the marker and the
 * message/frames boundary are the ones the rest of this module uses — the whole
 * point is that the two destinations agree, so there is exactly one
 * implementation to agree with.
 *
 * **Total, by construction**, and this one matters more than it does for the
 * two walks above. They run inside the reporters, which already refuse to
 * throw back at a caller; this runs at the CALL SITE, inside the `catch` block
 * that is handling something else. A throw here would not cost a log line, it
 * would replace the failure being reported with one of its own, part-way
 * through a recovery path, at 97 call sites. Two shapes make that a live risk
 * rather than a theoretical one: an `Error` whose `message` or `stack` was
 * reassigned to a non-string — no `.length`, no `.slice`, no `.indexOf` — and
 * one that throws on the property read itself. The type guards keep the first
 * out of the `catch` entirely; the `catch` collapses anything left to the same
 * sentinel `describeError` uses (`packages/relay/src/lib/describe-error.ts`),
 * which states this rule for the same reason.
 *
 * **The `error` field can end up on screen.** Three call sites in `index.ts`
 * pass it to `setTasksInitError`, `setRelayInitError` and `setMeshInitError`,
 * which surface it as `features.*.initError` on the config route and render it
 * in Settings → Tools. So the marker below is not only log text: in the
 * overflow case a person reads it, which is why the words after its ellipsis
 * name the size in plain language instead of leaving the cut unexplained.
 *
 * @param err - Whatever was caught, however malformed.
 * @returns `error` — the message, or `String(err)` for a thrown non-Error —
 *   plus `stack` for an Error that has one. Each is returned unchanged when it
 *   was already within bounds, which is every ordinary error.
 */
export function clipFlattenedError(err: unknown): { error: string; stack?: string } {
  try {
    if (!(err instanceof Error)) {
      // A thrown non-Error stands in for the message, so it gets the message
      // bound. This is not the general string cap `walkValue` declines to
      // apply: the call site has already told us this value is a failure
      // reason, not a payload.
      return { error: clip(asString(err), MAX_MESSAGE_LEN) };
    }

    const message = asString(err.message);
    const stack = err.stack === undefined ? undefined : asString(err.stack);
    return {
      error: clip(message, MAX_MESSAGE_LEN),
      stack: stack === undefined ? undefined : clipStack(stack, message),
    };
  } catch {
    // Reading this error's own fields is what failed, so there is nothing
    // partial worth salvaging — and the caller is already mid-recovery from a
    // different failure. Say that much and let their line be written.
    return { error: 'unserializable error' };
  }
}

/**
 * A string, from a value that is supposed to be one but need not be.
 *
 * `message` and `stack` are ordinary writable properties, so anything can end
 * up on them — and everything downstream here is string work. A string passes
 * through by identity, so the ordinary path is untouched; `String()` may throw
 * for a hostile value, which is what the caller's `catch` is for.
 */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

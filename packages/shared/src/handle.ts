/**
 * The one definition of what a handle looks like (spec `handles` §1, G2).
 *
 * A handle is an author's address: the short, lowercase, unique, typeable token
 * somebody writes after an `@` to reach exactly them. Every surface that
 * accepts, derives, validates or renders one reads THIS module — the server's
 * write path, the mint-time derivation, the mention resolver, and the client's
 * optimistic check. A second copy is how a picker starts offering something the
 * resolver refuses.
 *
 * It is deliberately NOT `agents.name`'s grammar (`AGENT_NAME_REGEX`, 1–64,
 * `[a-z][a-z0-9-]*`, `validation.ts`) and deliberately does NOT reuse
 * `slugifyAgentName`. That function targets the other grammar, so it flattens
 * `.` and `_` to `-` and prefixes `a-` for a leading digit — right there, wrong
 * here, and measurably so: over the 52 agents registered on the machine this was
 * written against it changes four addresses that work today (`144mono`,
 * `144x.co`, `doriancollier.com`, `next_starter`). {@link deriveHandle} changes
 * none of them.
 *
 * @module shared/handle
 */

/**
 * The shortest a handle may be. Two, matching Discord — our namespace is a few
 * dozen entities, so nothing about our scale argues for a bound at all, and the
 * tiebreak is that a shipped, tested-at-scale bound beats an invented one.
 */
export const HANDLE_MIN_LENGTH = 2;

/** The longest a handle may be. Long enough that truncation is rare. */
export const HANDLE_MAX_LENGTH = 32;

/**
 * What a handle may be spelled with: lowercase ASCII letters and digits, `.`,
 * `_` and `-`; 2–32 characters; starting AND ending alphanumeric; no
 * consecutive dots.
 *
 * Three properties are load-bearing and each is a rule somebody will otherwise
 * re-derive.
 *
 * **Lowercase-only, not case-insensitive.** Input is lowercased before
 * validation, so `@Ana` and `@ana` can never both exist. That is stronger than
 * case-insensitive matching, because it removes the question rather than
 * answering it — there is never a stored mixed-case value something has to
 * decide is equal to another. Discord measured its way here (an incorrect
 * casing named as a cause of a ~50% friend-request failure rate) and Matrix
 * reasoned its way here (_"we do not consider it valid to have two user IDs
 * which differ only in case"_).
 *
 * **Must start _and end_ alphanumeric.** The resolver looks a token up raw
 * first and, failing that, again with a trailing `.`/`-`/`_` shaved off, so
 * `@ana.` at the end of a sentence still reaches `ana`. Because raw is tried
 * FIRST, a handle ending in `.` would be reachable — and the hazard runs the
 * other way: if both `ana` and `ana.` existed, `@ana.` would resolve to `ana.`
 * and `ana` would lose its sentence-ending form to a neighbour. Forbidding a
 * trailing separator costs one character of grammar and removes the whole class.
 *
 * **Restrict, don't detect.** The charset cannot express a Cyrillic `а`, a
 * fullwidth `ａ`, or a zero-width joiner, so the confusable class does not exist
 * to be caught. Matrix takes the other road — disambiguate at render time when
 * two display names collide — and has a `Security`-labelled hole exactly there,
 * because a homoglyph never string-collides and disambiguation never fires
 * (element-web #5826). A filter must be kept current against an adversary; a
 * grammar is enforced once. Anyone whose name this charset cannot spell is
 * served by `display_name`, which is unrestricted, and that split is the whole
 * reason the two columns are different columns.
 *
 * Not global, so it is safe to `test` — a global pattern moves its `lastIndex`
 * between calls and would answer differently on alternate invocations.
 */
export const HANDLE_PATTERN = /^[a-z0-9](?!.*\.\.)[a-z0-9._-]{0,30}[a-z0-9]$/;

/** A run of anything the grammar forbids, which derivation replaces with one `-`. */
const FORBIDDEN_RUN = /[^a-z0-9._-]+/g;

/** Two or more dots in a row, which derivation collapses to one. */
const REPEATED_DOTS = /\.{2,}/g;

/** A leading run of separators, which derivation trims off. */
const LEADING_SEPARATORS = /^[._-]+/;

/** A trailing run of separators, which derivation trims off. */
const TRAILING_SEPARATORS = /[._-]+$/;

/**
 * Normalize a candidate handle: trim, drop a leading `@`, lowercase, and treat
 * empty as absent.
 *
 * **`undefined` for an empty result is not a convenience — it is what keeps the
 * partial unique index correct.** Many NULLs coexist under
 * `authors_handle_unique`; many empty strings do not, so the second person to
 * "clear" their handle would collide with the first. Buzz hit this and coerces
 * in its write path for exactly the same reason.
 *
 * **The leading `@` goes because a person will type it.** The sigil is how a
 * handle is written everywhere it is READ — in a room, in a roster, in this
 * documentation — so a field asking for one gets `@ana` from somebody who has
 * only ever seen it that way. Refusing that is pedantry about a value with no
 * ambiguity in it; `@` is not in the charset, so nothing legal is being eaten.
 * Only ONE is dropped: `@@ana` is somebody making a mistake worth reporting, not
 * a spelling worth guessing at.
 *
 * Deliberately does NOT validate. Normalizing and judging are two steps because
 * the caller needs to tell "you gave me nothing" from "you gave me something
 * illegal" — the first clears a handle, the second is a refusal.
 *
 * @param raw - Whatever a person or a caller supplied.
 * @returns The normalized handle, or `undefined` when there was nothing there.
 */
export function normalizeHandle(raw: string): string | undefined {
  const trimmed = raw.trim();
  const bare = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;
  const normalized = bare.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

/** Whether a normalized handle is legal, and why not when it is not. */
export interface HandleValidation {
  valid: boolean;
  /** A sentence a person can act on. Present only when `valid` is false. */
  error?: string;
}

/**
 * Whether a handle is legal under {@link HANDLE_PATTERN}, with the reason when
 * it is not.
 *
 * The reason is the point. "Invalid handle" tells somebody to guess; naming the
 * rule they missed tells them what to type instead.
 *
 * Expects an already-{@link normalizeHandle}d value: an uppercase letter is
 * reported as illegal rather than silently accepted, because a caller that
 * skipped normalization has a bug and hiding it would store a value the index
 * folds and the grammar forbids.
 *
 * @param handle - The candidate, normalized.
 */
export function validateHandle(handle: string): HandleValidation {
  if (handle.length < HANDLE_MIN_LENGTH || handle.length > HANDLE_MAX_LENGTH) {
    return {
      valid: false,
      error: `A handle must be between ${HANDLE_MIN_LENGTH} and ${HANDLE_MAX_LENGTH} characters.`,
    };
  }
  if (HANDLE_PATTERN.test(handle)) return { valid: true };
  if (handle !== handle.toLowerCase()) {
    return { valid: false, error: 'A handle is all lowercase.' };
  }
  if (!/^[a-z0-9]/.test(handle) || !/[a-z0-9]$/.test(handle)) {
    return { valid: false, error: 'A handle has to start and end with a letter or a number.' };
  }
  if (handle.includes('..')) {
    return { valid: false, error: 'A handle cannot have two dots in a row.' };
  }
  return {
    valid: false,
    error: 'A handle can only use lowercase letters, numbers, dots, underscores and hyphens.',
  };
}

/**
 * Derive a handle from a name, de-colliding against `taken`.
 *
 * It replaces only runs the grammar actually forbids, collapses consecutive
 * dots, trims to an alphanumeric first and last character, cuts to
 * {@link HANDLE_MAX_LENGTH}, and trims again — because a cut can land on a
 * separator.
 *
 * A collision appends a decimal counter: `-2`, `-3`. Not random digits.
 * Discord's migration is the cautionary tale and its lesson is that an
 * assigned, unmemorable suffix is a suffix nobody can use; the degradation
 * itself came from deriving late into an exhausted namespace of hundreds of
 * millions. Ours is a few dozen entities on one machine, where a counter will
 * rarely reach two digits.
 *
 * **`undefined` when the name cannot spell a legal handle** — a name made only
 * of characters outside the charset, or one that survives normalization at
 * fewer than {@link HANDLE_MIN_LENGTH}. This is the honest answer, and it is why
 * `authors.handle` is nullable: "this author cannot be addressed" is a state a
 * row is allowed to be in, and inventing an address is how somebody ends up
 * writing a message that reaches nobody.
 *
 * @param name - The string to derive from. For an agent this is `agents.name`,
 *   which is what addresses it today; the display name is only a fallback the
 *   CALLER reaches for when this returns nothing.
 * @param taken - Every handle already spoken for, live or tombstoned, lowercase.
 *   Matched case-insensitively, because the index folds case.
 */
export function deriveHandle(name: string, taken: ReadonlySet<string>): string | undefined {
  const stem = handleStem(name);
  if (stem === undefined) return undefined;

  const spokenFor = new Set([...taken].map((entry) => entry.toLowerCase()));
  if (!spokenFor.has(stem)) return stem;

  // Counters start at 2: `ana-2` is the second `ana`, which is the only reading
  // that does not make the first one look like it was numbered too.
  for (let counter = 2; ; counter += 1) {
    const suffix = `-${counter}`;
    const trimmed = trimSeparators(stem.slice(0, HANDLE_MAX_LENGTH - suffix.length));
    // Truncating to make room can eat the stem entirely (a two-character stem
    // and a long counter). Nothing legal is left to suffix, so stop honestly.
    if (trimmed.length === 0) return undefined;
    const candidate = `${trimmed}${suffix}`;
    if (!spokenFor.has(candidate)) return candidate;
  }
}

/**
 * Derive a handle in a NAMESPACE of its own: the name, qualified by where it
 * came from, as `name.qualifier`.
 *
 * **The qualifier is a squatting defence, not a label.** Everything local on an
 * install derives into one flat namespace, and something deriving a BARE name
 * into it can take a name a local entity would answer to — permanently, because
 * a handle is written once and a released one is tombstoned. Qualifying removes
 * the class rather than racing it: a name from one namespace can never equal a
 * name from another, whoever gets there first.
 *
 * **Only the NAME is ever truncated.** A cut that ate the qualifier would put
 * the caller straight back in the namespace it was being kept out of, so the
 * length bound is spent on the name and the qualifier is kept whole. The
 * de-collision counter goes on the very end, after the qualifier, for the same
 * reason.
 *
 * `undefined` rather than a bare fallback when there is nothing usable to build
 * from — a qualifier that reduces to nothing, or a name with no room left beside
 * it. Falling back to the unqualified form is exactly the hole this closes.
 *
 * @param name - The raw name to derive from.
 * @param qualifier - Where it came from, e.g. a platform's own name. Reduced by
 *   the same grammar as everything else, so no caller keeps a table of
 *   abbreviations in step with anything.
 * @param taken - Every handle already spoken for, live or tombstoned.
 */
export function deriveQualifiedHandle(
  name: string,
  qualifier: string,
  taken: ReadonlySet<string>
): string | undefined {
  const suffix = handleStem(qualifier);
  if (suffix === undefined) return undefined;
  const stem = handleStem(name);
  if (stem === undefined) return undefined;

  const qualified = `.${suffix}`;
  const spokenFor = new Set([...taken].map((entry) => entry.toLowerCase()));
  for (let counter = 1; ; counter += 1) {
    const numbered = counter === 1 ? '' : `-${counter}`;
    const room = HANDLE_MAX_LENGTH - qualified.length - numbered.length;
    if (room < HANDLE_MIN_LENGTH) return undefined;
    const trimmed = trimSeparators(stem.slice(0, room));
    if (trimmed.length === 0) return undefined;
    const candidate = `${trimmed}${qualified}${numbered}`;
    if (!spokenFor.has(candidate)) return candidate;
  }
}

/**
 * The legal handle a name reduces to, before de-collision, or `undefined` when
 * it reduces to nothing usable.
 *
 * @param name - The raw name.
 */
function handleStem(name: string): string | undefined {
  const reduced = trimSeparators(
    name
      .trim()
      .toLowerCase()
      .replace(FORBIDDEN_RUN, '-')
      .replace(REPEATED_DOTS, '.')
      .slice(0, HANDLE_MAX_LENGTH)
  );
  // The cut above can strip the character that made a run legal, so validate
  // rather than trust the construction: this is the one function whose output
  // the grammar has never seen.
  return reduced.length >= HANDLE_MIN_LENGTH && HANDLE_PATTERN.test(reduced) ? reduced : undefined;
}

/**
 * Drop leading and trailing separators, so what is left starts and ends
 * alphanumeric.
 *
 * @param value - A partially reduced handle.
 */
function trimSeparators(value: string): string {
  return value.replace(LEADING_SEPARATORS, '').replace(TRAILING_SEPARATORS, '');
}

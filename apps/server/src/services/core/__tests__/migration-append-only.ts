/**
 * The DOR-1222 append-only rule: a merged migration body never changes again.
 *
 * `migration-safety.ts` next door measures every migration key against the
 * newest `v*` TAG. That leaves one window open, and the window is where the bug
 * lives: between the commit that merges a migration and the tag that releases
 * it, the tag-based rule says "this key is new work" and lets its body be
 * rewritten freely.
 *
 * It ran anyway. `conf` executes a key only in `(storedVersion,
 * projectVersion]`, and `projectVersion` is whatever `SERVER_VERSION` resolves
 * to on the machine that booted — `__CLI_VERSION__` in a built CLI bundle, the
 * same version in the desktop app, `DORKOS_VERSION_OVERRIDE` when set. Only a
 * raw dev tree is exempt, because `apps/server/package.json` reads `0.0.0`.
 * Every one of those versions is bumped in the repository BEFORE the tag exists,
 * so anyone who builds and runs during that window is stamped with the new
 * version and has run the body of that day. The operator's own machine is the
 * worked example: `~/.dork/config.json` was stamped `0.59.0` on 2026-08-12 while
 * `0.59.0` was still "unreleased", and both later amendments to that key —
 * `welcomeBack.offersEnabled` OFF to ON, then the composer prefs seed — skipped
 * him in silence. The dogfood machine is always somebody.
 *
 * So the licence "nobody has run it yet" is not available from the tag, and in
 * practice is not available at all. This rule replaces it with one that can be
 * checked: **once a migration is merged, its body is frozen.** A change of mind
 * opens a NEW key above the newest tag, written so it can tell the two states
 * apart, rather than editing a body some installs already ran.
 *
 * ## What is hashed, and why that shape
 *
 * The hash covers the key's whole reachable CLOSURE, not its line in the table.
 * Half the table is a bare reference (`'0.50.0': backfillSidebarDefaults`), so a
 * rule that hashed only the table slice would pin nothing but a function NAME —
 * which is exactly the hole `contributing/configuration.md` recorded: DOR-1121
 * edited `backfillWelcomeBackDefaults`, a helper the table merely calls, and no
 * guard could see it. So the closure is the table slice plus the source of every
 * top-level declaration in `config-manager.ts` it reaches, transitively, sorted
 * by name so moving a declaration within the file is not a change.
 *
 * Bindings count, not only functions. `migrateSidebarSectionPrefs` deletes
 * exactly the keys named in `RETIRED_SIDEBAR_KEYS`, so a closure that followed
 * calls alone would freeze the code and leave the list it acts on editable.
 *
 * The text is normalized before hashing: comments removed, a trailing comma or
 * semicolon before a closer removed, whitespace runs collapsed to one space and
 * dropped entirely beside brackets, separators, `.` and `<`/`>`. That is
 * deliberately robust to Prettier churn — reflowing a call across lines, or
 * re-indenting after an unrelated edit, must not fire a guard whose entire value
 * is that it only ever fires for real.
 *
 * The robustness claim is measured, not asserted, and the measurement is what
 * built the list above. Reformatting `config-manager.ts` at print widths 60, 80,
 * 100, 140 and 200 moves no pin. Each rule earned its place by a width that
 * broke without it: 140 and 200 join a body's last statement onto one line and
 * move all eleven pins without the semicolon rule; 80 breaks a member access
 * onto its own line (`}) .retired`); 60 breaks a generic across lines
 * (`Record< string, … >`). A future `.prettierrc` change must not mass-repin
 * this table — eleven pins moving at once is how a guard gets bulk-bumped and
 * stops meaning anything.
 *
 * It also leaves a stale COMMENT inside a
 * shipped body correctable in place, which the byte-identity rule next door
 * refuses; the two rules disagree there on purpose, and the stricter one wins
 * for keys that have shipped.
 *
 * **The boundary, stated so nobody over-trusts it.** The closure never leaves
 * `config-manager.ts`, and three keys already reach past that edge into
 * `@dorkos/shared/config-schema`: `0.55.0` reads `ONBOARDING_STEPS`, `0.59.0`
 * reads `ComposerPrefsSchema`, and `0.57.0` calls `toSidebarItemRef` and
 * `normalizeSidebarPrefs`. Narrowing that enum makes a shipped migration delete
 * more; editing those functions rewrites what a shipped rename produces. No pin
 * moves for either. Following imports was considered and left out on purpose —
 * it would reach the whole config schema, so every ordinary field addition would
 * break every pin and the pins would be bumped reflexively, which is worse than
 * a boundary written down. The migration table itself is also never followed
 * into (see {@link MIGRATION_TABLE}).
 *
 * Pure on purpose, like `migration-safety.ts`: text in, verdict out, so the
 * cases that must FAIL are fixture-testable. `migration-append-only.test.ts`
 * runs that matrix; `config-manager.test.ts` feeds it the real file and the
 * pinned hashes in `merged-migration-hashes.ts`.
 */
import { createHash } from 'crypto';

import { extractMigrationBodies } from './migration-safety.js';

/** How many hex characters of the SHA-256 a pin carries. */
const HASH_LENGTH = 16;

/**
 * A top-level function declaration, at column zero.
 *
 * `async` and `*` are matched even though this file has neither today. A form
 * this pattern does not know is not skipped loudly — it is simply never seen, so
 * a migration reaching it would be pinned with a hole in the middle. Note what
 * the count cross-check in {@link extractTopLevelDeclarations} does and does not
 * cover here: it compares this pattern against itself on two inputs, so it
 * catches the MASK losing a declaration and is blind, by construction, to a
 * declaration form the pattern never expresses.
 */
const TOP_LEVEL_FUNCTION = /^(?:export )?(?:async )?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/gm;

/** A top-level `const`/`let` declaration, at column zero. */
const TOP_LEVEL_BINDING = /^(?:export )?(?:const|let) ([A-Za-z_$][\w$]*)(?=\s*[:=])/gm;

/**
 * The migration table itself, which is never followed into a closure.
 *
 * It is a top-level binding like any other, so a stray mention of its name
 * inside a body would pull the WHOLE table into that key's closure — and then
 * every key's hash would depend on every other key, so adding one migration
 * would break every pin at once. Excluded by name rather than by luck.
 */
const MIGRATION_TABLE = 'CONFIG_MIGRATIONS';

/** Any identifier-shaped token, used to find the calls a body makes. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * One scanner, two jobs: blank the comments, and optionally the strings too.
 *
 * Length and line breaks are preserved either way, so an offset found in the
 * output is the same offset in the input.
 *
 * @param source - Any TypeScript source text.
 * @param blankStrings - Whether the INSIDE of string and template literals is
 *   blanked as well. True when scanning for structure; false when the result is
 *   the text being hashed, where a string's characters are behavior.
 * @returns A same-length copy with the requested ranges blanked.
 */
function blankOut(source: string, blankStrings: boolean): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };

  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    const ch = source[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j++;
      }
      // The delimiters stay either way, so a blanked string is still visibly a
      // string rather than a run of spaces that could merge with its neighbours.
      if (blankStrings) blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Blank out everything that is not code, preserving every offset.
 *
 * Comments and the inside of string/template literals become spaces, so a brace,
 * a `function` keyword or a quote appearing in prose or in a string cannot be
 * mistaken for structure.
 *
 * @param source - Any TypeScript source text.
 * @returns A same-length string with non-code blanked out.
 */
function maskNonCode(source: string): string {
  return blankOut(source, true);
}

/**
 * Blank out the comments and nothing else.
 *
 * @param source - Any TypeScript source text.
 * @returns A same-length string with comment characters replaced by spaces.
 */
export function stripComments(source: string): string {
  return blankOut(source, false);
}

/**
 * Every family of top-level declaration the closure can reach, as a list.
 *
 * A list rather than two call sites, because the mask cross-check below walks
 * it: covering one family and not the other is the same hole half-fixed, and a
 * third family added here cannot forget to be checked.
 */
const DECLARATION_PATTERNS: readonly { label: string; pattern: RegExp }[] = [
  { label: 'top-level functions', pattern: TOP_LEVEL_FUNCTION },
  { label: 'top-level bindings', pattern: TOP_LEVEL_BINDING },
];

/** A line that is exactly `}` — the end of a top-level declaration. */
const CLOSING_LINE = /\n\}(?=\n|$)/;

/**
 * How many times a global pattern matches, without disturbing shared state.
 *
 * @param pattern - A `g`-flagged pattern; its `lastIndex` is reset first.
 * @param text - The text to count matches in.
 * @returns The number of matches.
 */
function countMatches(pattern: RegExp, text: string): number {
  pattern.lastIndex = 0;
  let n = 0;
  while (pattern.exec(text) !== null) n++;
  return n;
}

/**
 * Every top-level function in the file, mapped to its own source text.
 *
 * A declaration runs from its `function` line to the next line that is exactly
 * `}` — which is what Prettier produces for every top-level function here, and
 * is checked rather than assumed: a declaration with no such terminator raises
 * instead of returning a truncated body that would hash stably and pin nothing.
 *
 * The terminator must be a line of its own. Every helper here takes an inline
 * object type, which Prettier breaks across lines and closes with `}): void {`
 * at column zero — so a search for a leading `}` alone stops at the PARAMETER
 * LIST and pins a signature while the body it guards drifts freely underneath.
 * That is not hypothetical: it is what this function did when it was first
 * written, and the check that was supposed to catch it ("does the slice end in
 * `}`?") passed, because a slice cut short at the parameter list ends in `}`
 * too.
 *
 * Top-level `const`/`let` bindings are collected the same way, ending at the
 * first `;` outside any bracket. They matter because a migration's behavior can
 * live in one: `migrateSidebarSectionPrefs` deletes exactly the keys listed in
 * `RETIRED_SIDEBAR_KEYS`, so a pin that followed only function calls would leave
 * that list editable underneath a shipped migration.
 *
 * @param source - The full `config-manager.ts` source text.
 * @returns Each declared name mapped to its declaration text.
 * @throws When a declaration has no terminator, which means this reader has
 *   drifted from the file rather than that the file is safe.
 */
export function extractTopLevelDeclarations(source: string): Record<string, string> {
  const masked = maskNonCode(source);
  const found: Record<string, string> = {};

  // The mask is the part of this guard most likely to be wrong, so it is
  // cross-checked rather than trusted. `blankOut` does not understand REGEX
  // LITERALS: a quote inside one (`/it's/`) reads as a string opening, and
  // everything to the next quote — often the whole rest of the file, since the
  // parity stays flipped — is blanked away. Counting the same pattern over the
  // RAW source and demanding agreement catches that. A raw match the mask
  // correctly excluded (a declaration inside a template literal) also lands
  // here, and stopping to look is the right answer there too.
  //
  // What it buys, stated as measured rather than as hoped. Four shapes of
  // quote-bearing regex were tried against this extractor with the check
  // removed, and every one of them still threw — because the same blanking that
  // hides a declaration also eats some later terminator. But it threw the WRONG
  // error: "function ok has no closing line of its own", or "binding PATTERN
  // never terminates", naming a declaration that is perfectly well-formed and
  // sending the reader to fix a file that is not broken. This check runs first
  // and names the scanner. A genuinely silent drop was not reproduced — and is
  // not ruled out either, which is the other reason the cheap check stays.
  //
  // Every declaration family is checked, not just functions: covering one and
  // not the other is the same hole half-fixed, which is exactly what the first
  // version of this shipped as.
  for (const { label, pattern } of DECLARATION_PATTERNS) {
    const rawCount = countMatches(pattern, source);
    const maskedCount = countMatches(pattern, masked);
    if (rawCount !== maskedCount) {
      throw new Error(
        `the append-only guard sees ${maskedCount} ${label} after masking but ${rawCount} in ` +
          'the raw source. Something in this file confuses the comment/string scanner — a regex ' +
          'literal containing a quote is the usual cause — so declarations are invisible to the ' +
          'pins. Fix the scanner; do not repin around it.'
      );
    }
  }

  TOP_LEVEL_FUNCTION.lastIndex = 0;
  for (let m = TOP_LEVEL_FUNCTION.exec(masked); m !== null; m = TOP_LEVEL_FUNCTION.exec(masked)) {
    const name = m[1]!;
    const close = masked.slice(m.index).search(CLOSING_LINE);
    if (close === -1) {
      throw new Error(
        `function ${name} has no closing line of its own — the append-only guard cannot read ` +
          'this file, which means the guard is stale rather than that the file is safe.'
      );
    }
    found[name] = source.slice(m.index, m.index + close + 2);
  }

  TOP_LEVEL_BINDING.lastIndex = 0;
  for (let m = TOP_LEVEL_BINDING.exec(masked); m !== null; m = TOP_LEVEL_BINDING.exec(masked)) {
    const name = m[1]!;
    if (name === MIGRATION_TABLE) continue;
    const end = endOfStatement(masked, m.index);
    if (end === -1) {
      throw new Error(
        `binding ${name} never terminates — the append-only guard cannot read this file, which ` +
          'means the guard is stale rather than that the file is safe.'
      );
    }
    found[name] = source.slice(m.index, end);
  }
  return found;
}

/**
 * Index just past the `;` that ends a statement, ignoring any inside brackets.
 *
 * @param masked - Source with comments and string contents blanked.
 * @param from - Where the statement starts.
 * @returns The end index, or -1 when the statement never terminates.
 */
function endOfStatement(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const ch = masked[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ';' && depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Reduce a run of code to the text whose change is a real change.
 *
 * Comments are already blanked by the caller. Whitespace runs collapse to one
 * space, and the space beside a bracket, comma, semicolon, `.` or `<`/`>` goes
 * entirely — those are the places Prettier introduces a line break, so removing
 * them makes reflow invisible. Whitespace between two words is left alone,
 * because `return foo` and `returnfoo` are not the same program.
 *
 * A trailing comma OR semicolon immediately before a closer is dropped, because
 * both are Prettier's, not the author's: a call gains a trailing comma the
 * moment it breaks across lines, and a body's last statement gains or loses its
 * own line — `void 0;}` against `void 0}` — with the print width. Measured, not
 * assumed: at `--print-width 140` the semicolon rule alone is the difference
 * between all eleven pins moving and none of them moving. The `.` and `<`/`>`
 * entries were found the same way, at widths 80 and 60 (see the module header).
 */
function collapseCode(text: string): string {
  return text
    .replace(/[,;](\s*[)\]}])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([)\]},;.>])/g, '$1')
    .replace(/([([{,;<])\s+/g, '$1');
}

/**
 * Strip a source slice down to the text whose change is a real change.
 *
 * Code is collapsed; the CONTENTS of string and template literals are copied
 * through untouched, because the characters in a string are behavior — a seeded
 * key name with a space in it is a different key.
 *
 * @param text - A slice of TypeScript source.
 * @returns The normalized text that gets hashed.
 */
export function normalizeForHash(text: string): string {
  const masked = maskNonCode(text);
  const code = stripComments(text);

  let out = '';
  let buffer = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    // Blank in both passes is a comment; blank only in the masked pass is the
    // inside of a string.
    const isStringContent = masked[i] === ' ' && code[i] !== ' ';
    if (isStringContent !== inString) {
      out += inString ? buffer : collapseCode(buffer);
      buffer = '';
      inString = isStringContent;
    }
    buffer += isStringContent ? text[i] : code[i];
  }
  out += inString ? buffer : collapseCode(buffer);
  return out.trim();
}

/**
 * The full reachable source of one migration key: its table slice plus every
 * top-level function it calls, transitively, in name order.
 *
 * @param key - The migration key, as written in `CONFIG_MIGRATIONS`.
 * @param source - The full `config-manager.ts` source text.
 * @returns The concatenated closure text.
 * @throws When the key is not in the table.
 */
export function migrationClosure(key: string, source: string): string {
  const bodies = extractMigrationBodies(source);
  const slice = bodies[key];
  if (slice === undefined) {
    throw new Error(`migration key "${key}" is not in CONFIG_MIGRATIONS`);
  }
  const functions = extractTopLevelDeclarations(source);

  const reached = new Set<string>();
  const queue = [slice];
  while (queue.length > 0) {
    const text = maskNonCode(queue.pop()!);
    IDENTIFIER.lastIndex = 0;
    for (let m = IDENTIFIER.exec(text); m !== null; m = IDENTIFIER.exec(text)) {
      const name = m[0];
      const declaration = functions[name];
      if (declaration === undefined || reached.has(name)) continue;
      reached.add(name);
      queue.push(declaration);
    }
  }

  // Sorted, so moving a function within the file is not a change to any key.
  return [slice, ...[...reached].sort().map((name) => functions[name]!)].join('\n');
}

/**
 * The pinned hash of one migration key's closure.
 *
 * @param key - The migration key, as written in `CONFIG_MIGRATIONS`.
 * @param source - The full `config-manager.ts` source text.
 * @returns A truncated SHA-256 of the normalized closure. Truncated because a
 *   pin is read by people in a diff and this is an accident guard, not a
 *   security boundary.
 */
export function migrationHash(key: string, source: string): string {
  return createHash('sha256')
    .update(normalizeForHash(migrationClosure(key, source)))
    .digest('hex')
    .slice(0, HASH_LENGTH);
}

/**
 * Every migration key in the table, mapped to its closure hash.
 *
 * @param source - The full `config-manager.ts` source text.
 * @returns Each migration key mapped to the hash of its reachable closure.
 */
function migrationHashes(source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(extractMigrationBodies(source))) {
    out[key] = migrationHash(key, source);
  }
  return out;
}

/** The verdict, with every drift named rather than just a boolean. */
export interface AppendOnlyResult {
  /** Whether every merged migration still hashes to what it was pinned at. */
  ok: boolean;
  /** One entry per problem, each naming the key and what to do about it. */
  problems: string[];
  /** What the working tree hashes to, so a repin can be copied from here. */
  hashes: Record<string, string>;
}

/** Why a body may never be edited once merged, said once and reused. */
const RULE =
  'A migration body is APPEND-ONLY from the moment it merges, not from the moment it is ' +
  'tagged. conf runs a key only in (storedVersion, projectVersion], and every build that ' +
  'is not a raw dev tree — a built CLI, the desktop app, the dogfood machine — resolves ' +
  'SERVER_VERSION to the version already bumped in the repo, runs the body of that day, and ' +
  'stores that version. It never runs the key again. "It is not tagged yet" is not evidence ' +
  'that nobody ran it (DOR-1222).';

/**
 * Decide whether every migration key still matches the hash it was pinned at.
 *
 * @param source - The working tree's `config-manager.ts` source.
 * @param pinned - The recorded hash per merged migration key.
 * @returns The verdict, naming every drift and how to answer it.
 */
export function checkAppendOnly(
  source: string,
  pinned: Readonly<Record<string, string>>
): AppendOnlyResult {
  const hashes = migrationHashes(source);
  const problems: string[] = [];
  const drifted: string[] = [];

  for (const [key, hash] of Object.entries(hashes)) {
    const pin = pinned[key];
    if (pin === undefined) {
      problems.push(
        `migration "${key}" is not pinned. A new key is pinned in the SAME pull request that ` +
          `introduces it, so that every later edit to it is visible as a changed pin rather ` +
          `than an invisible rewrite. Add '${key}': '${hash}' to merged-migration-hashes.ts.`
      );
      continue;
    }
    if (pin !== hash) {
      drifted.push(key);
      problems.push(
        `migration "${key}" changed after it was pinned (pinned ${pin}, now ${hash}). ${RULE} ` +
          `Change of mind: open a NEW key strictly above the newest v* tag, written to tell a ` +
          `value this body seeded from one a person chose. Repinning is the escape hatch and it ` +
          `needs a recorded justification that NO install can have run the old body. For any key ` +
          `at or below the version this repository currently carries, that has never been true — ` +
          `and a key above it stops being safe the moment the release bump lands, which is not a ` +
          `moment anybody is notified of.`
      );
    }
  }

  if (drifted.length > 1) {
    problems.push(
      `${drifted.length} keys moved together (${drifted.join(', ')}), which usually means a ` +
        'HELPER they all reach was edited rather than any one body. There is one version of ' +
        'that which is legitimate and recurring: extending a fill-if-absent helper and adding a ' +
        'NEW key that re-runs it, so the population who already passed the older keys is covered ' +
        'by the new one (the backfillRoomsDefaults pattern). If that is what this is, repin the ' +
        'older keys and say in the pull request which new key covers them. If there is no new ' +
        'key, this is an edit to what those migrations did, and it reaches nobody who has run ' +
        'them.'
    );
  }

  for (const key of Object.keys(pinned)) {
    if (hashes[key] === undefined) {
      problems.push(
        `migration "${key}" is pinned but is no longer in CONFIG_MIGRATIONS. Migrations are ` +
          'append-only: a key that shipped must stay, or an install still upgrading through it ' +
          'silently skips the state change it was owed.'
      );
    }
  }

  return { ok: problems.length === 0, problems, hashes };
}

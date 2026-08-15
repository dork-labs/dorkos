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
 * top-level function in `config-manager.ts` it reaches, transitively, sorted by
 * name so moving a function within the file is not a change.
 *
 * The text is normalized before hashing: comments removed, trailing commas
 * before a closer removed, whitespace runs collapsed to one space. That is
 * deliberately robust to Prettier churn — reflowing a call across lines, or
 * re-indenting after an unrelated edit, must not fire a guard whose entire value
 * is that it only ever fires for real. It also leaves a stale COMMENT inside a
 * shipped body correctable in place, which the byte-identity rule next door
 * refuses; the two rules disagree there on purpose, and the stricter one wins
 * for keys that have shipped.
 *
 * **The boundary, stated so nobody over-trusts it.** The closure follows
 * function calls inside `config-manager.ts`. It does NOT follow module-level
 * constants, and does not leave the file — a helper that spreads
 * `ROOMS_DEFAULTS` is pinned, the constant it spreads is not. Pinning shared
 * default constants would fire on every ordinary schema addition and the guard
 * would be repinned reflexively, which is worse than a boundary written down.
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

/** A top-level function declaration, at column zero. */
const TOP_LEVEL_FUNCTION = /^(?:export )?function ([A-Za-z_$][\w$]*)\s*\(/gm;

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
function stripComments(source: string): string {
  return blankOut(source, false);
}

/** A line that is exactly `}` — the end of a top-level declaration. */
const CLOSING_LINE = /\n\}(?=\n|$)/;

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
 * @param source - The full `config-manager.ts` source text.
 * @returns Each function name mapped to its declaration text.
 * @throws When a declaration has no closing line of its own.
 */
export function extractTopLevelFunctions(source: string): Record<string, string> {
  const masked = maskNonCode(source);
  const found: Record<string, string> = {};

  TOP_LEVEL_FUNCTION.lastIndex = 0;
  for (let m = TOP_LEVEL_FUNCTION.exec(masked); m !== null; m = TOP_LEVEL_FUNCTION.exec(masked)) {
    const name = m[1]!;
    const rest = masked.slice(m.index);
    const close = rest.search(CLOSING_LINE);
    if (close === -1) {
      throw new Error(
        `function ${name} has no closing line of its own — the append-only guard cannot read ` +
          'this file, which means the guard is stale rather than that the file is safe.'
      );
    }
    found[name] = source.slice(m.index, m.index + close + 2);
  }
  return found;
}

/**
 * Reduce a run of code to the text whose change is a real change.
 *
 * Comments are already blanked by the caller. Trailing commas before a closer go
 * (Prettier adds one the moment a call breaks across lines), whitespace runs
 * collapse to one space, and the space beside a bracket, comma or semicolon goes
 * entirely — those, and only those, are where Prettier introduces a line break,
 * so removing them makes reflow invisible. Whitespace between two words is left
 * alone, because `return foo` and `returnfoo` are not the same program.
 */
function collapseCode(text: string): string {
  return text
    .replace(/,(\s*[)\]}])/g, '$1')
    .replace(/\s+/g, ' ')
    .replace(/\s+([)\]},;])/g, '$1')
    .replace(/([([{,;])\s+/g, '$1');
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
  const functions = extractTopLevelFunctions(source);

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
          `needs a recorded justification that NO install can have run the old body — on this ` +
          `repository that has never once been true.`
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

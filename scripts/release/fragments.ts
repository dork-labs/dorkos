/**
 * Read changelog fragments as data and decide the version bump from them.
 *
 * A fragment is `changelog/unreleased/<id>-<slug>.md`: optional `covers:`
 * frontmatter (PR-check metadata, never compiled) and then `### Category`
 * sections of bullets (`changelog/README.md`). Anything the compiler cannot
 * place exactly is refused rather than guessed at, because no person reads
 * the daily release before it ships.
 *
 * @module scripts/release/fragments
 */
import { ReleaseCommitError } from './errors.ts';

/** The headings a fragment may use, in the order the release section prints them. */
export const CATEGORY_ORDER = [
  'Note for people upgrading',
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
] as const;

/** One heading a fragment may use. */
export type Category = (typeof CATEGORY_ORDER)[number];

/** One parsed fragment. */
export interface Fragment {
  /** The file name inside `changelog/unreleased/`. */
  file: string;
  /** The `covers:` items, unquoted, in file order. */
  covers: string[];
  /** Each category's body lines, with leading and trailing blank lines trimmed. */
  sections: Partial<Record<Category, string[]>>;
}

/** The bump the fragments call for. */
export interface BumpDecision {
  /** `minor` or `patch`; `override` when `--version` named the version. */
  bump: 'minor' | 'patch' | 'override';
  /** One plain sentence naming the fragment that decided it. */
  reason: string;
  /** True when any fragment removes or breaks something (Dorian's decision 2). */
  breaking: boolean;
  /** The version this release gets. */
  version: string;
}

const SEEDED = 'dorkos-changelog:seeded';
const HEADING = /^###\s+(.+?)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BREAKING_BULLET = /\bBREAKING\b|^\s*[-*]\s+\*\*Breaking\b/;
const BREAKING_SUBJECT = /^[a-z]+(\([^)]*\))?!:/;

/** Parse one fragment; throws {@link ReleaseCommitError} on anything it cannot place. */
export function parseFragment(file: string, text: string): Fragment {
  const fail = (why: string) => new ReleaseCommitError(`changelog/unreleased/${file}: ${why}`);
  if (text.includes('\r')) throw fail('has Windows line endings; save it with LF only.');
  if (text.includes(SEEDED))
    throw fail('is still a hook-seeded fragment; rewrite the bullet for a person first.');
  const lines = text.split('\n');
  let body = 0;
  const covers: string[] = [];
  if (lines[0] === '---') {
    const close = lines.indexOf('---', 1);
    if (close < 0) throw fail('opens frontmatter with --- and never closes it.');
    covers.push(...parseCovers(lines.slice(1, close), fail));
    body = close + 1;
  }
  const sections: Partial<Record<Category, string[]>> = {};
  let current: string[] | undefined;
  let fenced = false;
  for (const line of lines.slice(body)) {
    if (FENCE.test(line)) fenced = !fenced;
    const heading = fenced ? undefined : HEADING.exec(line);
    if (heading) {
      const name = heading[1] as Category;
      if (!CATEGORY_ORDER.includes(name))
        throw fail(`uses the heading "### ${heading[1]}", which no release section has.`);
      current = sections[name] ??= [];
      if (current.length) current.push('');
      continue;
    }
    if (!fenced && /^#{1,2}\s/.test(line))
      throw fail('has a # or ## heading, which would split the release section.');
    if (!current) {
      if (line.trim()) throw fail('has text before its first ### heading.');
      continue;
    }
    current.push(line);
  }
  for (const name of CATEGORY_ORDER) {
    const trimmed = trimBlank(sections[name] ?? []);
    if (trimmed.length) sections[name] = trimmed;
    else delete sections[name];
  }
  if (!Object.keys(sections).length) throw fail('has no bullets under any heading.');
  return { file, covers, sections };
}

/**
 * Parse every fragment file, sorted by name (the names start with a UTC
 * timestamp, so this is the order they were written). `.gitkeep` is skipped;
 * any other non-`.md` entry is refused, because the release commit may only
 * delete `changelog/unreleased/*.md`.
 */
export function parseFragments(entries: readonly { name: string; text: string }[]): Fragment[] {
  const files = entries.filter((entry) => entry.name !== '.gitkeep');
  const stray = files.find((entry) => !/^[^/]+\.md$/.test(entry.name));
  if (stray)
    throw new ReleaseCommitError(
      `changelog/unreleased/${stray.name} is not a fragment; only .md files and .gitkeep belong there.`
    );
  if (!files.length)
    throw new ReleaseCommitError(
      'Nothing to release: changelog/unreleased/ has no fragments at this commit.'
    );
  return [...files]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => parseFragment(entry.name, entry.text));
}

/**
 * Decide the next version. Breaking or Removed: a flagged minor while the
 * major is 0 (decision 2); after 1.0 a breaking change needs a person, so it
 * is refused. Added: minor. Anything else: patch. `override` (from
 * `--version`) wins, but must be greater than `previous`.
 */
export function decideBump(
  fragments: readonly Fragment[],
  previous: string,
  override?: string
): BumpDecision {
  const prev = parseVersion(previous, '--previous');
  const breakingBy = fragments.find(isBreaking);
  const breaking = !!breakingBy;
  if (override !== undefined) {
    const next = parseVersion(override, '--version');
    if (compareVersions(next, prev) <= 0)
      throw new ReleaseCommitError(
        `--version ${override} is not greater than the last release, ${previous}.`
      );
    return {
      bump: 'override',
      reason: `--version named ${override}`,
      breaking,
      version: override,
    };
  }
  if (breakingBy) {
    if (prev[0] > 0)
      throw new ReleaseCommitError(
        `${breakingBy.file} removes or breaks something, and after 1.0 that is a major release, which needs a person.`
      );
    return {
      bump: 'minor',
      reason: `${breakingBy.file} removes or breaks something (a flagged 0.x minor)`,
      breaking,
      version: `${prev[0]}.${prev[1] + 1}.0`,
    };
  }
  const added = fragments.find((fragment) => fragment.sections.Added);
  if (added)
    return {
      bump: 'minor',
      reason: `${added.file} adds something`,
      breaking,
      version: `${prev[0]}.${prev[1] + 1}.0`,
    };
  return {
    bump: 'patch',
    reason: 'no fragment adds, removes or breaks anything',
    breaking,
    version: `${prev[0]}.${prev[1]}.${prev[2] + 1}`,
  };
}

/** Parse `X.Y.Z` into numbers; throws naming `label` when it is not one. */
export function parseVersion(value: string, label: string): [number, number, number] {
  const match = VERSION.exec(value);
  if (!match)
    throw new ReleaseCommitError(`${label} must be a plain X.Y.Z version; got "${value}".`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative, zero or positive as `a` is older than, equal to or newer than `b`. */
export function compareVersions(
  a: readonly [number, number, number],
  b: readonly [number, number, number]
): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function isBreaking(fragment: Fragment): boolean {
  if (fragment.sections.Removed) return true;
  if (fragment.covers.some((item) => BREAKING_SUBJECT.test(item))) return true;
  return CATEGORY_ORDER.some((category) =>
    (fragment.sections[category] ?? []).some((line) => BREAKING_BULLET.test(line))
  );
}

function parseCovers(lines: readonly string[], fail: (why: string) => Error): string[] {
  const items: string[] = [];
  let inCovers = false;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (/^covers:\s*$/.test(line)) {
      inCovers = true;
      continue;
    }
    const item = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (!inCovers || !item?.[1])
      throw fail(`has frontmatter other than a covers: list ("${line.trim().slice(0, 60)}").`);
    items.push(unquote(item[1]));
  }
  return items;
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'"))
    return value.slice(1, -1).replaceAll("''", "'");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll('\\\\', '\\');
  return value;
}

function trimBlank(lines: readonly string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start]?.trim()) start++;
  while (end > start && !lines[end - 1]?.trim()) end--;
  return lines.slice(start, end);
}

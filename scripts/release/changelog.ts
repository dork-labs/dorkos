/**
 * Compile fragments into `CHANGELOG.md` and keep it to ten versions
 * (release.md 6.4). Every edit is a line splice: the new section goes in below
 * the `[Unreleased]` note, an aged-out section moves byte for byte into the
 * archive, and nothing else in either file moves.
 *
 * @module scripts/release/changelog
 */
import { ReleaseCommitError } from './errors.ts';
import { CATEGORY_ORDER, type Fragment } from './fragments.ts';
import { backtickMentions } from './markdown.ts';

/** How many version sections `CHANGELOG.md` keeps. */
export const CHANGELOG_CAP = 10;

/** The repository the compare links point at. */
export const REPO_URL = 'https://github.com/dork-labs/dorkos';

/** The rolling archive's file name, whose upper bound moves with every roll. */
export const ARCHIVE_FILE = /^CHANGELOG-v0\.1\.0-to-v(\d+\.\d+\.\d+)\.md$/;

/** The one-line callout a breaking release opens with (decision 2). */
export const BREAKING_CALLOUT =
  '> **This release removes or changes something you may rely on.** Read the notes below before you update.';

/** A compiled `## [X.Y.Z] - date` section. */
export interface CompiledSection {
  /** The heading line. */
  heading: string;
  /** Everything under the heading, with no leading or trailing blank line. */
  body: string[];
}

/** The rolling archive before and after a roll. */
export interface ArchiveRoll {
  /** The archive's path before the roll. */
  fromPath: string;
  /** Its new path, named for the newest version it now holds. */
  toPath: string;
  /** Its new contents. */
  text: string;
}

/** `CHANGELOG.md` after the cap, and what moved out. */
export interface CapResult {
  /** The capped changelog. */
  changelog: string;
  /** The versions that moved to the archive, newest first; empty when none did. */
  aged: string[];
  /** The archive's upper bound before the roll. */
  oldUpper: string;
  /** The archive's upper bound after it (equal to `oldUpper` when nothing moved). */
  newUpper: string;
  /** The rolled archive, when anything moved. */
  archive?: ArchiveRoll;
}

/**
 * Merge every fragment's bullets under one heading per category, in
 * {@link CATEGORY_ORDER}, fragments in name order. `covers:` never reaches the
 * section. Bare `@handle`s are put in backticks.
 */
export function compileSection(
  fragments: readonly Fragment[],
  version: string,
  date: string,
  breaking: boolean
): CompiledSection {
  const body: string[] = breaking ? [BREAKING_CALLOUT, ''] : [];
  for (const category of CATEGORY_ORDER) {
    const parts = fragments.flatMap((fragment) => {
      const lines = fragment.sections[category];
      return lines ? [lines] : [];
    });
    if (!parts.length) continue;
    body.push(`### ${category}`, '');
    parts.forEach((lines, index) => {
      // A part that does not open with a list item would read as the
      // continuation of the bullet above it, so it gets a blank line.
      if (index > 0 && !/^\s*[-*+]\s/.test(lines[0] ?? '')) body.push('');
      body.push(...lines);
    });
    body.push('');
  }
  body.pop();
  return { heading: `## [${version}] - ${date}`, body: backtickMentions(body) };
}

/** The section as the lines `CHANGELOG.md` holds: heading, blank line, body. */
export function sectionLines(section: CompiledSection): string[] {
  return [section.heading, '', ...section.body];
}

/**
 * Insert the section above the newest version, below the `[Unreleased]` note,
 * point `[Unreleased]` at the new tag and add the new version's compare link.
 */
export function insertSection(
  text: string,
  section: CompiledSection,
  previous: string,
  version: string
): string {
  const lines = text.split('\n');
  const unreleased = lines.indexOf('## [Unreleased]');
  if (unreleased < 0)
    throw new ReleaseCommitError('CHANGELOG.md has no "## [Unreleased]" heading.');
  if (lines.some((line) => line.startsWith(`## [${version}]`)))
    throw new ReleaseCommitError(`CHANGELOG.md already has a ${version} section.`);
  const first = lines.findIndex((line, index) => index > unreleased && line.startsWith('## '));
  if (first < 0 || !VERSION_HEADING.test(lines[first] ?? ''))
    throw new ReleaseCommitError(
      'CHANGELOG.md has no version section directly after the [Unreleased] note.'
    );
  lines.splice(first, 0, ...sectionLines(section), '');
  const ref = lines.findIndex((line) => line.startsWith('[Unreleased]: '));
  if (ref < 0) throw new ReleaseCommitError('CHANGELOG.md has no [Unreleased] link reference.');
  if (lines.some((line) => line.startsWith(`[${version}]: `)))
    throw new ReleaseCommitError(`CHANGELOG.md already has a [${version}] link reference.`);
  lines.splice(
    ref,
    1,
    `[Unreleased]: ${REPO_URL}/compare/v${version}...HEAD`,
    `[${version}]: ${REPO_URL}/compare/v${previous}...v${version}`
  );
  return lines.join('\n');
}

/**
 * Keep the newest {@link CHANGELOG_CAP} sections. Older ones move, byte for
 * byte and with their link references, to the top of the archive, which is
 * renamed for the newest version it holds; both "Older releases" pointers
 * follow.
 */
export function applyCap(changelog: string, archive: { path: string; text: string }): CapResult {
  const name = archive.path.split('/').pop() ?? '';
  const oldUpper = ARCHIVE_FILE.exec(name)?.[1];
  if (!oldUpper)
    throw new ReleaseCommitError(`${archive.path} is not named CHANGELOG-v0.1.0-to-vX.Y.Z.md.`);
  const lines = changelog.split('\n');
  const headings = versionHeadings(lines);
  if (headings.length <= CHANGELOG_CAP)
    return { changelog, aged: [], oldUpper, newUpper: oldUpper };
  const pointer = lines.findIndex((line) => line.startsWith('Older releases '));
  const start = headings[CHANGELOG_CAP]?.index ?? -1;
  if (pointer < start)
    throw new ReleaseCommitError('CHANGELOG.md has no "Older releases" line after its sections.');
  const aged = headings.slice(CHANGELOG_CAP).map((heading) => heading.version);
  const block = trimTrailingBlank(lines.slice(start, pointer));
  const refs = aged.flatMap((version) => lines.filter((line) => line.startsWith(`[${version}]: `)));
  const kept = [...lines.slice(0, start), ...lines.slice(pointer)].filter(
    (line) => !refs.includes(line)
  );
  const newUpper = aged[0] ?? oldUpper;
  const at = kept.findIndex((line) => line.startsWith('Older releases '));
  kept[at] = movePointer(kept[at] ?? '', oldUpper, newUpper, 'CHANGELOG.md');
  return {
    changelog: kept.join('\n'),
    aged,
    oldUpper,
    newUpper,
    archive: {
      fromPath: archive.path,
      toPath: archive.path.replace(name, `CHANGELOG-v0.1.0-to-v${newUpper}.md`),
      text: rollArchive(archive.text, block, refs, oldUpper, newUpper),
    },
  };
}

/** Every `## [X.Y.Z]` heading, newest first, with its line index. */
export function versionHeadings(lines: readonly string[]): { version: string; index: number }[] {
  return lines.flatMap((line, index) => {
    const version = VERSION_HEADING.exec(line)?.[1];
    return version ? [{ version, index }] : [];
  });
}

/** The body of one version's section (lines under its heading, trimmed). */
export function sectionBody(text: string, version: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start < 0) throw new ReleaseCommitError(`No ${version} section found.`);
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      (line.startsWith('## ') || line.startsWith('Older releases ') || /^\[[^\]]+\]: /.test(line))
  );
  const body = lines.slice(start + 1, end < 0 ? lines.length : end);
  while (body.length && !body[0]?.trim()) body.shift();
  return trimTrailingBlank(body);
}

/**
 * Rewrite `v<old>` to `v<new>` in a pointer line, refusing a line that does
 * not name the old bound (a stale pointer would otherwise be left behind).
 */
export function movePointer(
  line: string,
  oldUpper: string,
  newUpper: string,
  file: string
): string {
  const bound = new RegExp(`v${oldUpper.replaceAll('.', '\\.')}(?![0-9]|\\.[0-9])`, 'g');
  if (!bound.test(line))
    throw new ReleaseCommitError(`${file}'s "Older releases" line does not name v${oldUpper}.`);
  return line.replace(bound, `v${newUpper}`);
}

/** Drop blank lines from the end of a block. */
export function trimTrailingBlank(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && !lines[end - 1]?.trim()) end--;
  return lines.slice(0, end);
}

const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\]/;

function rollArchive(
  text: string,
  block: readonly string[],
  refs: readonly string[],
  oldUpper: string,
  newUpper: string
): string {
  const lines = text.split('\n');
  const header = `# Changelog archive: v0.1.0 – v${oldUpper}`;
  if (lines[0] !== header)
    throw new ReleaseCommitError(`The changelog archive's first line is not "${header}".`);
  lines[0] = `# Changelog archive: v0.1.0 – v${newUpper}`;
  const top = lines.findIndex((line) => VERSION_HEADING.test(line));
  if (top < 0) throw new ReleaseCommitError('The changelog archive has no version sections.');
  lines.splice(top, 0, ...block, '');
  if (refs.length) {
    const firstRef = lines.findIndex((line) => /^\[\d+\.\d+\.\d+\]: /.test(line));
    if (firstRef >= 0) lines.splice(firstRef, 0, ...refs);
    else {
      const tail = lines.at(-1) === '' ? lines.length - 1 : lines.length;
      lines.splice(tail, 0, '', ...refs);
    }
  }
  return lines.join('\n');
}

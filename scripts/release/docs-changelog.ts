/**
 * Keep the docs changelog pages in step with `CHANGELOG.md` (release.md 6.5).
 *
 * The edit is the same splice as the root file's, not a regeneration: the new
 * section goes in on top (escaped for MDX, no link references), each section
 * that aged out moves from the bottom of `docs/changelog.mdx` to the top of
 * `docs/changelog-archive.mdx` as the docs copy of it, and the pointers move.
 * A regeneration would also rewrite every older section the docs pages have
 * reworded on purpose. Afterwards the page must list exactly the versions
 * `CHANGELOG.md` keeps, or the release is refused.
 *
 * @module scripts/release/docs-changelog
 */
import {
  movePointer,
  sectionLines,
  trimTrailingBlank,
  versionHeadings,
  type CompiledSection,
} from './changelog.ts';
import { ReleaseCommitError } from './errors.ts';
import { escapeMdx } from './markdown.ts';

/** The docs changelog page. */
export const DOCS_CHANGELOG = 'docs/changelog.mdx';

/** The docs archive page. */
export const DOCS_ARCHIVE = 'docs/changelog-archive.mdx';

/** What the docs sync needs from the root changelog's edit. */
export interface DocsSyncInput {
  /** `docs/changelog.mdx` at the release point. */
  page: string;
  /** `docs/changelog-archive.mdx` at the release point. */
  archive: string;
  /** The compiled section, as `CHANGELOG.md` holds it. */
  section: CompiledSection;
  /** Versions that aged out of `CHANGELOG.md`, newest first. */
  aged: readonly string[];
  /** The archive's upper bound before the roll. */
  oldUpper: string;
  /** The archive's upper bound after the roll. */
  newUpper: string;
  /** The versions `CHANGELOG.md` keeps after the cap, newest first. */
  retained: readonly string[];
}

/** Both docs pages after the sync; `archive` is unchanged when nothing aged out. */
export interface DocsSyncResult {
  /** `docs/changelog.mdx` after the sync. */
  page: string;
  /** `docs/changelog-archive.mdx` after the sync. */
  archive: string;
}

/** Apply the release to both docs pages. */
export function syncDocsChangelog(input: DocsSyncInput): DocsSyncResult {
  const lines = input.page.split('\n');
  const top = lines.findIndex((line) => /^## \[\d+\.\d+\.\d+\]/.test(line));
  if (top < 0) throw new ReleaseCommitError(`${DOCS_CHANGELOG} has no version sections.`);
  lines.splice(top, 0, ...escapeMdx(sectionLines(input.section)), '');
  let archive = input.archive;
  if (input.aged.length) {
    const headings = versionHeadings(lines);
    const start = headings.find((heading) => heading.version === input.aged[0])?.index ?? -1;
    const pointer = lines.findIndex((line) => line.startsWith('Older releases '));
    if (start < 0 || pointer < start)
      throw new ReleaseCommitError(
        `${DOCS_CHANGELOG} has no ${input.aged[0]} section above its "Older releases" line.`
      );
    const block = trimTrailingBlank(lines.slice(start, pointer));
    lines.splice(start, pointer - start);
    const at = lines.findIndex((line) => line.startsWith('Older releases '));
    lines[at] = movePointer(lines[at] ?? '', input.oldUpper, input.newUpper, DOCS_CHANGELOG);
    archive = prependToArchive(input.archive, block, input.oldUpper, input.newUpper);
  }
  const listed = versionHeadings(lines).map((heading) => heading.version);
  if (listed.join() !== input.retained.join())
    throw new ReleaseCommitError(
      `${DOCS_CHANGELOG} would list ${listed.join(', ')}, but CHANGELOG.md keeps ${input.retained.join(', ')}.`
    );
  return { page: lines.join('\n'), archive };
}

function prependToArchive(
  text: string,
  block: readonly string[],
  oldUpper: string,
  newUpper: string
): string {
  const lines = text.split('\n');
  const top = lines.findIndex((line) => /^## \[\d+\.\d+\.\d+\]/.test(line));
  if (top < 0) throw new ReleaseCommitError(`${DOCS_ARCHIVE} has no version sections.`);
  lines.splice(top, 0, ...block, '');
  // The frontmatter description names the archive's range too.
  const description = lines.findIndex(
    (line, index) => index < top && line.startsWith('description: ')
  );
  if (description >= 0)
    lines[description] = movePointer(lines[description] ?? '', oldUpper, newUpper, DOCS_ARCHIVE);
  return lines.join('\n');
}

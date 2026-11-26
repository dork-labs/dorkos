import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Research reports are named `YYYYMMDD_topic-slug.md` (DOR-4940).
 *
 * `research/README.md` states the convention; the date in front is what lets
 * a reader see a report's age before opening it and lets the curation pass
 * sort them. This census holds every top-level entry of `research/` to it:
 *
 * - a file is a dated report, `YYYYMMDD_slug.md` (lowercase, words joined by
 *   `-` or, in older reports, `_`), or the README;
 * - a folder holds a dated report's supporting material, `YYYYMMDD_slug/`, or
 *   is one of {@link FOLDERS}.
 *
 * {@link UNDATED_NOTES} are notes from before the convention, with no date to
 * give them. The list only shrinks: each entry must still exist, so renaming
 * or removing a note means removing its entry.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const DATED_FILE = /^(\d{4})(\d{2})(\d{2})_[a-z0-9][a-z0-9_-]*\.md$/;
const DATED_FOLDER = /^(\d{4})(\d{2})(\d{2})_[a-z0-9][a-z0-9_-]*$/;

/** Folders with a layout of their own, with why. */
const FOLDERS: Record<string, string> = {
  'runtime-upgrades': 'the per-version reports the runtime-upgrade command writes',
  mesh: 'undated notes from before the convention; shrink only',
};

/** Undated notes from before the convention. Shrink only. */
const UNDATED_NOTES = [
  'anthropic-tos-compliance.md',
  'claude-code-sdk-agent-capabilities.md',
  'dorkos-config-file-system.md',
  'fumadocs-blog-research.md',
  'loop-litepaper.md',
  'mcp-tool-injection-patterns.md',
  'nanoclaw-scheduler-analysis.md',
  'openclaw-scheduler-analysis.md',
  'plan.md',
  'pulse-scheduler-design.md',
  'scheduler-comparison.md',
  'scheduling-approaches-analysis.md',
];

/** Whether a name's `YYYYMMDD` prefix is a plausible calendar date. */
function hasRealDate(match: RegExpExecArray): boolean {
  const [year = 0, month = 0, day = 0] = match.slice(1).map(Number);
  return year >= 2024 && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

/** Top-level entries of `research/`, tracked or new: files, and folders with a trailing `/`. */
function topLevelEntries(): string[] {
  const files = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'research'],
    { cwd: ROOT, encoding: 'utf8' }
  )
    .split('\n')
    .filter((file) => file && existsSync(path.join(ROOT, file)));
  const entries = files.map((file) => {
    const [, first = '', ...rest] = file.split('/');
    return rest.length > 0 ? `${first}/` : first;
  });
  return [...new Set(entries)].filter((entry) => !entry.startsWith('.')).sort();
}

/** Why an entry breaks the convention, or null when it keeps it. */
function nameProblem(entry: string): string | null {
  if (entry.endsWith('/')) {
    const folder = entry.slice(0, -1);
    if (folder in FOLDERS) return null;
    const match = DATED_FOLDER.exec(folder);
    return match && hasRealDate(match) ? null : 'is not a YYYYMMDD_slug/ folder';
  }
  if (entry === 'README.md' || UNDATED_NOTES.includes(entry)) return null;
  const match = DATED_FILE.exec(entry);
  return match && hasRealDate(match) ? null : 'is not named YYYYMMDD_topic-slug.md';
}

describe('the research names census', () => {
  const entries = topLevelEntries();

  it('read the folder, so it cannot pass on nothing', () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it('every report and folder follows YYYYMMDD_topic-slug', () => {
    const misnamed = entries.flatMap((entry) => {
      const problem = nameProblem(entry);
      return problem ? [`research/${entry} ${problem}`] : [];
    });
    expect(
      misnamed,
      'Rename with git mv (the date the research was done, then a lowercase slug) and fix every link.'
    ).toEqual([]);
  });

  it('every grandfathered note still exists, so the list only shrinks', () => {
    const gone = [
      ...UNDATED_NOTES.filter((note) => !entries.includes(note)),
      ...Object.keys(FOLDERS).filter((folder) => !entries.includes(`${folder}/`)),
    ];
    expect(gone, 'Remove these entries: the notes are gone or renamed.').toEqual([]);
  });
});

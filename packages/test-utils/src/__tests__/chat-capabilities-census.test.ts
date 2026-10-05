/**
 * The chat capabilities census — the pin between
 * `contributing/capabilities/chat.md` and the tests it says cover each row
 * (DOR-2723). The third census of its kind, after the Harness Sync one
 * (`packages/harness/src/__tests__/capabilities-census.test.ts`) and the
 * runtime one (`apps/server/src/services/runtimes/__tests__/runtime-capability-census.test.ts`);
 * `contributing/capabilities/README.md` describes the shared pattern.
 *
 * The document's Coverage cells are prose, and prose drifts: a cell names a
 * test file that was renamed, or claims `U` for a test nobody wrote. This test
 * asserts:
 *
 * 1. it parsed a plausible number of rows and test titles (floors, so a broken
 *    parser cannot pass on nothing);
 * 2. every row id is unique;
 * 3. every test file a Coverage cell cites still exists;
 * 4. no test title claims a chat id the document does not define;
 * 5. every row claiming `U` or `E` coverage has a test whose title starts with
 *    its id — except the rows in {@link PENDING_TITLES}, which is held by exact
 *    equality, so it can only shrink: a new row needs a titled test, and a row
 *    that gains one must leave the list;
 * 6. no row whose State says `not built` has a test claiming it.
 *
 * A title claims rows by starting with their ids, separated by commas or
 * slashes, then a colon: `C-07: …`, `CN-04/CN-06: …`. An id anywhere else is a
 * mention, not a claim. Comments are blanked first by the repo's shared
 * stripper, and `.skip`/`.todo`/`.only` titles do not count.
 *
 * ## When this fails, what to do
 *
 * - **"cites a test file that is not there"** — the file moved or was deleted.
 *   Fix the Coverage cell.
 * - **"names an id the document does not define"** — a row was renamed or
 *   removed, or the title has a typo.
 * - **"claims U or E and no test title names it"** — prefix the title of the
 *   test that covers the row with its id, or correct the Coverage cell.
 * - **"must leave PENDING_TITLES"** — a row gained a titled test. Delete it from
 *   the list.
 *
 * @module test-utils/__tests__/chat-capabilities-census
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lexWithoutComments } from '../../../../scripts/lib/code-only.mjs';

/** The repository root, four levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../..');

/** The contract this census pins. */
const CONTRACT = 'contributing/capabilities/chat.md';

/** A chat row id: one of the document's prefixes, two digits, maybe a letter. */
const CHAT_ID = /^(?:A|C|CN|I|L|M|R|X)-\d{2}[a-z]?$/;

/** The ids a title claims at its very start. */
const TITLE_ID_PREFIX =
  /^((?:A|C|CN|I|L|M|R|X)-\d{2}[a-z]?(?:\s*[,/]\s*(?:A|C|CN|I|L|M|R|X)-\d{2}[a-z]?)*)\s*:/;

/** Where chat tests live, and which files under each are tests. */
const TEST_ROOTS: readonly { dir: string; match: RegExp }[] = [
  { dir: 'apps/client/src', match: /\.test\.tsx?$/ },
  { dir: 'apps/server/src', match: /\.test\.ts$/ },
  { dir: 'apps/e2e/tests', match: /\.ts$/ },
  { dir: 'packages', match: /\.test\.tsx?$/ },
];

/**
 * Rows that claim `U` or `E` coverage and that no test title names yet, as of
 * DOR-2723. The Coverage cells of most of these cite test files rather than
 * ids, which is what the document did before it had a census. Held by exact
 * equality: titling a test for one of these rows (`C-07: …`) must remove it
 * from this list, and no row may join it.
 */
// prettier-ignore
const PENDING_TITLES: readonly string[] = [
  'A-01',
  'C-02', 'C-03',
  'R-03', 'R-09',
];

/** One parsed capability row. */
interface Row {
  /** The row's id (`C-07`). */
  id: string;
  /** The Coverage (or Verifies, or Deterministic evidence) cell, verbatim. */
  coverage: string;
  /** The State cell, verbatim, when the table has one. */
  state: string;
}

/**
 * Every capability row in the contract. A row is a table line whose first cell
 * is a chat id; its coverage is whichever of the document's three evidence
 * columns its table has.
 */
function parseContract(): Row[] {
  const rows: Row[] = [];
  let header: string[] | null = null;
  for (const line of readFileSync(join(ROOT, CONTRACT), 'utf8').split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
    if (header === null) {
      header = cells;
      continue;
    }
    const id = cells[0] ?? '';
    if (!CHAT_ID.test(id)) continue;
    const evidence = ['Coverage', 'Verifies', 'Deterministic evidence']
      .map((name) => header!.indexOf(name))
      .find((index) => index >= 0);
    const state = header.indexOf('State');
    rows.push({
      id,
      coverage: evidence === undefined ? '' : (cells[evidence] ?? ''),
      state: state >= 0 ? (cells[state] ?? '') : '',
    });
  }
  return rows;
}

/** Every test file under the roots, repo-relative and sorted. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, match: RegExp): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, match);
      else if (entry.isFile() && match.test(entry.name)) found.push(rel);
    }
  };
  for (const root of TEST_ROOTS) walk(root.dir, root.match);
  return found.sort();
}

/** Every runnable `it(…)`/`test(…)` title in comment-blanked source. */
function titlesIn(source: string): string[] {
  const call =
    /(?<![.\w$])(?:it|test)((?:\.\w+(?:\([^)]*\))?)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)/g;
  const found: string[] = [];
  for (const match of source.matchAll(call)) {
    if (/\.(?:skip|todo|only)\b/.test(match[1] ?? '')) continue;
    found.push(match[3] ?? '');
  }
  return found;
}

/** The chat ids a title claims, from its prefix only. */
function idsClaimedBy(title: string): string[] {
  const prefix = TITLE_ID_PREFIX.exec(title);
  return prefix ? (prefix[1] ?? '').split(/[,/]/).map((id) => id.trim()) : [];
}

/** Whether a Coverage cell claims a deterministic tier. */
function claimsDeterministic(coverage: string): boolean {
  return /\b[UE]\b/.test(coverage);
}

/** The test files a Coverage cell cites, in backticks. */
function citedTestFiles(coverage: string): string[] {
  return [...coverage.matchAll(/`([\w./@-]+\.(?:test|spec)\.tsx?)`/g)].map((match) => match[1]!);
}

const rows = parseContract();
const files = testFiles();
const lexed = files.map((file) => ({
  file,
  ...lexWithoutComments(readFileSync(join(ROOT, file), 'utf8'), file),
}));
const titles = lexed.flatMap(({ file, code }) => titlesIn(code).map((text) => ({ file, text })));
const claimed = new Set(titles.flatMap((title) => idsClaimedBy(title.text)));
const documented = new Set(rows.map((row) => row.id));

describe('the chat capabilities census', () => {
  it('parsed the document and the suites, so nothing below can pass on nothing', () => {
    // Floors at roughly 90% of what DOR-2723 parsed (111 rows).
    expect(rows.length).toBeGreaterThanOrEqual(100);
    expect(files.length).toBeGreaterThanOrEqual(1000);
    expect(titles.length).toBeGreaterThanOrEqual(10_000);
    expect(lexed.filter((entry) => entry.parseErrors > 0).map((entry) => entry.file)).toEqual([]);
  });

  it('defines every row id once', () => {
    const ids = rows.map((row) => row.id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
  });

  it('cites only test files that are still there', () => {
    const missing: string[] = [];
    for (const row of rows) {
      for (const cited of citedTestFiles(row.coverage)) {
        if (!files.some((file) => file === cited || file.endsWith(`/${cited}`))) {
          missing.push(`${row.id}: ${cited}`);
        }
      }
    }
    expect(
      missing,
      `${CONTRACT} cites a test file that is not there. Fix the Coverage cell.`
    ).toEqual([]);
  });

  it('names no chat id the document does not define', () => {
    const unknown = [...claimed].filter((id) => !documented.has(id)).sort();
    expect(unknown, `A test title names a row ${CONTRACT} does not have.`).toEqual([]);
  });

  it('has a titled test for every row that claims U or E, except the pending ones', () => {
    const untitled = rows
      .filter((row) => claimsDeterministic(row.coverage) && !claimed.has(row.id))
      .map((row) => row.id)
      .sort();
    expect(
      untitled,
      'These rows claim U or E coverage and no test title starts with their id. Title the test ' +
        '("C-07: …"), or correct the Coverage cell. A row that gained a title must leave ' +
        'PENDING_TITLES; no row may join it.'
    ).toEqual([...PENDING_TITLES].sort());
  });

  it('is rerun when only the document or a foreign test changes', () => {
    // None of what this reads outside test-utils is in its default turbo
    // inputs; without the override an edit there replays a cached green
    // (ci/ledger 261005-194801).
    const turbo = JSON.parse(readFileSync(join(ROOT, 'turbo.json'), 'utf8')) as {
      tasks: Record<string, { inputs?: string[] }>;
    };
    const inputs = turbo.tasks['@dorkos/test-utils#test']?.inputs ?? [];
    expect(inputs).toEqual(
      expect.arrayContaining([
        '$TURBO_DEFAULT$',
        `$TURBO_ROOT$/${CONTRACT}`,
        '$TURBO_ROOT$/scripts/lib/code-only.mjs',
      ])
    );
    for (const root of TEST_ROOTS) {
      expect({
        root: root.dir,
        covered: inputs.some((input) => input.includes(`$TURBO_ROOT$/${root.dir}`)),
      }).toEqual({
        root: root.dir,
        covered: true,
      });
    }
  });

  it('lets no row stay marked not built once a test claims it', () => {
    const contradicted = rows
      .filter((row) => /^\**not built\b/i.test(row.state.trimStart()) && claimed.has(row.id))
      .map((row) => row.id);
    expect(
      contradicted,
      'These rows say the capability is not built, and a test title claims them. Update the State cell.'
    ).toEqual([]);
  });
});

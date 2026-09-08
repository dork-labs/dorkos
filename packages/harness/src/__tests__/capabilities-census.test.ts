/**
 * The capabilities census — the pin between `meta/harness-sync-capabilities.md`
 * and the suite that is supposed to be checking it.
 *
 * The contract lists every capability this engine has, with a State and a
 * Coverage cell per row. Those cells are prose, and prose rots: a row can claim
 * `U` coverage for a test that was deleted, renamed, or never written, and
 * nothing anywhere notices. This test makes the claim structural. It parses the
 * document's tables and every `it()`/`test()` title under the four roots that
 * test this engine, and asserts they agree:
 *
 * 1. it parsed a plausible number of rows and titles (a literal floor, so a
 *    broken parser cannot pass on nothing);
 * 2. every row claiming `U`, `C` or `E` coverage has at least one test title
 *    carrying its ID;
 * 3. every row whose State begins `built` has a Coverage cell that is not `—`;
 * 4. every ID that appears in a title exists in the document;
 * 5. every gap §14 has struck through as closed has a test title naming it.
 *
 * ## When this fails, what to do
 *
 * - **"no test title carries its id"** — either add the row's ID to the title of
 *   the test that really covers it (`it('SK-04: …')`), or, if no test does, fix
 *   the Coverage cell. The cell is a claim; this is what makes it one.
 * - **"names an ID the document does not"** — you renamed or removed a row.
 *   Update the titles, or put the row back.
 * - **"is `built` with no coverage"** — a capability shipped without a test. Add
 *   one, or say `—` honestly in the State cell too.
 *
 * ## The one thing this cannot do on its own
 *
 * `pnpm verify` is affected-only, so a `meta/`-only edit runs nothing; T8 lives
 * in the harness package so an engine edit reaches it, and a doc-only edit needs
 * `pnpm vitest run packages/harness/src/__tests__/capabilities-census.test.ts`
 * by hand (`plans/harness-sync-test-plan.md` §12). What reaches it without being
 * asked is the merge queue's full monorepo sweep, and the
 * `"@dorkos/harness#test"` `inputs` override in `turbo.json` is what stops that
 * sweep replaying a cached green after the document or a foreign test title
 * changed — `turbo-census-inputs.test.ts` beside this file guards the override.
 *
 * @module __tests__/capabilities-census
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repository root, four levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../..');

/** The contract this census pins the suite against. */
const CONTRACT = 'meta/harness-sync-capabilities.md';

/**
 * The roots that test this engine.
 *
 * The test plan's T8 named three; the fourth is the pair of Codex skill readers
 * (`scan-skill-commands`, `skill-parity`), which is where SK-08's frontmatter
 * dialect and J-15's parity promise are actually asserted — the contract's own
 * §15 counts them as part of this surface, and leaving them out would have meant
 * calling SK-08 uncovered while its tests sat six directories away.
 *
 * Three of the four are in other packages or other services, which is the whole
 * reason the turbo `inputs` override exists: without it a renamed title in any
 * of them would replay a cached green here.
 *
 * `least` is a floor per root, so a directory that moves or a file that is
 * renamed out of a pattern is a red rather than a quietly smaller census.
 */
const TEST_ROOTS = [
  { dir: 'packages/harness/src', match: /\.test\.ts$/, least: 40 },
  { dir: 'apps/server/src/services/harness/__tests__', match: /\.test\.ts$/, least: 9 },
  { dir: 'packages/cli/src/__tests__', match: /^harness-sync.*\.test\.ts$/, least: 2 },
  {
    dir: 'apps/server/src/services/runtimes/codex/__tests__',
    match: /^(?:scan-skill-commands|skill-parity)\.test\.ts$/,
    least: 2,
  },
] as const;

/**
 * A capability ID as the document's tables spell it: two or three letters, a
 * hyphen, two digits (`SK-04`, `AP-11`, `SRC-02`).
 *
 * The journey table's `J-NN` ids are deliberately NOT this shape — they carry no
 * State or Coverage cell, so they are parsed separately and take part only in
 * "every ID in a title exists in the document".
 */
const ROW_ID = /^[A-Z]{2,3}-\d{2}$/;

/** A journey id, as §12's table spells it. */
const JOURNEY_ID = /^J-\d{2}$/;

/** Any capability or journey id, as a test title would spell it. */
const ANY_ID = /\b[A-Z]{1,3}-\d{2}\b/g;

/** One parsed capability row. */
interface Row {
  /** The row's ID (`SK-04`). */
  id: string;
  /** The section heading it was found under, for a failure message. */
  section: string;
  /** The State cell, verbatim. */
  state: string;
  /** The Coverage cell, verbatim. */
  coverage: string;
}

/** One parsed test title, with the file it came from. */
interface Title {
  /** Repo-relative path of the test file. */
  file: string;
  /** The literal title text (a template literal contributes its literal prefix). */
  text: string;
}

/**
 * Every markdown table row in the contract, tagged with its section and header.
 *
 * A tiny hand-rolled reader rather than a markdown dependency: the shape is
 * `| a | b |` lines under a `##` heading, and this file must stay stdlib-only.
 *
 * @returns the capability rows and the journey rows, parsed separately.
 */
function parseContract(): { rows: Row[]; journeys: string[] } {
  const doc = readFileSync(join(ROOT, CONTRACT), 'utf8');
  const rows: Row[] = [];
  const journeys: string[] = [];
  let section = '';
  let header: string[] | null = null;

  for (const line of doc.split('\n')) {
    if (line.startsWith('#')) {
      section = line.replace(/^#+\s*/, '').trim();
      header = null;
      continue;
    }
    if (!line.trimStart().startsWith('|')) {
      header = null;
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    // The `|---|---|` separator under a header.
    if (cells.every((cell) => /^-{3,}$/.test(cell))) continue;
    if (header === null) {
      header = cells;
      continue;
    }
    const id = cells[0] ?? '';
    if (JOURNEY_ID.test(id)) journeys.push(id);
    if (!ROW_ID.test(id)) continue;
    const state = header.indexOf('State');
    const coverage = header.indexOf('Coverage');
    // A table of ids with no State/Coverage pair is not a capability table.
    if (state === -1 || coverage === -1) continue;
    rows.push({
      id,
      section,
      state: cells[state] ?? '',
      coverage: cells[coverage] ?? '',
    });
  }
  return { rows, journeys };
}

/**
 * The ids §14 has struck through as closed gaps.
 *
 * A closed gap is one somebody fixed, so every row it names should now be
 * reachable from a test title. Only the text INSIDE the `~~…~~` span counts —
 * the sentence after it explains what remains open and names rows that are still
 * gaps.
 *
 * @returns every capability or journey id inside a strikethrough span in §14.
 */
function closedGapIds(): string[] {
  const doc = readFileSync(join(ROOT, CONTRACT), 'utf8');
  const section = doc.slice(doc.indexOf('## 14.'), doc.indexOf('## 15.'));
  const found = new Set<string>();
  for (const span of section.matchAll(/~~(.+?)~~/gs)) {
    for (const id of (span[1] ?? '').matchAll(ANY_ID)) found.add(id[0]);
  }
  return [...found].sort();
}

/** Every `.test.ts` file under a root, recursively, repo-relative and sorted. */
function testFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string, match: RegExp): void => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, match);
      else if (entry.isFile() && match.test(entry.name)) found.push(rel);
    }
  };
  for (const root of TEST_ROOTS) walk(root.dir, root.match);
  return found.sort();
}

/**
 * Every `it(…)` / `test(…)` title in a file, by reading its source.
 *
 * Source text rather than a real run, because the point is to read EVERY title
 * including the ones behind a `skipIf` or an `each`, and because a census that
 * had to execute two other packages' suites would be a different kind of thing
 * entirely. A template literal contributes its literal prefix, which is enough:
 * the ids this census looks for are written by hand at the front of a title.
 *
 * @param source - the file's text.
 * @returns each title's literal text, in source order.
 */
export function titlesIn(source: string): string[] {
  const call =
    /(?<![.\w$])(?:it|test)(?:\.\w+(?:\([^)]*\))?)*\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)/g;
  return [...source.matchAll(call)].map((match) => match[2] ?? '');
}

const { rows, journeys } = parseContract();
const files = testFiles();
const titles: Title[] = files.flatMap((file) =>
  titlesIn(readFileSync(join(ROOT, file), 'utf8')).map((text) => ({ file, text }))
);

/** Every id named by at least one test title. */
const idsInTitles = new Set(
  titles.flatMap((title) => [...title.text.matchAll(ANY_ID)].map((m) => m[0]))
);

/** Every id the document defines, capability rows and journeys alike. */
const documentedIds = new Set([...rows.map((row) => row.id), ...journeys]);

/** Whether a Coverage cell claims a deterministic, CI-able tier. */
function claimsCoverage(coverage: string): boolean {
  return /\b[UCE]\b/.test(coverage);
}

/**
 * Rows whose test exists but whose TITLE could not be edited in the pass that
 * built this census, pinned by exact equality so the list cannot grow quietly.
 *
 * IN-05's three cases live in `apply/__tests__/dangling-targets.test.ts`, and
 * DOR-1889 held that directory open while DOR-1848 landed — retitling a file
 * another branch is rewriting buys a merge conflict and loses whichever side
 * rebases. The entry comes out with a one-line edit the moment that branch
 * lands: put `IN-05: ` in front of the three titles there, and delete this.
 */
const PENDING_RETITLE: readonly string[] = ['IN-05'];

describe('the harness capabilities census', () => {
  it('parsed the document and the suites, so nothing below can pass on nothing', () => {
    // Floors at roughly 90% of what was parsed on 2026-09-08 (96 rows, 15
    // journeys, 66 files, 617 titles). They exist because every other assertion
    // in this file quantifies over these lists: a parser that silently matched
    // nothing would report a perfectly consistent document.
    expect(rows.length).toBeGreaterThanOrEqual(86);
    expect(journeys.length).toBeGreaterThanOrEqual(14);
    expect(files.length).toBeGreaterThanOrEqual(59);
    expect(titles.length).toBeGreaterThanOrEqual(555);
    // And every root really contributed, so a moved directory is a red rather
    // than a quietly smaller census.
    for (const root of TEST_ROOTS) {
      const found = files.filter((file) => file.startsWith(root.dir)).length;
      expect({ root: root.dir, found: found >= root.least }).toEqual({
        root: root.dir,
        found: true,
      });
    }
  });

  it('has a test title carrying the ID of every row that claims U, C or E coverage', () => {
    const claiming = rows.filter((row) => claimsCoverage(row.coverage));
    expect(claiming.length).toBeGreaterThanOrEqual(50);

    const uncovered = claiming.filter((row) => !idsInTitles.has(row.id)).map((row) => row.id);

    // Exact equality, not a subset: a row that gains a title must leave the
    // pending list, and a row that loses one must not join it silently.
    expect(
      uncovered,
      `These rows claim a test tier and no test title names them, so the claim is unverifiable.\n` +
        `Put the ID at the front of the title of the test that covers it — it('${'SK-04'}: …') — ` +
        `or correct the Coverage cell in ${CONTRACT}.`
    ).toEqual(PENDING_RETITLE);
  });

  it('gives every built row a coverage cell that says something', () => {
    const built = rows.filter((row) =>
      row.state.replace(/\*/g, '').trimStart().startsWith('built')
    );
    expect(built.length).toBeGreaterThanOrEqual(45);

    const uncovered = built.filter((row) => row.coverage.replace(/\*/g, '').trim() === '—');

    expect(
      uncovered.map((row) => `${row.id}: ${row.state.slice(0, 80)}`),
      `A capability that shipped with no test is a capability nobody will notice breaking.`
    ).toEqual([]);
  });

  it('names no ID the document does not define', () => {
    expect(idsInTitles.size).toBeGreaterThanOrEqual(40);

    const unknown = [...idsInTitles]
      .filter((id) => !documentedIds.has(id))
      .map((id) => {
        const where = titles.filter((title) => title.text.includes(id)).map((title) => title.file);
        return `${id} (in ${[...new Set(where)].join(', ')})`;
      });

    expect(
      unknown.sort(),
      `A test title names a row ${CONTRACT} does not have — the row was renamed or removed, ` +
        `or the title has a typo.`
    ).toEqual([]);
  });

  it('has a test for every gap §14 struck through as closed', () => {
    const closed = closedGapIds();
    expect(closed.length).toBeGreaterThanOrEqual(12);

    const unproven = closed.filter(
      (id) => documentedIds.has(id) && !idsInTitles.has(id) && !PENDING_RETITLE.includes(id)
    );

    expect(
      unproven,
      `§14 says these gaps are closed. A closed gap has a test, and that test's title says which.`
    ).toEqual([]);
  });
});

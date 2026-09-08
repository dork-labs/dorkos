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
 * 3. every row whose State begins `built` has a Coverage cell that says
 *    something;
 * 4. **the reverse** — no row still marked `not built` or `silent` has a test
 *    title claiming it, unless {@link PINNED_GAPS} says why;
 * 5. every ID that appears in a title exists in the document;
 * 6. every gap §14 has struck through as closed has a test title naming it.
 *
 * ## Three ways this could be silenced, and what stops each
 *
 * - **A title in a COMMENT.** Titles are read out of source text, so the
 *   example `it('XX-04: …')` in a docstring — this one — used to count as
 *   coverage for XX-04. Deleting every real test for a row and leaving a
 *   comment mentioning it passed. Comments are now blanked first, by the repo's
 *   one shared stripper (`scripts/lib/code-only.mjs`, `lexWithoutComments`,
 *   which keeps literals precisely because the subject lives inside one), and
 *   every example ID in this file names a row the document does not have, so a
 *   stripper regression reds assertion 5 rather than passing quietly.
 * - **A title the runner never runs.** `it.skip`, `it.todo`, `it.only` and an
 *   `it.each([])` over an empty table are not coverage, and are not counted.
 * - **An ID mentioned in passing.** `it('see SK-01.md for why')` is not a claim
 *   about SK-01. An ID counts only as the title's PREFIX — `SK-01: …` or
 *   `J-09, AP-05: …` — which is the retitle convention anyway.
 *
 * ## When this fails, what to do
 *
 * - **"no test title carries its id"** — either put the row's ID at the front
 *   of the title of the test that really covers it, or, if no test does, fix
 *   the Coverage cell. The cell is a claim; this is what makes it one.
 * - **"names an ID the document does not"** — you renamed or removed a row.
 *   Update the titles, or put the row back.
 * - **"is `built` with no coverage"** — a capability shipped without a test.
 * - **"is marked broken and has a test"** — somebody fixed a row and left the
 *   document saying it is broken. Flip the State cell and cite the test. If the
 *   test deliberately PINS the gap rather than closing it, add the row to
 *   {@link PINNED_GAPS} with the reason.
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
import { lexWithoutComments } from '../../../../scripts/lib/code-only.mjs';

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

/**
 * The ID prefix a test title claims its rows with: one or more ids, comma
 * separated, then a colon.
 *
 * Anchored at the start on purpose. An id anywhere else in a title is a
 * mention, not a claim — `it('see SK-01.md for why')` says nothing about
 * SK-01's coverage — and an anchored form is also the convention every retitled
 * test in this repo follows, so nothing is lost by requiring it.
 */
const TITLE_ID_PREFIX = /^([A-Z]{1,3}-\d{2}(?:\s*,\s*[A-Z]{1,3}-\d{2})*)\s*:/;

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
 * Rows the document still marks broken that a test title DOES name, on purpose.
 *
 * The reverse assertion exists so a fixed row cannot stay marked broken — four
 * rows were, and three of them contradicted tests in this very suite. A row
 * belongs here only when the test covers the HONEST FAILURE rather than the
 * capability: the drop, the reason, the refusal. Each entry says which, because
 * the difference between "we tested that it works" and "we tested that it does
 * not, and says so" is the whole point of the row's State cell.
 */
const PINNED_GAPS: Readonly<Record<string, string>> = {
  'SRC-04':
    'a global install is not projected; the test asserts the DROP, as the row’s own Coverage cell says',
  'SRC-10':
    'adopt does not exist; the test pins only that `adopted` counts as ephemeral provenance',
  'CM-06':
    'nothing writes into Cursor’s or Gemini’s command dirs; the test asserts each drop names the format it is not writing to',
};

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
 * The §14 slice of the contract, bounded at BOTH ends.
 *
 * `indexOf` answers -1 for a heading that was renamed, and an unchecked -1 turns
 * `slice(start, -1)` into "almost the whole document" — which would silently
 * widen the closed-gap check to every strikethrough anywhere. Both markers are
 * required, and so is their order.
 *
 * @returns the text between the §14 and §15 headings.
 */
function gapSection(): string {
  const doc = readFileSync(join(ROOT, CONTRACT), 'utf8');
  const start = doc.indexOf('## 14.');
  const end = doc.indexOf('## 15.');
  expect({ start: start >= 0, end: end >= 0, ordered: start < end }).toEqual({
    start: true,
    end: true,
    ordered: true,
  });
  return doc.slice(start, end);
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
  const found = new Set<string>();
  for (const span of gapSection().matchAll(/~~(.+?)~~/gs)) {
    for (const id of (span[1] ?? '').matchAll(/\b[A-Z]{1,3}-\d{2}\b/g)) found.add(id[0]);
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
 * Every `it(…)` / `test(…)` title in a file whose case the runner will actually
 * run, read from source with comments already blanked.
 *
 * Source text rather than a real run, because the point is to read EVERY title
 * including the ones behind a `skipIf`, and because a census that had to execute
 * two other packages' suites would be a different kind of thing entirely. A
 * template literal contributes its literal prefix, which is enough: an ID is
 * written by hand at the front of a title.
 *
 * Three modifier chains are excluded. `.skip`, `.todo` and `.only` never assert
 * anything about the row (the last one because it silences its neighbours, which
 * is the opposite of coverage). `.each` over an EMPTY array literal runs zero
 * cases, so its title is a claim about a table nobody filled in; a non-empty
 * `.each` is real coverage and counts.
 *
 * @param source - the file's text, comments already blanked.
 * @returns each runnable title's literal text, in source order.
 */
function titlesIn(source: string): string[] {
  const call =
    /(?<![.\w$])(?:it|test)((?:\.\w+(?:\([^)]*\))?)*)\s*\(\s*(['"`])((?:\\.|(?!\2)[^\\])*)/g;
  const found: string[] = [];
  for (const match of source.matchAll(call)) {
    const modifiers = match[1] ?? '';
    if (/\.(?:skip|todo|only)\b/.test(modifiers)) continue;
    if (/\.each\s*\(\s*\[\s*\]\s*\)/.test(modifiers)) continue;
    found.push(match[3] ?? '');
  }
  return found;
}

/**
 * The row ids a title claims, from its prefix only.
 *
 * @param title - one test title.
 * @returns the ids it claims, or an empty list when it claims none.
 */
function idsClaimedBy(title: string): string[] {
  const prefix = TITLE_ID_PREFIX.exec(title);
  return prefix ? (prefix[1] ?? '').split(',').map((id) => id.trim()) : [];
}

const { rows, journeys } = parseContract();
const files = testFiles();
const lexed = files.map((file) => ({
  file,
  ...lexWithoutComments(readFileSync(join(ROOT, file), 'utf8'), file),
}));
const titles: Title[] = lexed.flatMap(({ file, code }) =>
  titlesIn(code).map((text) => ({ file, text }))
);

/** Every id claimed by at least one test title's prefix. */
const idsInTitles = new Set(titles.flatMap((title) => idsClaimedBy(title.text)));

/** Every id the document defines, capability rows and journeys alike. */
const documentedIds = new Set([...rows.map((row) => row.id), ...journeys]);

/** A Coverage cell that says nothing, whether it says it with a dash or with nothing. */
function claimsNoCoverage(coverage: string): boolean {
  const cell = coverage.replace(/\*/g, '').trim();
  return cell === '' || cell === '—' || cell === '-';
}

/** Whether a Coverage cell claims a deterministic, CI-able tier. */
function claimsCoverage(coverage: string): boolean {
  return /\b[UCE]\b/.test(coverage);
}

/** Whether a State cell still says the capability does not work. */
function statesBroken(state: string): boolean {
  return /^(?:not built|silent)\b/.test(state.replace(/\*/g, '').trimStart().toLowerCase());
}

describe('the harness capabilities census', () => {
  it('parsed the document and the suites, so nothing below can pass on nothing', () => {
    // Floors at roughly 90% of what was parsed on 2026-09-08 (96 rows, 15
    // journeys, 66 files, 616 runnable titles, 80 distinct ids claimed). They
    // exist because every other assertion in this file quantifies over these
    // lists: a parser that silently matched nothing would report a perfectly
    // consistent document.
    expect(rows.length).toBeGreaterThanOrEqual(86);
    expect(journeys.length).toBeGreaterThanOrEqual(14);
    expect(files.length).toBeGreaterThanOrEqual(59);
    expect(titles.length).toBeGreaterThanOrEqual(554);
    // And every root really contributed, so a moved directory is a red rather
    // than a quietly smaller census.
    for (const root of TEST_ROOTS) {
      const found = files.filter((file) => file.startsWith(root.dir)).length;
      expect({ root: root.dir, found: found >= root.least }).toEqual({
        root: root.dir,
        found: true,
      });
    }
    // A file TypeScript could not lex is a file whose comments were not blanked,
    // which is the exact hole assertion 1 in the header is about.
    expect(lexed.filter((entry) => entry.parseErrors > 0).map((entry) => entry.file)).toEqual([]);
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
        `Prefix the title of the test that covers it with the row id ("XX-04: …"), or correct ` +
        `the Coverage cell in ${CONTRACT}.`
    ).toEqual(PENDING_RETITLE);
  });

  it('gives every built row a coverage cell that says something', () => {
    const built = rows.filter((row) =>
      row.state.replace(/\*/g, '').trimStart().startsWith('built')
    );
    expect(built.length).toBeGreaterThanOrEqual(45);

    const uncovered = built.filter((row) => claimsNoCoverage(row.coverage));

    expect(
      uncovered.map((row) => `${row.id}: ${row.state.slice(0, 80)}`),
      `A capability that shipped with no test is a capability nobody will notice breaking. ` +
        `An EMPTY cell counts as no coverage — it is the least-effort way to silence the line above.`
    ).toEqual([]);
  });

  it('lets no row stay marked broken once a test claims it', () => {
    // The reverse of the assertion above, and the one that catches the OTHER
    // drift: a row fixed months ago whose State cell still says it is broken is
    // exempt from every check here, because a row that claims nothing is asked
    // nothing. Four of them were (HK-01, HK-11, SK-14, AP-14) and three
    // contradicted tests in this very suite.
    const broken = rows.filter((row) => statesBroken(row.state));
    expect(broken.length).toBeGreaterThanOrEqual(5);

    const contradicted = broken
      .filter((row) => idsInTitles.has(row.id) && !(row.id in PINNED_GAPS))
      .map((row) => `${row.id}: ${row.state.slice(0, 70)}`);

    expect(
      contradicted,
      `These rows say the capability does not work, and a test title claims it. Either flip the ` +
        `State cell and cite the test, or — if the test PINS the gap rather than closing it — ` +
        `add the row to PINNED_GAPS with the reason.`
    ).toEqual([]);
  });

  it('names no ID the document does not define', () => {
    expect(idsInTitles.size).toBeGreaterThanOrEqual(72);

    const unknown = [...idsInTitles]
      .filter((id) => !documentedIds.has(id))
      .map((id) => {
        const where = titles
          .filter((title) => idsClaimedBy(title.text).includes(id))
          .map((title) => title.file);
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

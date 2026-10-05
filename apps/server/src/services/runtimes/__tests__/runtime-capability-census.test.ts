/**
 * The runtime capabilities census — the pin between the matrix in
 * `packages/test-utils/src/runtime-capability-matrix.ts` and the tests that are
 * supposed to prove it (DOR-2720). Modeled on the Harness Sync census
 * (`packages/harness/src/__tests__/capabilities-census.test.ts`).
 *
 * A cell's status and evidence are claims. This test makes them structural:
 *
 * 1. it parsed a plausible number of rows and test titles (literal floors, so a
 *    broken parser cannot pass on nothing);
 * 2. every cell claiming `U` evidence has a test that runs for THAT runtime
 *    whose title starts with the row id or one of the row's conformance ids;
 * 3. no test title names an `RT-` id the registry does not have;
 * 4. no test in a runtime's own folder claims a cell marked `planned`,
 *    `not-supported` or `n/a` — a fixed cell has to be promoted;
 * 5. a row with a declared flag agrees with every runtime's declared
 *    capabilities: declared true is a cell that has it, declared false is one
 *    that does not;
 * 6. every cell but `supported` says why, and every `planned` cell names its
 *    ticket;
 * 7. `contributing/runtime-capabilities.md` is exactly what the registry
 *    renders.
 *
 * ## Which tests count for which runtime
 *
 * A title in a runtime's own folder (`services/runtimes/<runtime>/`) counts for
 * that runtime. A title in the shared conformance suite counts for every
 * runtime whose `conformance.test.ts` runs it — all four today, against a
 * mocked backend, so every case is CI-deterministic.
 *
 * **The one thing this cannot see:** a conformance case that skips itself for
 * a runtime (a driver it was not given, a capability it does not declare)
 * still counts for that runtime here, because the census reads source rather
 * than results. Rule 5 closes most of the gap — a case gated on a flag runs for
 * every runtime the flag says has the capability — and the matrix was checked
 * against a real run of the four conformance suites when each row was written.
 *
 * ## When this fails, what to do
 *
 * - **"no test proves it"** — put the row id at the front of the title of the
 *   test that really proves it (`RT-SES-03: …`), or mark the cell `unverified`.
 * - **"names an id the matrix does not have"** — a row was renamed or removed.
 * - **"claims a cell the matrix says it lacks"** — somebody built it. Promote
 *   the cell.
 * - **"disagrees with the declared flag"** — the runtime's `runtime-constants.ts`
 *   and the matrix say different things. One of them is wrong.
 * - **"is stale"** — run `pnpm docs:runtime-capabilities`.
 *
 * @module services/runtimes/__tests__/runtime-capability-census
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import {
  HAS_CAPABILITY,
  MATRIX_RUNTIMES,
  RUNTIME_CAPABILITIES,
  renderRuntimeCapabilityMatrix,
  type MatrixRuntime,
} from '@dorkos/test-utils/runtime-capability-matrix';
import { lexWithoutComments } from '../../../../../../scripts/lib/code-only.mjs';
import { CLAUDE_CODE_CAPABILITIES } from '../claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../test-mode/runtime-constants.js';

/** The repository root, six levels above this file. */
const ROOT = resolve(import.meta.dirname, '../../../../../..');

/** The shared conformance suite every runtime runs. */
const CONFORMANCE = 'packages/test-utils/src/runtime-conformance.ts';

/** The generated document. */
const DOC = 'contributing/runtime-capabilities.md';

/** Each runtime's declared capabilities, which flag-backed rows must agree with. */
const DECLARED: Readonly<Record<MatrixRuntime, RuntimeCapabilities>> = {
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  opencode: OPENCODE_CAPABILITIES,
  'test-mode': TEST_MODE_CAPABILITIES,
};

/**
 * The ids a title claims: one or more, comma separated, then a colon, at the
 * very start. An id anywhere else in a title is a mention, not a claim.
 */
const TITLE_ID_PREFIX =
  /^((?:RT-[A-Z]+-\d{2}|[CI]\d{1,2})(?:\s*,\s*(?:RT-[A-Z]+-\d{2}|[CI]\d{1,2}))*)\s*:/;

/**
 * Every runnable `it(…)`/`test(…)` title in a source text whose comments are
 * already blanked. `.skip`, `.todo` and `.only` are not coverage.
 */
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

/** The ids a title claims, from its prefix only. */
function idsClaimedBy(title: string): string[] {
  const prefix = TITLE_ID_PREFIX.exec(title);
  return prefix ? (prefix[1] ?? '').split(',').map((id) => id.trim()) : [];
}

/** Every `.test.ts` file under a folder, recursively, repo-relative. */
function testFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...testFiles(rel));
    else if (entry.isFile() && entry.name.endsWith('.test.ts')) found.push(rel);
  }
  return found;
}

/** Reads a file and returns its runnable titles, comments blanked first. */
function titlesOf(file: string): { titles: string[]; parseErrors: number } {
  const { code, parseErrors } = lexWithoutComments(readFileSync(join(ROOT, file), 'utf8'), file);
  return { titles: titlesIn(code), parseErrors };
}

const runtimeDir = (runtime: MatrixRuntime) => `apps/server/src/services/runtimes/${runtime}`;

/** Per runtime: the ids its own tests claim. */
const ownClaims = new Map<MatrixRuntime, Set<string>>();
/** Per runtime: how many titles its own tests have, for the floors. */
const ownTitleCount = new Map<MatrixRuntime, number>();
const unparsed: string[] = [];
for (const runtime of MATRIX_RUNTIMES) {
  const ids = new Set<string>();
  let count = 0;
  for (const file of testFiles(runtimeDir(runtime))) {
    const { titles, parseErrors } = titlesOf(file);
    if (parseErrors > 0) unparsed.push(file);
    count += titles.length;
    for (const title of titles) for (const id of idsClaimedBy(title)) ids.add(id);
  }
  ownClaims.set(runtime, ids);
  ownTitleCount.set(runtime, count);
}

const shared = titlesOf(CONFORMANCE);
if (shared.parseErrors > 0) unparsed.push(CONFORMANCE);
/** The ids the shared conformance suite's titles claim. */
const sharedClaims = new Set(shared.titles.flatMap(idsClaimedBy));

/** Whether a runtime's conformance file runs the shared suite. */
function runsSharedSuite(runtime: MatrixRuntime): boolean {
  const file = join(ROOT, runtimeDir(runtime), '__tests__/conformance.test.ts');
  return /\bruntimeConformance\s*\(/.test(readFileSync(file, 'utf8'));
}

/** Every id a test claims anywhere this census reads. */
const everyClaim = new Set([
  ...sharedClaims,
  ...[...ownClaims.values()].flatMap((ids) => [...ids]),
]);

describe('the runtime capabilities census', () => {
  it('parsed the registry and the suites, so nothing below can pass on nothing', () => {
    // Floors at roughly 90% of what was parsed when DOR-2720 landed (43 rows,
    // 68 shared titles claiming 35 ids; 2180, 362, 608 and 121 titles in the
    // four runtimes' own folders). Raising them is part of adding coverage.
    expect(RUNTIME_CAPABILITIES.length).toBeGreaterThanOrEqual(40);
    expect(shared.titles.length).toBeGreaterThanOrEqual(60);
    expect(sharedClaims.size).toBeGreaterThanOrEqual(30);
    for (const runtime of MATRIX_RUNTIMES) {
      expect({ runtime, titles: (ownTitleCount.get(runtime) ?? 0) >= 100 }).toEqual({
        runtime,
        titles: true,
      });
      expect({ runtime, runsShared: runsSharedSuite(runtime) }).toEqual({
        runtime,
        runsShared: true,
      });
    }
    expect(unparsed).toEqual([]);
  });

  it('has unique, well-formed row ids, each in its own group', () => {
    const ids = RUNTIME_CAPABILITIES.map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const row of RUNTIME_CAPABILITIES) {
      expect(row.id).toMatch(new RegExp(`^RT-${row.group}-\\d{2}$`));
    }
  });

  it('has a test proving every cell that claims U evidence', () => {
    const unproven: string[] = [];
    for (const row of RUNTIME_CAPABILITIES) {
      const claimIds = [row.id, ...(row.conformance ?? [])];
      for (const runtime of MATRIX_RUNTIMES) {
        const cell = row.cells[runtime];
        if (!cell.evidence?.includes('U')) continue;
        const own = ownClaims.get(runtime) ?? new Set<string>();
        const proven = claimIds.some(
          (id) => own.has(id) || (sharedClaims.has(id) && runsSharedSuite(runtime))
        );
        if (!proven) unproven.push(`${row.id} × ${runtime}`);
      }
    }
    expect(
      unproven,
      'These cells claim U evidence and no test that runs for that runtime has a title starting ' +
        'with the row id (or a conformance id the row lists). Retitle the test that proves it, ' +
        'or mark the cell unverified.'
    ).toEqual([]);
  });

  it('names no RT id the matrix does not have', () => {
    const known = new Set(RUNTIME_CAPABILITIES.map((row) => row.id));
    const unknown = [...everyClaim].filter((id) => id.startsWith('RT-') && !known.has(id));
    expect(unknown.sort(), 'A test title names a row the matrix does not have.').toEqual([]);
  });

  it('lets no runtime test claim a cell the matrix says it lacks', () => {
    const contradicted: string[] = [];
    for (const row of RUNTIME_CAPABILITIES) {
      for (const runtime of MATRIX_RUNTIMES) {
        const cell = row.cells[runtime];
        if (HAS_CAPABILITY.has(cell.status)) continue;
        if (ownClaims.get(runtime)?.has(row.id)) {
          contradicted.push(`${row.id} × ${runtime} is ${cell.status}`);
        }
      }
    }
    expect(
      contradicted,
      'A test in the runtime’s own folder claims a capability the matrix says it lacks. If it ' +
        'was built, promote the cell.'
    ).toEqual([]);
  });

  it('agrees with every runtime’s declared capabilities', () => {
    const disagree: string[] = [];
    for (const row of RUNTIME_CAPABILITIES) {
      if (!row.flag) continue;
      for (const runtime of MATRIX_RUNTIMES) {
        const declared = row.flag.read(DECLARED[runtime]);
        const has = HAS_CAPABILITY.has(row.cells[runtime].status);
        if (declared !== has) {
          disagree.push(
            `${row.id} × ${runtime}: ${row.flag.label} is ${declared}, cell is ${row.cells[runtime].status}`
          );
        }
      }
    }
    expect(disagree, 'The matrix and runtime-constants.ts disagree. One of them is wrong.').toEqual(
      []
    );
  });

  it('says why for every cell but supported, and names a ticket for every planned one', () => {
    const missing: string[] = [];
    for (const row of RUNTIME_CAPABILITIES) {
      for (const runtime of MATRIX_RUNTIMES) {
        const cell = row.cells[runtime];
        if (cell.status !== 'supported' && !cell.reason?.trim()) {
          missing.push(`${row.id} × ${runtime}: no reason`);
        }
        if (cell.status === 'planned' && !/^DOR-\d+$/.test(cell.ticket ?? '')) {
          missing.push(`${row.id} × ${runtime}: planned with no ticket`);
        }
        if (cell.status === 'supported' && !cell.evidence?.length) {
          missing.push(`${row.id} × ${runtime}: supported with no evidence`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it(`keeps ${DOC} exactly what the registry renders`, () => {
    expect(
      readFileSync(join(ROOT, DOC), 'utf8'),
      `${DOC} is stale. Run \`pnpm docs:runtime-capabilities\`.`
    ).toBe(renderRuntimeCapabilityMatrix());
  });
});

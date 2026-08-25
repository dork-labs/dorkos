/**
 * Measure what a search COSTS on this machine, and assert the shape of the curve
 * rather than a number off a page (message-search spec §6.3 as amended by
 * Amendment 1).
 *
 * Run it with:
 *
 * ```bash
 * DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-latency-bench.ts
 * ```
 *
 * It builds the same throwaway index `search-corpus-bench.ts` builds — from this
 * machine's real Claude Code transcripts, in a temp directory, removed
 * afterwards — because a latency claim over a fixture corpus is a claim about
 * the fixture. Same env gate, same reason: it reads every transcript the
 * operator has, which is slow, machine-specific, and nobody's business in CI.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * **Not a millisecond budget.** Three independent runs of this benchmark during
 * DECOMPOSE produced three different absolute figures spanning roughly 2× in
 * each direction, because every one was taken on a workstation running several
 * agents. No absolute reproduced; the SHAPE reproduced every time. So a
 * threshold copied out of the spec would be either meaninglessly loose or flaky,
 * and this script derives everything it asserts from the same run:
 *
 * 1. **The hit count, first.** An empty or broken index answers in microseconds,
 *    so a latency-only assertion passes most loudly exactly when the feature is
 *    most broken.
 * 2. **Unordered is flat.** The join and the MATCH are effectively free across
 *    orders of magnitude of hit count — measured 0.011–0.019 ms across a
 *    four-decade range, twice, on different loads.
 * 3. **Ranked is linear in hits.** `ORDER BY bm25()` is O(matching rows), not
 *    O(limit): bm25 has to score every match before `LIMIT` can discard any. The
 *    slope moves with machine load; the linearity does not.
 *
 * **The terms are measured, never hardcoded.** The most frequent token in the
 * corpus is read out of FTS5's own vocabulary table at bench time, so the check
 * keeps biting as the corpus changes rather than resting on `the` still being
 * the commonest word in it.
 *
 * Methodology, from the amendment: statements are prepared OUTSIDE the timing
 * loop, a warm-up is discarded, and every figure is a p50 over 25 runs.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// By relative path rather than by package name, for the reason
// `search-corpus-bench.ts` gives: this file sits in the root workspace, which
// does not depend on `@dorkos/db`.
import { createDb, runMigrations, messages } from '../packages/db/src/index.js';
import { sweepFileSource } from '../apps/server/src/services/search/jsonl-frontier.js';
import { claudeCodeSource } from '../apps/server/src/services/search/registry.js';

/**
 * The fewest rows the most frequent term must match.
 *
 * **Derived from this repo's own measurement, not from the spec.** DOR-684's
 * task text asks for 10,000, which came from an 18,114-row prototype index. The
 * corpus a single Claude Code root actually holds today is 9,110 messages
 * (measured 2026-08-24, recorded in `search-corpus-bench.ts`), because Claude
 * Code rotates transcripts older than `cleanupPeriodDays` — so a single root is
 * a moving 30-day window rather than a growing archive, and 10,000 hits from it
 * is not reachable at any load.
 *
 * 5,000 keeps the floor's whole purpose — an empty or broken index is fast, and
 * this is what stops that passing — while sitting far enough below today's
 * corpus that ordinary rotation never reddens it. It matches the floor its
 * sibling script already uses, deliberately. DOR-682 (every root, not just the
 * active one) roughly doubles the corpus and lets this rise.
 */
const MIN_TOP_TERM_HITS = 5_000;

/**
 * How far apart the flat measurements may be before "flat" is a lie.
 *
 * The two independent runs behind Amendment 1 spread 1.7× and 1.6× across four
 * decades. This bench has measured up to 3.2× on a workstation running several agents, and
 * that is noise rather than curvature: the numbers being spread are 8–24
 * MICROseconds, where a scheduler hiccup is the whole difference. 5× is loose
 * enough to survive that and still far tighter than the ranked spread beside it.
 */
const MAX_FLAT_SPREAD = 5;

/**
 * How much more the ranked query must spread than the unordered one.
 *
 * The claim being made is comparative — "the join and the match are effectively
 * free; the ranking is the whole cost" — and stated that way it is scale-free
 * and survives any load. Measured 109× against 1.12× here (2026-08-24).
 */
const MIN_SPREAD_RATIO = 10;

/** How linear the ranked curve has to look before it counts as linear. */
const MIN_LINEARITY_R2 = 0.9;

/** How many hit-count decades the flat claim has to span to mean anything. */
const MIN_DECADES = 3;

// The rule points at each app's Zod-validated `env.ts`, and this file is not in
// an app — same carve-out, same reason, as `search-corpus-bench.ts`.
// eslint-disable-next-line no-restricted-syntax
if (process.env.DORKOS_SEARCH_BENCH !== '1') {
  console.error(
    'search-latency-bench reads every Claude Code transcript on this machine.\n' +
      'Run it deliberately:\n\n' +
      '  DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-latency-bench.ts\n'
  );
  process.exit(2);
}

/** The p50 of `runs` timings, in milliseconds, with a warm-up discarded. */
function p50(run: () => unknown, runs = 25): number {
  for (let i = 0; i < 5; i += 1) run();
  const timings: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const started = process.hrtime.bigint();
    run();
    timings.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  timings.sort((a, b) => a - b);
  return timings[Math.floor(runs / 2)] ?? 0;
}

/** Least-squares fit of `y = slope·x + intercept`, with its R². */
function fit(points: ReadonlyArray<{ x: number; y: number }>): { slope: number; r2: number } {
  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  const covariance = points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0);
  const varianceX = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0);
  const slope = varianceX === 0 ? 0 : covariance / varianceX;
  const intercept = meanY - slope * meanX;
  const residual = points.reduce((sum, p) => sum + (p.y - (slope * p.x + intercept)) ** 2, 0);
  const total = points.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0);
  return { slope, r2: total === 0 ? 0 : 1 - residual / total };
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-search-latency-'));
const dbPath = path.join(workdir, 'bench.db');

try {
  const db = createDb(dbPath);
  runMigrations(db);
  await sweepFileSource(db, claudeCodeSource, new Date().toISOString());
  const indexed = db.select({ ordinal: messages.ordinal }).from(messages).all().length;

  const raw = db.$client;
  // FTS5's own vocabulary, so the terms are measured rather than assumed.
  // Created in the main database rather than in `temp`, because `fts5vocab`
  // resolves its target inside its OWN database and cannot see across — and the
  // main database here is the throwaway this script built a moment ago.
  raw.exec("CREATE VIRTUAL TABLE msg_vocab USING fts5vocab('messages_fts', 'row')");
  const vocabulary = raw
    .prepare(
      // Words only — a hex blob that happens to appear 400 times says nothing
      // about what searching feels like.
      "SELECT term, doc FROM msg_vocab WHERE term GLOB '[a-z]*' AND length(term) > 2 ORDER BY doc DESC"
    )
    .all() as Array<{ term: string; doc: number }>;

  if (vocabulary.length === 0) {
    console.error('FAIL: the index holds no searchable term at all.');
    process.exit(1);
  }

  // The most frequent term, plus one term near each decade BELOW it, so the
  // range is three decades of whatever this corpus turns out to hold rather than
  // three decades this script hoped for. A corpus half the size still spans
  // three decades; a hardcoded 10/100/1000 quietly stops doing so.
  const top = vocabulary[0]!;
  const targets = [2_000, 100, 10].map((divisor) => Math.max(2, Math.round(top.doc / divisor)));
  const sampled = [
    ...targets.map((target) =>
      vocabulary.reduce((best, candidate) =>
        Math.abs(candidate.doc - target) < Math.abs(best.doc - target) ? candidate : best
      )
    ),
    top,
  ];
  // Deduplicate, in case a small corpus puts two decades on one term.
  const terms = [...new Map(sampled.map((entry) => [entry.term, entry])).values()].sort(
    (a, b) => a.doc - b.doc
  );

  const SNIPPET = "snippet(messages_fts, 0, '<mark>', '</mark>', '…', 12)";
  // Prepared once, outside every timing loop.
  const bare = raw.prepare(
    `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? LIMIT 20`
  );
  // Ranked WITHOUT the snippet, and ranked WITH it, because they are two
  // different terms of the cost. Ranking is charged per row that MATCHES and is
  // the one that scales; `snippet()` is charged per row RETURNED — twenty of
  // them, always — and is a constant multiplier on top. Fitting a line through
  // the combined figure measures the constant as if it were part of the slope,
  // which is what an earlier run of this script did before the split.
  const ranked = raw.prepare(
    `SELECT m.id FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 20`
  );
  const rankedSnippet = raw.prepare(
    `SELECT m.id, ${SNIPPET} AS excerpt FROM messages_fts f JOIN messages m ON m.id = f.rowid
     WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 20`
  );

  const measured = terms.map((entry) => {
    const match = `"${entry.term}"`;
    return {
      term: entry.term,
      hits: entry.doc,
      bareMs: p50(() => bare.all(match)),
      rankedMs: p50(() => ranked.all(match)),
      snippetMs: p50(() => rankedSnippet.all(match)),
    };
  });

  for (const row of measured) {
    // What ranking costs per matching row, once the flat part is taken off.
    const slopeUsPerRow = ((row.rankedMs - row.bareMs) * 1000) / row.hits;
    console.log(
      [
        `term=${row.term}`,
        `hits=${row.hits}`,
        `p50_bare=${row.bareMs.toFixed(3)}`,
        `p50_ranked=${row.rankedMs.toFixed(3)}`,
        `p50_snippet=${row.snippetMs.toFixed(3)}`,
        `slope_us_per_row=${slopeUsPerRow.toFixed(3)}`,
      ].join(' ')
    );
  }
  console.log(`messages=${indexed} terms=${measured.length}`);

  const problems: string[] = [];

  // 1. The hit count, before anything about time.
  const topMeasured = measured[measured.length - 1]!;
  if (topMeasured.hits < MIN_TOP_TERM_HITS) {
    problems.push(
      `the commonest term '${topMeasured.term}' matches ${topMeasured.hits} rows, below ${MIN_TOP_TERM_HITS} — the index is empty, broken, or built from a corpus this bench cannot speak for`
    );
  }

  // 2. Unordered is flat, across a range wide enough for that to mean something.
  const decades = Math.log10(topMeasured.hits / measured[0]!.hits);
  if (decades < MIN_DECADES) {
    problems.push(
      `hit counts span only ${decades.toFixed(1)} decades, below ${MIN_DECADES} — flatness measured over one decade is not evidence of anything`
    );
  }
  const bareTimes = measured.map((row) => row.bareMs);
  const spread = Math.max(...bareTimes) / Math.min(...bareTimes);
  if (spread > MAX_FLAT_SPREAD) {
    problems.push(
      `unordered p50 spans ${spread.toFixed(1)}× across the range, above ${MAX_FLAT_SPREAD}× — the match is no longer the free part`
    );
  }
  const rankedTimes = measured.map((row) => row.rankedMs);
  const rankedSpread = Math.max(...rankedTimes) / Math.min(...rankedTimes);
  if (rankedSpread / spread < MIN_SPREAD_RATIO) {
    problems.push(
      `ranking spreads ${(rankedSpread / spread).toFixed(1)}× more than the match does, below ${MIN_SPREAD_RATIO}× — the two are no longer telling different stories`
    );
  }

  // 3. Ranked is linear in hits, and rising. Fitted on the ranking term alone —
  // `snippet()` is a constant, and folding it in measures the constant as slope.
  const ranking = fit(measured.map((row) => ({ x: row.hits, y: row.rankedMs })));
  console.log(
    `ranked_slope_us_per_row=${(ranking.slope * 1000).toFixed(3)} linearity_r2=${ranking.r2.toFixed(3)} bare_spread=${spread.toFixed(2)}x ranked_spread=${rankedSpread.toFixed(1)}x decades=${decades.toFixed(2)}`
  );
  if (ranking.slope <= 0) {
    problems.push('ranked cost does not rise with hit count — the ranking is not being measured');
  }
  if (ranking.r2 < MIN_LINEARITY_R2) {
    problems.push(
      `ranked cost fits a line at R²=${ranking.r2.toFixed(2)}, below ${MIN_LINEARITY_R2} — the cost model in the spec no longer describes this query`
    );
  }

  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}

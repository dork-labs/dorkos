/**
 * The quarantine lane (plan §4.9 L1): the list, its guards, and the gate that
 * decides whether a suite's failures may pass.
 *
 * WHAT QUARANTINE IS HERE. A quarantined test still RUNS, still retries, and
 * still appears in every report. The only thing it loses is the power to fail
 * the blocking queue job. Nothing is deleted, skipped, `grepInvert`-ed or
 * `exclude`-d, so the signal stays: the day a quarantined test stops failing is
 * visible in the same reports, and `ci-steward flaky` sees it.
 *
 * WHERE THE LIST LIVES. On the `ci-steward-data` branch, not in the repo, so
 * quarantining a test takes effect on the next queue build with no PR and no
 * merge. That is also why every guard below is a READ-time guard: the readers
 * are what enforce the policy, because there is no review in the loop.
 *
 *   - an expired entry is dropped when it is read, wherever it is read, and an
 *     entry whose life exceeds `max_expiry_days` voids the whole list. That is
 *     measured against the READER'S clock as well as against the entry's own
 *     `added_at`: both timestamps come out of the same unreviewed file, so an
 *     entry dated 2030 with a fourteen-day life would otherwise be honoured
 *     today and be permanent for four years;
 *   - a list longer than `max_entries` is ignored ENTIRELY, never trimmed: a
 *     silent trim would leave the lane open at exactly the size somebody tried
 *     to exceed, and the honest failure mode of a too-wide lane is no lane;
 *   - anything that does not parse or does not validate is ignored entirely.
 *
 * Every one of those falls back to "nothing is quarantined", which means every
 * test blocks as it always did. The lane fails SAFE, and a reader says out loud
 * why it ignored a list rather than quietly running without one.
 */
import { z } from 'zod';
import type { QuarantineConfig } from './schemas.ts';

/** A test runner the lane knows how to read. */
export const RUNNERS = ['playwright', 'vitest'] as const;
/** A test runner the lane knows how to read. */
export type Runner = (typeof RUNNERS)[number];

/** One quarantined test. */
export const QuarantineEntrySchema = z
  .object({
    runner: z.enum(RUNNERS),
    /**
     * Playwright: the spec path the JSON report carries, relative to
     * `apps/e2e/tests`. Vitest: the test file relative to the repo root.
     */
    file: z.string().min(1),
    /** The test's full title, exactly as the report spells it. */
    title: z.string().min(1),
    /** Why this test is in the lane, in a sentence somebody else can act on. */
    reason: z.string().min(20),
    /** What the classifier found; `ci-steward quarantine add` refuses to invent it. */
    evidence: z
      .object({
        /** Distinct merge-group SHAs the test failed and then passed on. */
        occurrences: z.number().int().min(1),
        /** Queue builds whose reports were read. */
        builds_sampled: z.number().int().min(1),
        /** Those SHAs, short. */
        shas: z.array(z.string().min(1)).min(1),
        /** First and last day an occurrence was seen, `YYYY-MM-DD`. */
        first_day: z.string(),
        last_day: z.string(),
        /** The command and window the counts came from. */
        source: z.string().min(1),
      })
      .strict(),
    /** Who or what added it: an agent name, or `ci-improve-tick`. */
    added_by: z.string().min(1),
    added_at: z.string(),
    /** When every reader stops honouring it. */
    expires_at: z.string(),
    /** The `proposed` ledger entry that says to fix or delete the test. */
    ledger: z.string().regex(/^\d{6}-\d{6}$/, 'a ledger id, YYMMDD-HHMMSS'),
  })
  .strict();
/** One quarantined test. */
export type QuarantineEntry = z.infer<typeof QuarantineEntrySchema>;

/** `quarantine.json` on the data branch. */
export const QuarantineSchema = z
  .object({
    schema: z.literal(1),
    updated_at: z.string(),
    entries: z.array(QuarantineEntrySchema),
  })
  .strict();
/** `quarantine.json` on the data branch. */
export type QuarantineFile = z.infer<typeof QuarantineSchema>;

/** An empty list, which is what every failed read falls back to. */
export function emptyQuarantine(now: Date): QuarantineFile {
  return { schema: 1, updated_at: now.toISOString(), entries: [] };
}

/**
 * A test's identity across the lane: `<runner>:<file> › <title>`.
 *
 * The separator is the one Playwright's own reporters and
 * `scripts/assert-browser-tests-executed.sh` already print, so an id can be
 * copied straight out of a job log.
 *
 * Compared byte for byte, with no Unicode normalisation: a title that differs
 * only by normal form does not match, and the lane then excuses nothing for it.
 * That is the safe direction — see the note in `flaky.ts` — and it is why the
 * tooling tells you to copy a test's name rather than retype it.
 *
 * @param t - Anything carrying the three fields.
 */
export function testId(t: { runner: Runner; file: string; title: string }): string {
  return `${t.runner}:${t.file} › ${t.title}`;
}

/** What a read of the list produced, and everything it refused. */
export interface QuarantineRead {
  /** The entries in force right now. Empty whenever anything was wrong. */
  entries: QuarantineEntry[];
  /** Ignored, dropped or absent, one plain sentence each. Always printed. */
  notes: string[];
  /** False when the list was rejected whole, so a caller can say "no lane today". */
  honoured: boolean;
}

/**
 * Read and validate the list, applying every read-time guard.
 *
 * @param text - The file's contents, or `null` when it does not exist.
 * @param cfg - The `quarantine:` block of `ci/config.yaml`.
 * @param now - The clock that decides expiry.
 */
export function readQuarantine(
  text: string | null,
  cfg: QuarantineConfig,
  now: Date
): QuarantineRead {
  const ignored = (why: string): QuarantineRead => ({
    entries: [],
    notes: [`the quarantine list was IGNORED: ${why} Every test blocks as normal.`],
    honoured: false,
  });
  if (text === null || text.trim() === '')
    return { entries: [], notes: ['no quarantine list on the data branch.'], honoured: true };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return ignored(`${cfg.file} is not JSON (${e instanceof Error ? e.message : String(e)}).`);
  }
  const parsed = QuarantineSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return ignored(`${cfg.file} does not match its schema (${first}).`);
  }
  const all = parsed.data.entries;
  if (all.length > cfg.max_entries) {
    return ignored(
      `${cfg.file} holds ${all.length} entries and the cap is ${cfg.max_entries}; a list is never trimmed to fit, because the lane would then be exactly as wide as somebody tried to make it.`
    );
  }
  const seen = new Set<string>();
  for (const e of all) {
    const id = testId(e);
    if (seen.has(id)) return ignored(`${id} is listed more than once in ${cfg.file}.`);
    seen.add(id);
  }
  const notes: string[] = [];
  const entries: QuarantineEntry[] = [];
  const maxLife = cfg.max_expiry_days * 86_400_000;
  for (const e of all) {
    const at = Date.parse(e.expires_at);
    const from = Date.parse(e.added_at);
    if (Number.isNaN(at) || Number.isNaN(from)) {
      return ignored(`${testId(e)} has an unreadable added_at or expires_at.`);
    }
    if (from > now.getTime() + MAX_FUTURE_SKEW_MS) {
      return ignored(
        `${testId(e)} is dated ${e.added_at}, which is in the future. A timestamp nobody observed is a timestamp somebody chose, and the only thing choosing one buys is a longer life.`
      );
    }
    // Measured twice, because both numbers come from the same unreviewed file:
    // once as the entry's own declared life, and once against THIS reader's
    // clock, which no writer controls.
    const declaredLife = at - from;
    const lifeFromNow = at - now.getTime();
    if (declaredLife > maxLife || lifeFromNow > maxLife) {
      const days = Math.round(Math.max(declaredLife, lifeFromNow) / 86_400_000);
      return ignored(
        `${testId(e)} would last ${days} days, and the ceiling is ${cfg.max_expiry_days}. An entry that outlives the guard is the guard being removed, so the whole list is refused rather than that one entry trimmed.`
      );
    }
    if (at <= now.getTime()) {
      notes.push(
        `${testId(e)} expired at ${e.expires_at} and is no longer honoured; it blocks again.`
      );
      continue;
    }
    entries.push(e);
  }
  return { entries, notes, honoured: true };
}

/**
 * How far into the future an `added_at` may sit before the entry is refused.
 *
 * Not a policy dial — a clock tolerance. Runners, the operator's machine and
 * GitHub all write these, and a couple of minutes of skew between them is
 * ordinary. Anything beyond it is a timestamp that was chosen rather than
 * observed, and the only thing choosing one buys is a longer life.
 */
const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/** Hours until an entry expires, negative once it has. */
export function hoursToExpiry(entry: QuarantineEntry, now: Date): number {
  return (Date.parse(entry.expires_at) - now.getTime()) / 3_600_000;
}

/** One test the runner reported, reduced to what the gate cares about. */
export interface ReportedTest {
  runner: Runner;
  file: string;
  title: string;
  /** `failed` is an unexpected failure that survived its retries. */
  outcome: 'failed' | 'passed' | 'flaky' | 'skipped';
}

/** What the gate decided, and everything it wants said out loud. */
export interface GateResult {
  /** Failures the lane absorbed, as ids. */
  absorbed: string[];
  /** Failures nothing excuses, as ids. This is what reds the build. */
  real: string[];
  /** Quarantined tests that ran and passed: candidates to release. */
  recovered: string[];
  /** Why the gate failed, or an empty list when it passed. */
  failures: string[];
  /** Worth printing; never a failure. */
  notes: string[];
  ok: boolean;
}

/**
 * Decide whether a suite's result may pass, given the lane.
 *
 * The rules, in the order they can fail:
 *
 *  1. A failure that is not quarantined fails, always. That is the whole point.
 *  2. The runner's OWN failure tally must equal the failures the per-test walk
 *     named. Two independent numbers out of the same report disagreeing means
 *     the report cannot be read, and a gate that cannot read its input must not
 *     certify it. This is the shell gate's "report disagrees with itself"
 *     refusal, mirrored here, and it is what stops a report that counts three
 *     failures while naming one from having two of them quietly excused.
 *  3. A failure that belongs to NO test is never excusable. A test file that
 *     throws on import fails to collect, so the runner counts it as a failed
 *     SUITE (or a global error) and not as a failed test — and a lane that
 *     reasons only about tests would wave a whole unloadable file through any
 *     run where one quarantined test happened to fail.
 *  4. A non-zero exit is excused ONLY when the tally is exactly the set the
 *     lane absorbed, and that set is not empty. A crashed runner, a dead
 *     webServer leg or a timeout produces an exit code with no failure behind
 *     it, and it must never ride out on a quarantined flake from the same run.
 *
 * KNOWN LIMIT, stated as what it is rather than as a list of things that would
 * catch it. This gate reasons about reports that EXIST. A package whose process
 * died before writing any report at all — an OOM kill, a segfault in the worker
 * — contributes to neither the tally, the walk nor `unattributed`, so a
 * non-zero exit caused by it, in a run where a quarantined test also failed, is
 * excused here and **nothing downstream catches it**:
 * `assert-tests-executed.sh` counts turbo TASKS and a failed task still ran,
 * and the fan-in's union check unions the files the OTHER shards collected, so
 * a package missing from one shard's reports still appears. Closing it needs
 * the gate to read the turbo summary's per-task exit codes and require a named
 * failure from every task that failed, which is not built. Rule 3 is what
 * removes the common half of this class (any bad import); this is the rest.
 *
 * @param opts - The reported tests, the runner's own failure tally, failures it
 *   attributes to no test, the entries in force, the suite's exit code and
 *   which runner this is.
 */
export function gateSuite(opts: {
  reported: readonly ReportedTest[];
  /** The runner's own count of failed TESTS (`stats.unexpected`, `numFailedTests`). */
  tally: number;
  /** Failures belonging to no test (`numFailedTestSuites`, Playwright's `errors[]`). */
  unattributed: number;
  entries: readonly QuarantineEntry[];
  suiteExit: number;
  runner: Runner;
}): GateResult {
  const { reported, tally, unattributed, entries, suiteExit, runner } = opts;
  const lane = new Set(entries.filter((e) => e.runner === runner).map(testId));
  const absorbed: string[] = [];
  const real: string[] = [];
  const recovered: string[] = [];
  for (const t of reported) {
    const id = testId(t);
    if (t.outcome === 'failed') (lane.has(id) ? absorbed : real).push(id);
    else if (lane.has(id) && (t.outcome === 'passed' || t.outcome === 'flaky')) recovered.push(id);
  }
  const failures: string[] = [];
  if (real.length > 0) {
    failures.push(
      `${real.length} test(s) failed and are not quarantined:\n${real.map((id) => `  ${id}`).join('\n')}`
    );
  }
  if (unattributed > 0) {
    failures.push(
      `the runner reported ${unattributed} failure(s) that belong to no test — a file that did not load, a worker that died, a config error. A quarantine entry names a TEST, so nothing here can excuse one of these, whatever else the run did.`
    );
  }
  const named = absorbed.length + real.length;
  if (tally !== named) {
    failures.push(
      `the runner counted ${tally} failure(s) and the per-test walk of the same report(s) named ${named}. The report disagrees with itself, so this gate refuses to certify it — and refuses to excuse anything from it.`
    );
  } else if (suiteExit !== 0 && !(absorbed.length > 0 && tally === absorbed.length)) {
    failures.push(
      `the suite exited ${suiteExit}, and the ${tally} failure(s) its report names are not exactly the ${absorbed.length} the lane absorbed. Something failed that the lane cannot see — a crashed runner, a dead webServer leg, an import error or a timeout is not a flake, and the lane refuses to excuse it.`
    );
  }
  const notes: string[] = [];
  if (absorbed.length > 0) {
    notes.push(
      `${absorbed.length} failure(s) absorbed by the quarantine lane:\n${absorbed.map((id) => `  ${id}`).join('\n')}`
    );
  }
  if (recovered.length > 0) {
    notes.push(
      `${recovered.length} quarantined test(s) PASSED here — a candidate to release:\n${recovered.map((id) => `  ${id}`).join('\n')}`
    );
  }
  return { absorbed, real, recovered, failures, notes, ok: failures.length === 0 };
}

/**
 * The Markdown block every queue build that used the lane prints in its job
 * summary. It names the whole set, its evidence and its expiry, so a wide lane
 * is visible from the build that used it rather than from a report next Monday.
 *
 * @param read - What `readQuarantine` produced.
 * @param cfg - The `quarantine:` block, for the cap.
 * @param now - The clock, for the hours-to-expiry column.
 * @param title - The heading, naming the job.
 */
export function renderQuarantineSummary(
  read: QuarantineRead,
  cfg: QuarantineConfig,
  now: Date,
  title: string
): string {
  const out = [`### ${title}`, ''];
  if (!read.honoured) {
    out.push(
      'The quarantine list was refused, so **nothing is quarantined** and every test blocks as normal.',
      ''
    );
  } else if (read.entries.length === 0) {
    out.push('Nothing is quarantined. Every test blocks as normal.', '');
  } else {
    out.push(
      `${read.entries.length} of ${cfg.max_entries} slot(s) in use. A quarantined test still runs and is still reported; it cannot fail this job.`,
      '',
      '| test | why | evidence | expires in | ledger |',
      '| --- | --- | --- | --- | --- |'
    );
    for (const e of read.entries) {
      const h = Math.round(hoursToExpiry(e, now));
      out.push(
        `| \`${testId(e)}\` | ${e.reason} | ${e.evidence.occurrences} flaky build(s) of ${e.evidence.builds_sampled}, ${e.evidence.first_day}..${e.evidence.last_day} | ${h} h | ${e.ledger} |`
      );
    }
    out.push('');
  }
  for (const n of read.notes) out.push(`- ${n}`);
  return out.join('\n');
}

/**
 * What the daily triage should say about the lane: nothing when it is empty
 * and healthy, and one plain sentence per thing that needs a person.
 *
 * A quarantine entry is debt with a deadline. These are the two deadlines that
 * arrive quietly — a lane with no slots left, and an entry about to expire and
 * put a still-flaky test back in the blocking path — so they are surfaced every
 * day rather than discovered by a red build.
 *
 * @param read - What `readQuarantine` produced.
 * @param cfg - The thresholds.
 * @param now - The clock.
 */
export function quarantineTriage(read: QuarantineRead, cfg: QuarantineConfig, now: Date): string[] {
  const out: string[] = [];
  if (!read.honoured) {
    out.push(
      `The quarantine list is REFUSED, so nothing is quarantined and every flaky test blocks again. ${read.notes[0] ?? ''}`.trim()
    );
    return out;
  }
  if (read.entries.length >= cfg.max_entries) {
    out.push(
      `The quarantine lane is FULL (${read.entries.length} of ${cfg.max_entries}). Nothing else can be quarantined until one of these tests is fixed or deleted, and one more entry would make every reader ignore the list entirely.`
    );
  }
  for (const e of read.entries) {
    const h = hoursToExpiry(e, now);
    if (h <= cfg.near_expiry_hours) {
      out.push(
        `${testId(e)} leaves quarantine in ${Math.round(h)} h and blocks again. Fix or delete the test (ledger ${e.ledger}), or re-quarantine it with fresh evidence.`
      );
    }
  }
  return out;
}

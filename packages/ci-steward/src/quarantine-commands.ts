/**
 * The quarantine lane's commands: `flaky`, `quarantine`, `quarantine-list` and
 * `quarantine-gate`.
 *
 * Two of them run in a person's (or an agent's) terminal and two run inside the
 * merge queue, and the split matters:
 *
 *   flaky            classifies from recorded data; reads, never writes
 *   quarantine       add / remove / list, with evidence; writes the data branch
 *   quarantine-list  what a queue job reads the list with; ALWAYS exits 0
 *   quarantine-gate  what decides whether a suite's failures may pass
 *
 * `quarantine-list` exiting 0 whatever happens is deliberate. It is the only
 * step between the network and the lane, and a job that dies because a fetch
 * failed would turn "we could not read the list" into a red build — the exact
 * load-multiplying failure the lane exists to remove. It writes an empty list
 * and says why instead, and an empty list means every test blocks as normal.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Env } from './commands.ts';
import { readReportsIn, type FlakyCandidate } from './flaky.ts';
import { evidence } from './flaky-sources.ts';
import { loadList, publishList, rawEntries } from './quarantine-store.ts';
import { allocateId } from './ids.ts';
import { LEDGER_FILE_RE } from './ledger.ts';
import {
  gateSuite,
  hoursToExpiry,
  renderQuarantineSummary,
  testId,
  type QuarantineEntry,
  type QuarantineRead,
  type Runner,
} from './quarantine.ts';

/** Append Markdown to the Actions job summary when there is one. */
function summary(env: Env, text: string): void {
  if (env.stepSummary) appendFileSync(env.stepSummary, `${text}\n`);
}

/**
 * `quarantine-list`: fetch the list, print it, and leave it where the gate and
 * the assert scripts can read it. Never fails.
 *
 * `--runner` is not a convenience. The `--lines` file carries `<file> › <title>`
 * and nothing else, because that is the identity both shell gates already
 * print — so a vitest entry handed to the browser gate would read as a
 * Playwright spec that must appear in the Playwright reports, and every queue
 * build would eject on the first vitest quarantine. Each caller says which
 * runner it is, and gets only that runner's entries.
 *
 * @param env - The environment.
 * @param opts - The runner to write, where to write the JSON and the flat id
 *   lines, and a summary title.
 */
export function cmdQuarantineList(
  env: Env,
  opts: { runner: Runner; out?: string; lines?: string; title?: string; offline?: boolean }
): number {
  const cfg = env.files.config.quarantine;
  let read: QuarantineRead;
  try {
    read = loadList(env, { offline: opts.offline });
  } catch (e) {
    read = {
      entries: [],
      notes: [
        `the quarantine list could not be read at all (${e instanceof Error ? e.message : String(e)}). Nothing is quarantined.`,
      ],
      honoured: false,
    };
  }
  const mine = read.entries.filter((e) => e.runner === opts.runner);
  const scoped: QuarantineRead = { ...read, entries: mine };
  for (const n of read.notes) env.io.out(`quarantine: ${n}\n`);
  if (mine.length !== read.entries.length) {
    env.io.out(
      `quarantine: ${read.entries.length - mine.length} entry(s) for another runner are not this job's business and were left out.\n`
    );
  }
  for (const e of mine) {
    env.io.out(
      `quarantine: ${testId(e)} (expires in ${Math.round(hoursToExpiry(e, env.now))} h, ledger ${e.ledger})\n`
    );
  }
  if (opts.out) {
    mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
    writeFileSync(
      opts.out,
      `${JSON.stringify({ schema: 1, updated_at: env.now.toISOString(), entries: mine }, null, 1)}\n`
    );
  }
  if (opts.lines) {
    mkdirSync(path.dirname(path.resolve(opts.lines)), { recursive: true });
    // Sorted and deduplicated: the fan-in intersects these files by counting
    // identical lines across shards, and a line repeated inside ONE file would
    // count as two shards agreeing.
    const lines = [...new Set(mine.map((e) => `${e.file} › ${e.title}`))].sort();
    writeFileSync(opts.lines, lines.join('\n') + '\n');
  }
  summary(
    env,
    renderQuarantineSummary(scoped, cfg, env.now, opts.title ?? 'Quarantine lane, this build')
  );
  return 0;
}

/** Read every report argument, each of which may be a directory or a file. */
function readReports(
  paths: readonly string[],
  runner: Runner,
  repoRoot: string
): ReturnType<typeof readReportsIn> {
  const tests: ReturnType<typeof readReportsIn>['tests'] = [];
  let files = 0;
  let tally = 0;
  let unattributed = 0;
  for (const p of paths) {
    const r = readReportsIn(p, runner, repoRoot);
    tests.push(...r.tests);
    files += r.files;
    tally += r.tally;
    unattributed += r.unattributed;
  }
  return { tests, files, tally, unattributed };
}

/**
 * `quarantine-gate`: decide whether a suite's failures may pass.
 *
 * @param env - The environment.
 * @param opts - The runner, the report paths, the suite's own exit code and the
 *   list file.
 */
export function cmdQuarantineGate(
  env: Env,
  opts: {
    runner: Runner;
    reports: string[];
    suiteExit: number;
    list?: string;
    title?: string;
  }
): number {
  let read: QuarantineRead;
  try {
    read = loadList(env, { file: opts.list, offline: true });
  } catch (e) {
    env.io.err(`quarantine-gate: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const { tests, files, tally, unattributed } = readReports(opts.reports, opts.runner, env.root);
  if (files === 0) {
    // No report at all. With a green suite that is somebody else's problem
    // (the execution-proof steps); with a red one it is this gate's, because
    // an unexplained red must never pass.
    if (opts.suiteExit === 0) {
      env.io.out(
        `quarantine-gate: no ${opts.runner} report under ${opts.reports.join(', ')}; the suite exited 0, so there is nothing to excuse.\n`
      );
      return 0;
    }
    env.io.err(
      `quarantine-gate: the suite exited ${opts.suiteExit} and left no readable ${opts.runner} report under ${opts.reports.join(', ')}. Nothing can be attributed to a quarantined flake, so this fails.\n`
    );
    return 1;
  }
  const result = gateSuite({
    reported: tests,
    tally,
    unattributed,
    entries: read.entries,
    suiteExit: opts.suiteExit,
    runner: opts.runner,
  });
  for (const n of read.notes) env.io.out(`quarantine-gate: ${n}\n`);
  for (const n of result.notes) env.io.out(`quarantine-gate: ${n}\n`);
  const lines: string[] = [`### ${opts.title ?? `Quarantine gate (${opts.runner})`}`, ''];
  lines.push(
    `Read ${files} report file(s), ${tests.length} test result(s), ${tally} failed test(s) and ${unattributed} failure(s) attributed to no test, by the runner's own count. Suite exit ${opts.suiteExit}.`,
    ''
  );
  for (const n of [...read.notes, ...result.notes]) lines.push(`- ${n.replace(/\n/g, '<br>')}`);
  for (const f of result.failures) lines.push(`- **FAILED:** ${f.replace(/\n/g, '<br>')}`);
  summary(env, lines.join('\n'));
  if (result.ok) {
    env.io.out(
      `quarantine-gate: PASS — ${result.real.length} unexcused failure(s), ${result.absorbed.length} absorbed.\n`
    );
    // `stepSummary` is set only inside Actions (GITHUB_STEP_SUMMARY), so it is
    // also how this tells a runner from a terminal, without reading the
    // environment a second time.
    if (result.absorbed.length > 0 && env.stepSummary) {
      env.io.out(
        `::warning title=quarantine lane absorbed a failure::${result.absorbed.length} quarantined test(s) failed and did not fail this job — see the job summary. A quarantined test is debt, not a fix.\n`
      );
    }
    return 0;
  }
  for (const f of result.failures) env.io.err(`quarantine-gate: ${f}\n`);
  return 1;
}

/** What a mutation produced, before it is published. */
interface Mutation {
  entries: QuarantineEntry[];
  /** The ledger id the new entry names, so its stub can be written afterwards. */
  ledgerId?: string;
  /** The test that id is about, for the stub's title. */
  testName?: string;
  /** The gates the stub should name. */
  gates?: string[];
}

/** Scaffold the `proposed` "fix or delete this test" entry an add owes. */
function writeLedgerStub(env: Env, id: string, testName: string, gates: string[]): string {
  const dir = path.join(env.root, env.files.config.ledger_dir);
  mkdirSync(dir, { recursive: true });
  // Readable and short: the file's stem, then as much of the title as fits,
  // always cut at a word boundary so the name never ends mid-word.
  const words = testName
    .toLowerCase()
    .replace(/\.(spec|test)\.[tj]sx?/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .split('-')
    .filter(Boolean);
  let slug = 'quarantine';
  for (const w of words) {
    if (slug.length + w.length + 1 > 46) break;
    slug += `-${w}`;
  }
  const rel = `${env.files.config.ledger_dir}/${id}-${slug}.md`;
  const text = [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(`Fix or delete ${testName}`)}`,
    'kind: hygiene',
    'status: proposed',
    'actor: agent',
    `gates:\n${gates.map((g) => `  - ${g}`).join('\n')}`,
    'prs: []',
    'ratchet-release: []',
    'field-changes: []',
    '---',
    '',
    `This test is in the CI Steward quarantine lane (or was proposed for it): it runs`,
    'and is reported on every queue build, but it cannot fail one. Check `pnpm',
    'ci:quarantine list` for whether the entry is live.',
    '',
    'That is debt, not a fix. Close it by making the test deterministic, or by deleting',
    'it if what it asserts is not worth a reliable test. Remove the quarantine entry in',
    'the same change (`pnpm ci:quarantine remove`), and let the next queue build prove it.',
    '',
  ].join('\n');
  writeFileSync(path.join(env.root, rel), text, { flag: 'wx' });
  return rel;
}

/** The gates a runner's quarantine touches, for the ledger stub. */
const RUNNER_GATES: Record<Runner, string[]> = {
  playwright: ['wf.browser-test.browser-shard', 'wf.browser-test.browser-test'],
  vitest: ['wf.test.test-shard', 'wf.test.test'],
};

function addEntry(
  env: Env,
  current: QuarantineEntry[],
  opts: {
    runner: Runner;
    file: string;
    title: string;
    reason: string;
    expiryDays?: number;
    by?: string;
    candidates: FlakyCandidate[];
    source: string;
    /** Reuse this existing ledger entry instead of scaffolding a new one. */
    ledger?: string;
  }
): { mutation?: Mutation; error?: string } {
  const cfg = env.files.config.quarantine;
  const id = testId(opts);
  if (current.some((e) => testId(e) === id)) return { error: `${id} is already quarantined.` };
  if (current.length + 1 > cfg.max_entries) {
    return {
      error: `the lane is full: ${current.length} of ${cfg.max_entries} slots are in use. Fix or delete one of the tests already in it before adding another — a wider lane is a bigger blind spot, and a list over the cap is ignored entirely.`,
    };
  }
  // The vitest union check only recognises a repo-relative path under a
  // workspace root, and skips anything else — silently, before this. An entry
  // it cannot recognise is an entry nothing watches, so it is refused here
  // rather than accepted and then ignored.
  if (opts.runner === 'vitest' && !/^(?:apps|packages)\/[^/]+\//.test(opts.file)) {
    return {
      error: `--file ${opts.file} is not a workspace test file. A vitest entry names a path relative to the REPO root, e.g. packages/harness/src/__tests__/atomic-write.test.ts; the union check that proves a quarantined test's file is still collected cannot see anything else, so an entry like this would be watched by nothing.`,
    };
  }
  const c = opts.candidates.find((x) => x.id === id);
  if (!c) {
    return {
      error: `${id} has NO flaky evidence in the last ${cfg.window_days} days, so it may not be quarantined. Quarantine is for a test that failed and then passed on the SAME tree; a test that fails deterministically is a real bug and the lane must never hide one. Run \`pnpm ci:flaky\` to see what the data says.`,
    };
  }
  if (c.status !== 'qualifies') {
    return { error: `${id} does not qualify: ${c.why}` };
  }
  const days = opts.expiryDays ?? cfg.default_expiry_days;
  if (days > cfg.max_expiry_days) {
    return {
      error: `--expiry-days ${days} is over the ceiling of ${cfg.max_expiry_days}. Every reader refuses a list holding a longer-lived entry, so writing one would take the whole lane down rather than buy more time.`,
    };
  }
  const expires = new Date(env.now.getTime() + days * 86_400_000);
  const dir = path.join(env.root, env.files.config.ledger_dir);
  const ids = (existsSync(dir) ? readdirSync(dir) : []).flatMap((n) => {
    const id = LEDGER_FILE_RE.exec(n)?.[1];
    return id ? [id] : [];
  });
  // `--ledger` reuses the debt item this quarantine already has: a re-quarantine
  // after a failed fix belongs on the same entry, and an add whose stub was
  // committed by an earlier dry run must not scaffold a second one.
  if (opts.ledger !== undefined && !ids.includes(opts.ledger)) {
    return {
      error: `--ledger ${opts.ledger} names no entry under ${env.files.config.ledger_dir}. Leave it out to scaffold a new "fix or delete this test" entry.`,
    };
  }
  const taken = new Set(ids);
  const ledgerId = opts.ledger ?? allocateId((x) => taken.has(x), env.now);
  const entry: QuarantineEntry = {
    runner: opts.runner,
    file: opts.file,
    title: opts.title,
    reason: opts.reason,
    evidence: {
      occurrences: c.occurrences,
      builds_sampled: c.builds_sampled,
      shas: c.shas,
      first_day: c.first_day,
      last_day: c.last_day,
      source: opts.source,
    },
    added_by: opts.by ?? 'agent',
    added_at: env.now.toISOString(),
    expires_at: expires.toISOString(),
    ledger: ledgerId,
  };
  return {
    mutation: {
      entries: [...current, entry],
      ledgerId: opts.ledger === undefined ? ledgerId : undefined,
      testName: `${opts.file} › ${opts.title}`,
      gates: RUNNER_GATES[opts.runner],
    },
  };
}

/**
 * `quarantine`: the agent- and human-usable path in and out of the lane.
 *
 * `add` refuses a test with no flaky evidence, full stop. A test that fails
 * deterministically is a real bug, and the one thing this lane must never do is
 * hide one — so the classifier, not the caller, decides what is eligible.
 *
 * Nothing is published without `--publish`, because the list takes effect on the
 * next queue build with no review in between; a dry run prints exactly what
 * would be written.
 *
 * @param env - The environment.
 * @param action - `list`, `add` or `remove`.
 * @param opts - The test, the reason, and where the evidence is read from.
 */
export function cmdQuarantine(
  env: Env,
  action: string,
  opts: {
    runner?: string;
    file?: string;
    title?: string;
    reason?: string;
    by?: string;
    expiryDays?: number;
    publish?: boolean;
    data?: string;
    fetch?: boolean;
    builds?: number;
    json?: boolean;
    evidence?: string;
    ledger?: string;
  }
): number {
  const cfg = env.files.config.quarantine;
  const read = loadList(env, {});
  for (const n of read.notes) env.io.out(`quarantine: ${n}\n`);
  if (action === 'list') {
    if (opts.json) {
      env.io.out(
        `${JSON.stringify({ schema: 1, updated_at: env.now.toISOString(), entries: read.entries }, null, 1)}\n`
      );
      return 0;
    }
    env.io.out(
      `Quarantine lane: ${read.entries.length} of ${cfg.max_entries} slot(s) in use.${read.honoured ? '' : ' THE LIST IS NOT HONOURED (see above).'}\n`
    );
    for (const e of read.entries) {
      env.io.out(
        `\n  ${testId(e)}\n    ${e.reason}\n    evidence: ${e.evidence.occurrences} of ${e.evidence.builds_sampled} build(s), ${e.evidence.first_day}..${e.evidence.last_day} (${e.evidence.source})\n    added by ${e.added_by} at ${e.added_at}; expires in ${Math.round(hoursToExpiry(e, env.now))} h; ledger ${e.ledger}\n`
      );
    }
    return 0;
  }
  const runner = opts.runner as Runner | undefined;

  // `reset` publishes an empty list. It is the way OUT of a list no reader will
  // honour — one entry over the cap, one bad timestamp — which otherwise locks
  // this command out of its own file and leaves a hand edit of the data branch
  // as the only route, which the docs rightly forbid.
  if (action === 'reset') {
    env.io.out(
      `quarantine: emptying ${env.files.config.quarantine.file}. Nothing will be quarantined, which is what is true right now anyway if the list was refused.\n`
    );
    return publishList(env, [], 'quarantine: reset to an empty list', opts.publish === true);
  }

  if (action === 'remove') {
    if (!opts.file || !opts.title || !runner) {
      env.io.err('quarantine remove needs --runner, --file and --title.\n');
      return 2;
    }
    // Removing works on what the file SAYS, not on what the readers honour. A
    // list refused for one bad entry still parses, and taking that entry out is
    // exactly the repair; refusing to edit it was how the lockout happened.
    // `{}`, never `opts`: in this command `opts.file` is the TEST file, and
    // handing it to a reader that treats `file` as the list path would make it
    // read the list from a path that does not exist and quietly find nothing.
    const current = read.honoured ? read.entries : rawEntries(env, {});
    if (current === null) {
      env.io.err(
        `quarantine: ${env.files.config.quarantine.file} does not parse at all, so there is nothing to remove from. \`pnpm ci:quarantine reset --publish\` replaces it with an empty list.\n`
      );
      return 1;
    }
    if (!read.honoured) {
      env.io.out(
        'quarantine: the list is currently refused by every reader, so nothing is quarantined; removing from it is a repair.\n'
      );
    }
    const id = testId({ runner, file: opts.file, title: opts.title });
    const left = current.filter((e: QuarantineEntry) => testId(e) !== id);
    if (left.length === current.length) {
      env.io.err(`quarantine: ${id} is not in the lane.\n`);
      return 1;
    }
    return publishList(env, left, `quarantine: release ${id}`, opts.publish === true);
  }

  if (!read.honoured) {
    env.io.err(
      `quarantine: the list on the data branch is not honoured (see above), so nothing may be ADDED to it blind. Take the bad entry out with \`pnpm ci:quarantine remove\`, or replace the file with \`pnpm ci:quarantine reset --publish\`. Every test is blocking until then.\n`
    );
    return 1;
  }
  if (action !== 'add') {
    env.io.err(`quarantine: unknown action ${action}. Use list, add, remove or reset.\n`);
    return 2;
  }
  if (!runner || !opts.file || !opts.title || !opts.reason) {
    env.io.err(
      'quarantine add needs --runner, --file, --title and --reason. Copy the file and title from `pnpm ci:flaky`, which spells them exactly as the report does.\n'
    );
    return 2;
  }
  const ev = evidence(env, opts);
  const r = addEntry(env, read.entries, {
    runner,
    file: opts.file,
    title: opts.title,
    reason: opts.reason,
    expiryDays: opts.expiryDays,
    by: opts.by,
    candidates: ev.candidates,
    source: ev.label,
    ledger: opts.ledger,
  });
  if (!r.mutation) {
    env.io.err(`quarantine: refused. ${r.error}\n`);
    return 1;
  }
  const code = publishList(
    env,
    r.mutation.entries,
    `quarantine: add ${testId({ runner, file: opts.file, title: opts.title })}`,
    opts.publish === true
  );
  // The stub is written LAST, and only once the list itself went out (a dry run
  // counts: it is the shape an agent uses to prepare the PR). Writing it first
  // leaves a ledger entry pointing at a quarantine that a failed push never
  // created — debt recorded against nothing.
  if (code === 0 && r.mutation.ledgerId !== undefined) {
    const rel = writeLedgerStub(env, r.mutation.ledgerId, r.mutation.testName!, r.mutation.gates!);
    env.io.out(
      `quarantine: wrote ${rel} — the "fix or delete this test" entry this quarantine owes. Commit it; the lane entry itself needs no PR.\n`
    );
  } else if (code === 0) {
    env.io.out(`quarantine: reusing the existing ledger entry ${opts.ledger}.\n`);
  }
  return code;
}

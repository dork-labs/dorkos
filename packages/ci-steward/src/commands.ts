/**
 * The phase-1 commands behind the CLI: `collect`, `verdicts`, `triage`,
 * `report`, `daily-report`, `daily` (what the workflow runs), `data-prepare`,
 * `data-publish`, `status`, `pulse` and `local-export`. Each takes its clock and its GitHub and git
 * access as inputs, so tests drive every one against recorded responses and
 * temporary bare repositories.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { collect } from './collect.ts';
import {
  LatestSchema,
  loadSnapshots,
  readData,
  snapshotDays,
  snapshotPath,
  SnapshotSchema,
  writeData,
  type Latest,
} from './data.ts';
import {
  INDEX_DATA,
  INDEX_PATH,
  renderDailyReport,
  renderIndex,
  reportPath,
  ReportIndexSchema,
  updateIndex,
} from './daily-report.ts';
import { triage, TriggersSchema, triggerSummary, type Triggers } from './triggers.ts';
import {
  DataBranchMissing,
  prepareDataDir,
  publish,
  removeDataDir,
  tagWeek,
  type DataBranchRef,
  type Git,
} from './data-branch.ts';
import type { Gh } from './gh.ts';
import { readLedger } from './ledger.ts';
import type { HandFiles } from './load.ts';
import { aggregateDays, defaultCloneName, rotateTimings } from './local.ts';
import { hookRuns, parseTimings } from './timings.ts';
import { dirReader, gitReader, renderStatus } from './status.ts';
import {
  fetchMergeTimes,
  loadVerdicts,
  runReport,
  runVerdicts,
  writeLatest,
  type StewardContext,
} from './steward.ts';
import { addDays, count, dayOf, daysBetween, isoWeek } from './time.ts';
import type { WorkflowModel } from './workflows.ts';

/** Where a command writes. */
interface Out {
  out: (s: string) => void;
  err: (s: string) => void;
}

/** Everything the phase-1 commands share. */
export interface Env {
  root: string;
  files: HandFiles;
  workflows: readonly WorkflowModel[];
  now: Date;
  io: Out;
  /** Builds a budgeted GitHub client; only called by commands that need GitHub. */
  gh: (budget: number) => Gh;
  git: Git;
  /** The Actions job summary file (`GITHUB_STEP_SUMMARY`), when there is one. */
  stepSummary?: string;
  /** A clone export name from the environment (`CI_STEWARD_CLONE`). */
  cloneName?: string;
}

function ref(env: Env): DataBranchRef {
  const c = env.files.config;
  return { repo: env.root, remote: 'origin', branch: c.data_branch, tagPrefix: c.data_tag_prefix };
}

function ctx(env: Env, dataDir: string): StewardContext {
  return { files: env.files, workflows: env.workflows, dataDir, now: env.now };
}

/** Append Markdown to the Actions job summary when there is one. */
function summary(env: Env, text: string): void {
  if (env.stepSummary) appendFileSync(env.stepSummary, `${text}\n`);
}

/**
 * `collect`: snapshots for the planned days (or `days`), then latest.json.
 *
 * @param env - The environment.
 * @param dataDir - A working tree of the data branch.
 * @param opts - Explicit days; whether to add today so far.
 * @returns Exit code: 0 healthy, 1 unhealthy.
 */
export function cmdCollect(
  env: Env,
  dataDir: string,
  opts: { days?: string[]; today?: boolean; gh?: Gh } = {}
): number {
  const configured = env.files.config.collect.api_budget;
  // Never spend past what the token has left this hour (a manual dispatch in
  // the cron's hour, or a pulse on a busy login), keeping 50 for everyone else.
  const left = env.gh(0).remaining();
  const budget = left === null ? configured : Math.max(0, Math.min(configured, left - 50));
  if (budget < configured)
    env.io.out(
      `the token has ${left} requests left this hour; budget ${budget} instead of ${configured}\n`
    );
  const gh = opts.gh ?? env.gh(budget);
  const tmp = mkdtempSync(path.join(tmpdir(), 'ci-steward-collect-'));
  try {
    const r = collect({
      gh,
      files: env.files,
      workflows: env.workflows,
      dataDir,
      now: env.now,
      days: opts.days,
      includeToday: opts.today,
      tmpDir: tmp,
    });
    env.io.out(
      `collected ${r.days.length ? r.days.join(', ') : 'nothing'} with ${r.apiCalls} of ${gh.budget} API requests\n`
    );
    if (r.newest) {
      const latest = writeLatest(ctx(env, dataDir), r.newest, {
        apiCalls: r.apiCalls,
        failures: r.failures,
      });
      env.io.out(
        `latest.json -> ${latest.snapshot}; constraint: ${latest.constraint.id ?? 'none'} (${latest.constraint.tier})\n`
      );
    }
    if (r.planned.length > 0 && r.days.length === 0) {
      const why = `Collected nothing: ${count(r.planned.length, 'day')} due, but the request budget (${gh.budget}) did not cover even one. The token is probably spent for this hour; re-run the workflow after it resets.`;
      env.io.err(`${why}\n`);
      summary(env, `### CI Steward collector: nothing collected\n\n${why}`);
      return 1;
    }
    if (!r.healthy) {
      env.io.err(`UNHEALTHY:\n${r.failures.map((f) => `  - ${f}`).join('\n')}\n`);
      summary(
        env,
        `### CI Steward collector: unhealthy\n\n${r.failures.map((f) => `- ${f}`).join('\n')}`
      );
    }
    return r.healthy ? 0 : 1;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * `verdicts`: compute every ledger entry's verdict into the data directory.
 *
 * @param env - The environment.
 * @param dataDir - A working tree of the data branch.
 * @param gh - The client for merge times (optional; built from env otherwise).
 */
export function cmdVerdicts(env: Env, dataDir: string, gh?: Gh): number {
  const ledger = readLedger(env.root, env.files);
  const client = gh ?? env.gh(new Set(ledger.flatMap((e) => e.prs)).size + 5);
  const merged = fetchMergeTimes(client, env.files.config.github_repo, ledger);
  const vs = runVerdicts(ctx(env, dataDir), ledger, merged);
  for (const v of vs) env.io.out(`${v.id}: ${v.verdict}. ${v.reason}\n`);
  return 0;
}

/** `triggers.json`, or null before the first triage run. */
function readTriggers(dataDir: string): Triggers | null {
  return readData(dataDir, 'triggers.json', TriggersSchema);
}

/**
 * `triage`: today's improvement triggers, written to `triggers.json` and
 * summarised into `latest.json`. It reads only what is already on the data
 * branch, so it needs no GitHub access and can run after a day the collector
 * spent its whole budget on.
 *
 * @param env - The environment.
 * @param dataDir - A working tree of the data branch.
 * @returns Exit code 0; a trigger is never an error.
 */
export function cmdTriage(env: Env, dataDir: string): number {
  const latest = readData(dataDir, 'latest.json', LatestSchema);
  if (!latest) {
    env.io.err('triage needs a latest.json on the data branch; run collect first.\n');
    return 1;
  }
  const triggers = triage({
    files: env.files,
    ledger: readLedger(env.root, env.files),
    verdicts: loadVerdicts(dataDir),
    latest,
    workflows: env.workflows,
    snapshots: loadSnapshots(dataDir, daysBetween(addDays(latest.date, -27), latest.date)),
    prior: readTriggers(dataDir),
    now: env.now,
  });
  writeData(dataDir, 'triggers.json', triggers);
  const counts = triggerSummary(triggers);
  writeData(dataDir, 'latest.json', { ...latest, triggers: counts } satisfies Latest);
  env.io.out(
    `triggers: ${counts.red} red, ${counts.amber} amber${
      triggers.cleared.length ? `, ${triggers.cleared.length} cleared` : ''
    }\n`
  );
  for (const t of triggers.open) env.io.out(`  [${t.severity}] ${t.id}: ${t.what}\n`);
  return 0;
}

/**
 * Write `reports/<day>.html` and the index that lists the days.
 *
 * @param env - The environment.
 * @param dataDir - A working tree of the data branch (or a copy of one).
 * @param day - The day to report; the day `latest.json` points at by default.
 * @param local - Marks the page as built by hand rather than by the daily job.
 * @returns The path written, relative to the data directory, or null.
 */
function writeDailyReport(env: Env, dataDir: string, day?: string, local = false): string | null {
  const latest = readData(dataDir, 'latest.json', LatestSchema);
  if (!latest) {
    env.io.err('no latest.json on the data branch; run collect first.\n');
    return null;
  }
  const on = day ?? latest.date;
  if (on !== latest.date) {
    // latest.json and triggers.json hold ONE day's readings: the newest. A page
    // for any other day would carry today's headline, constraint, SLO table and
    // trigger list under yesterday's date, and the index would file it as that
    // day. Refuse rather than publish a page that is wrong about its own date.
    env.io.err(
      `--day ${on} cannot be rebuilt: the data branch carries one set of readings, for ${latest.date}, so a page for ${on} would show ${latest.date}'s numbers under ${on}'s name. The page written on ${on} is at ${reportPath(on)} on the branch.\n`
    );
    return null;
  }
  const { html, index } = renderDailyReport({
    files: env.files,
    dataDir,
    day: on,
    latest,
    triggers: readTriggers(dataDir),
    verdicts: loadVerdicts(dataDir),
    ledger: readLedger(env.root, env.files),
    workflows: env.workflows,
    now: env.now,
    local,
  });
  const rel = reportPath(on);
  writeData(dataDir, rel, html);
  const idx = updateIndex(readData(dataDir, INDEX_DATA, ReportIndexSchema), index, env.now);
  writeData(dataDir, INDEX_DATA, idx);
  writeData(dataDir, INDEX_PATH, renderIndex(idx, env.now));
  return rel;
}

/**
 * `daily-report` (`pnpm ci:report`): build the day's HTML report and print
 * where it landed.
 *
 * Without `--data` it works on a throwaway copy of the data branch, so it
 * touches nothing. With `--data <dir>` it writes the page and the index into
 * that working tree, exactly as the daily job does; it never commits and never
 * pushes, so nothing reaches the branch until `data-publish` runs.
 *
 * A `--day` other than the newest is served from the page already on the
 * branch, because only the newest day's readings exist to rebuild from.
 *
 * @param env - The environment.
 * @param opts - The day; a data directory to write into; whether to open the page.
 */
export function cmdDailyReport(
  env: Env,
  opts: { day?: string; data?: string; open?: boolean }
): number {
  // A temp copy is left on disk on purpose: the page is the point, and the
  // caller is told exactly where it is.
  const dir = opts.data ?? mkdtempSync(path.join(tmpdir(), 'ci-steward-report-'));
  if (opts.data === undefined) {
    const ref = `origin/${env.files.config.data_branch}`;
    try {
      const tar = execFileSync('git', ['archive', '--format=tar', ref], {
        cwd: env.root,
        maxBuffer: 512 * 1024 * 1024,
      });
      execFileSync('tar', ['-x', '-C', dir], { input: tar });
    } catch {
      env.io.err(
        `${env.root} has no ${ref}. Run \`git fetch origin ${env.files.config.data_branch}\`, or pass --data <dir>.\n`
      );
      return 1;
    }
  }
  const latest = readData(dir, 'latest.json', LatestSchema);
  // An older day is not rebuilt, but the page written that day is right there.
  if (opts.day && latest && opts.day !== latest.date) {
    const already = path.join(dir, reportPath(opts.day));
    if (!existsSync(already)) {
      env.io.err(
        `No report for ${opts.day} on the data branch, and it cannot be rebuilt: the branch carries one set of readings, for ${latest.date}. Days with a page: ${reportDays(dir).join(', ') || 'none'}.\n`
      );
      return 1;
    }
    env.io.out(`${already}\n`);
    openPage(env, already, opts.open === true);
    return 0;
  }
  const rel = writeDailyReport(env, dir, opts.day, true);
  if (!rel) return 1;
  const abs = path.join(dir, rel);
  env.io.out(`${abs}\n`);
  openPage(env, abs, opts.open === true);
  return 0;
}

/** Every day with a report page in a data directory, newest first. */
function reportDays(dataDir: string): string[] {
  const dir = path.join(dataDir, 'reports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((n) => (/^\d{4}-\d{2}-\d{2}\.html$/.test(n) ? [n.slice(0, 10)] : []))
    .sort()
    .reverse();
}

/** Hand a page to the desktop, when asked. A failure to open is not a failure to build. */
function openPage(env: Env, abs: string, open: boolean): void {
  if (!open) return;
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  try {
    execFileSync(opener, [abs], { stdio: 'ignore' });
  } catch {
    env.io.err(`could not open the page with ${opener}; it is at ${abs}\n`);
  }
}

/**
 * `report`: the weekly report for the week before `now`, and the floors.
 *
 * @param env - The environment.
 * @param dataDir - A working tree of the data branch.
 */
export function cmdReport(env: Env, dataDir: string): number {
  const ledger = readLedger(env.root, env.files);
  const r = runReport(ctx(env, dataDir), ledger, loadVerdicts(dataDir));
  env.io.out(
    `wrote ${r.path}${r.floorChanges.length ? `; floors: ${r.floorChanges.join('; ')}` : ''}\n`
  );
  return 0;
}

/**
 * `daily`: what the workflow runs between prepare and publish. Collect, then
 * verdicts, then (on Mondays) the report. The exit code is the collector's
 * health, so an unhealthy day turns the run red after everything is written.
 *
 * @param env - The environment.
 * @param dataDir - A working tree of the data branch.
 */
export function cmdDaily(env: Env, dataDir: string): number {
  const health = cmdCollect(env, dataDir);
  const ledger = readLedger(env.root, env.files);
  let merged: Map<number, string>;
  try {
    // Its own small budget: one request per PR the ledger names, so a day the
    // collector spent its whole budget on still gets its verdicts.
    const prs = new Set(ledger.flatMap((e) => e.prs)).size;
    merged = fetchMergeTimes(env.gh(prs + 5), env.files.config.github_repo, ledger);
  } catch (e) {
    env.io.err(
      `verdicts skipped: could not read merge times (${e instanceof Error ? e.message : String(e)})\n`
    );
    return 1;
  }
  const verdicts = runVerdicts(ctx(env, dataDir), ledger, merged);
  env.io.out(`verdicts: ${verdicts.map((v) => `${v.id} ${v.verdict}`).join(', ') || 'none'}\n`);
  // Triage and the page are reported on their own. A crash in either must not
  // read as a collector-health failure, which is what the exit code means here.
  const triaged = cmdTriage(env, dataDir);
  if (triaged !== 0) env.io.err('triage failed; the page below has no triggers on it\n');
  const page = writeDailyReport(env, dataDir);
  if (page) env.io.out(`wrote ${page}\n`);
  else env.io.err('the daily report was not written\n');
  // Monday's deep summary: week over week, the verdicts closed, the floors moved.
  if (env.now.getUTCDay() === 1) {
    const r = runReport(ctx(env, dataDir), ledger, verdicts);
    env.io.out(`wrote ${r.path}\n`);
  }
  return health;
}

/**
 * `data-prepare`: a working tree of the data branch at `dir`, bootstrapping it
 * only on the very first run and refusing to recreate a lost branch.
 *
 * @param env - The environment.
 * @param dir - Where the working tree goes.
 */
export function cmdDataPrepare(env: Env, dir: string): number {
  try {
    const r = prepareDataDir(env.git, ref(env), dir);
    env.io.out(
      r.bootstrapped
        ? `created the ${env.files.config.data_branch} branch (first run): no branch and no backup tag existed\n`
        : `checked out ${env.files.config.data_branch} at ${dir}\n`
    );
    return 0;
  } catch (e) {
    if (!(e instanceof DataBranchMissing)) throw e;
    env.io.err(`${e.message}\n`);
    summary(
      env,
      `### CI Steward: the data branch is missing\n\n${e.message.replace(/\n\n {2}(.+)\n$/, '\n\n```sh\n$1\n```')}`
    );
    return 1;
  }
}

/**
 * `data-publish`: commit and push the working tree, then tag this ISO week's
 * backup if it is still missing (on Monday's run, or the first run after a
 * failed one).
 *
 * @param env - The environment.
 * @param dir - The working tree.
 * @param opts - Commit message; whether to tag the week.
 */
export function cmdDataPublish(
  env: Env,
  dir: string,
  opts: { message?: string; tagWeek?: boolean }
): number {
  const message = opts.message ?? `collect ${dayOf(env.now)}`;
  const sha = publish(env.git, ref(env), dir, message);
  env.io.out(
    sha === 'nothing'
      ? 'nothing to publish\n'
      : `pushed ${sha.slice(0, 12)} to ${env.files.config.data_branch}\n`
  );
  // The pushed head, or when nothing changed, the remote head it is checked out at.
  if (opts.tagWeek && gitOut(env.git, dir, ['rev-parse', '--verify', '--quiet', 'HEAD'])) {
    const t = tagWeek(env.git, ref(env), dir, isoWeek(env.now));
    if (t.created) env.io.out(`tagged ${t.tag}\n`);
  }
  return 0;
}

/**
 * `status`: the one-screen view, from the data branch (or a directory).
 *
 * @param env - The environment.
 * @param opts - A ref to read (default `origin/<data_branch>`), or a directory.
 */
export function cmdStatus(env: Env, opts: { ref?: string; data?: string }): number {
  const reader = opts.data
    ? dirReader(opts.data)
    : gitReader(env.root, opts.ref ?? `origin/${env.files.config.data_branch}`);
  env.io.out(renderStatus(reader, readLedger(env.root, env.files), env.now));
  return 0;
}

function gitOut(git: Git, cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

/**
 * This clone's local-timing export for every finished day in its timings file.
 *
 * @param env - The environment.
 * @param clone - The export name, when given.
 */
function localDays(env: Env, clone?: string) {
  const common = gitOut(env.git, env.root, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  if (!common) return null;
  const file = path.join(common, env.files.config.local.timings_file);
  const name = clone ?? env.cloneName ?? defaultCloneName(common);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const nowSec = Math.floor(env.now.getTime() / 1000);
  const runs = hookRuns(parseTimings(text), nowSec, env.files.config.local.killed_after_seconds);
  // Only days rotation has not started trimming: re-exporting a half-trimmed
  // day would overwrite its full export with fewer runs.
  const oldest = addDays(dayOf(env.now), -(env.files.config.local.retention_days - 2));
  const days = aggregateDays(runs, name, dayOf(env.now), env.now.toISOString()).filter(
    (d) => d.date >= oldest
  );
  return { file, name, days };
}

/**
 * `local-export`: push this clone's local hook timings to `local/<clone>/`,
 * then rotate the timings file.
 *
 * @param env - The environment.
 * @param opts - The clone name; `push: false` writes nowhere but reports.
 */
export function cmdLocalExport(env: Env, opts: { clone?: string; push: boolean }): number {
  const l = localDays(env, opts.clone);
  if (!l) {
    env.io.err('local-export must run inside a git checkout\n');
    return 2;
  }
  env.io.out(`clone ${l.name}: ${count(l.days.length, 'finished day')} in ${l.file}\n`);
  if (opts.push) {
    const r = ref(env);
    const dir = mkdtempSync(path.join(tmpdir(), 'ci-steward-local-'));
    rmSync(dir, { recursive: true, force: true });
    try {
      const head = gitOut(env.git, env.root, [
        'ls-remote',
        '--heads',
        r.remote,
        `refs/heads/${r.branch}`,
      ]);
      if (!head) {
        env.io.out(
          `the ${r.branch} branch does not exist yet; nothing pushed (the daily collector creates it). The timings stay in the file.\n`
        );
        return 0;
      }
      prepareDataDir(env.git, r, dir);
      for (const d of l.days) writeData(dir, `local/${l.name}/${d.date}.json`, d);
      // The heartbeat goes out on every run, so an idle clone is not a stale one.
      writeData(dir, `local/${l.name}/exported.json`, {
        schema: 1,
        clone: l.name,
        exported_at: env.now.toISOString(),
      });
      const sha = publish(env.git, r, dir, `local-export ${l.name} ${dayOf(env.now)}`);
      env.io.out(sha === 'nothing' ? 'already up to date\n' : `pushed ${sha.slice(0, 12)}\n`);
    } finally {
      removeDataDir(env.git, r, dir);
    }
  }
  const rot = rotateTimings(
    l.file,
    Math.floor(env.now.getTime() / 1000),
    env.files.config.local.retention_days,
    env.files.config.local.max_bytes
  );
  if (rot.dropped)
    env.io.out(`rotated ${l.file}: dropped ${count(rot.dropped, 'old line')}, kept ${rot.kept}\n`);
  return 0;
}

/**
 * `pulse`: collect now, locally, into a temp directory seeded from the data
 * branch, and print what `status` would show. Never pushes anything.
 *
 * @param env - The environment.
 * @param opts - Keep the temp directory afterwards.
 */
export function cmdPulse(env: Env, opts: { keep?: boolean }): number {
  const dir = mkdtempSync(path.join(tmpdir(), 'ci-steward-pulse-'));
  const data = `origin/${env.files.config.data_branch}`;
  try {
    const seeded = gitOut(env.git, env.root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${data}^{commit}`,
    ]);
    if (seeded) {
      const tar = execFileSync('git', ['archive', '--format=tar', data], {
        cwd: env.root,
        maxBuffer: 512 * 1024 * 1024,
      });
      execFileSync('tar', ['-x', '-C', dir], { input: tar });
      env.io.out(`seeded from ${data}\n`);
    } else env.io.out(`${data} does not exist here; collecting into an empty directory\n`);
    const yesterday = addDays(dayOf(env.now), -1);
    const have = readData(dir, snapshotPath(yesterday), SnapshotSchema);
    const days = have?.complete ? [] : [yesterday];
    const code = cmdCollect(env, dir, { days, today: true });
    const l = localDays(env);
    for (const d of l?.days ?? []) writeData(dir, `local/${l!.name}/${d.date}.json`, d);
    const newest = snapshotDays(dir).at(-1);
    // A pulse shows today so far, the partial day, not the newest complete one.
    const prior = readData(dir, 'latest.json', LatestSchema);
    if (newest)
      writeLatest(ctx(env, dir), newest, {
        apiCalls: prior?.api_calls ?? 0,
        failures: prior?.failures ?? [],
      });
    cmdVerdicts(env, dir);
    cmdTriage(env, dir);
    env.io.out('\n');
    cmdStatus(env, { data: dir });
    env.io.out(`\n(pulse: collected locally, pushed nothing${opts.keep ? `; kept ${dir}` : ''})\n`);
    return code;
  } finally {
    if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  }
}

#!/usr/bin/env node
/**
 * `ci-steward` command line. Node runs this file directly (type stripping):
 *
 *   node packages/ci-steward/src/cli.ts census [--fix]
 *   node packages/ci-steward/src/cli.ts ledger-check
 *   node packages/ci-steward/src/cli.ts ledger-check --coverage --base <sha> [--branch <name>]
 *   node packages/ci-steward/src/cli.ts ledger-new --slug <slug> [--kind <kind>] [--title <title>]
 *
 * Every command also takes `--root <dir>` (default: the nearest directory, from
 * the working directory up, holding `ci/config.yaml`) and `--now <ISO time>` (the
 * real clock by default), so nothing depends on where or when it runs unless asked.
 *
 * Exit codes: 0 clean, 1 findings, 2 bad usage or an internal error.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { runCensus, discoverGates } from './census.ts';
import { checkCoverage, type ChangedFile } from './coverage.ts';
import { readRootScripts } from './discover.ts';
import { formatFindings, type Finding } from './finding.ts';
import { allocateId } from './ids.ts';
import { checkLedger, LEDGER_FILE_RE } from './ledger.ts';
import {
  buildEnv,
  cmdCollect,
  cmdDaily,
  cmdDailyReport,
  cmdTriage,
  cmdDataPrepare,
  cmdDataPublish,
  cmdLocalExport,
  cmdPulse,
  cmdReport,
  cmdStatus,
  cmdVerdicts,
  type Deps,
} from './commands.ts';
import { quarantine } from './cli-quarantine.ts';
import { tokenGit } from './data-branch.ts';
import { CONFIG_PATH, loadHandFiles } from './load.ts';
import { isDay } from './time.ts';
import { loadWorkflows } from './workflows.ts';

/** Where a command writes. */
export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `usage: ci-steward <command> [options]

commands:
  census [--fix]
      Check that ci/ matches the workflows, lefthook and Claude hooks that run.
      --fix rewrites the generated required-checks blocks in the docs, nothing else.
  ledger-check
      Validate every ci/ledger entry.
  ledger-check --coverage --base <sha> [--branch <name>]
      Pull-request check: a pipeline change must add or edit a ledger entry, and a
      ci-improve/* branch may not touch the steward's own files.
  ledger-new --slug <kebab-slug> [--kind experiment|incident-fix|hygiene] [--title <text>]
      Scaffold ci/ledger/<YYMMDD-HHMMSS>-<slug>.md with a fresh id and print its path.
      --kind defaults to experiment; hygiene entries get no hypothesis block.

observe (phase 1; GitHub through the gh CLI, git for the data branch):
  collect --data <dir> [--day YYYY-MM-DD]... [--today]
      Snapshots for the planned days (yesterday, missing or late recent days,
      then backfill) into a data-branch working tree, then latest.json.
      Exit 1 when the collector's health failed.
  verdicts --data <dir>
      Compute verdicts/<ledger-id>.json for every entry with a hypothesis.
  triage --data <dir>
      The improvement triggers: what is worth doing something about, from the
      data alone. Writes triggers.json and the summary in latest.json.
  report --data <dir>
      The Monday deep summary for the week before --now, and the floors.
  daily-report [--day YYYY-MM-DD] [--data <dir>] [--open]
      Build the day's HTML report. Without --data it copies origin/<data
      branch> to a temp directory first; it never writes to the branch and
      never pushes. Prints the page's path.
  daily --data <dir>
      collect, verdicts, triage, the day's HTML report, and on Mondays the
      weekly deep summary: what the workflow runs.
  data-prepare --data <dir>
      Check out the data branch at <dir>. Creates it only when neither the
      branch nor any backup tag exists; refuses (and names the restore
      command) when the branch is gone but a tag exists.
  data-publish --data <dir> [--message <text>] [--tag-week]
      Commit and push <dir> with fetch-rebase-retry; --tag-week tags the head
      ci-steward-data/<YYYY-Www> when this week has no backup tag yet.
      Pushes with CI_STEWARD_PUSH_TOKEN when it is set (the workflow's token).
  status [--ref <ref> | --data <dir>]
      One screen: SLOs, constraint, experiments with verdicts, health. Reads
      origin/ci-steward-data by default (no network; fetch first).
  pulse [--keep]
      Collect now into a temp directory and show status from it. Pushes nothing.
  local-export [--clone <name>] [--no-push]
      Export this clone's lefthook timings to local/<clone>/ and rotate the file.

quarantine (the lane for tests data has classified flaky; plan §4.9 L1):
  flaky [--days N] [--fetch [--builds N]] [--data <dir>] [--json]
      Tests that failed and then passed on the same merge-group tree, with
      counts, dates and whether each one qualifies. Reads the data branch;
      --fetch reads Actions artifacts live instead (they expire after 7 days).
  quarantine list [--json]
      The lane as the queue will read it, expiry applied.
  quarantine add --runner playwright|vitest --file <f> --title <t> --reason <why>
                 [--expiry-days N] [--by <who>] [--fetch | --evidence <json>]
                 [--ledger <id>] [--publish]
      Refuses a test with no flaky evidence: a deterministic failure is a real
      bug and the lane must never hide one. Writes the 'fix or delete this test'
      ledger entry. Publishes nothing without --publish.
  quarantine remove --runner <r> --file <f> --title <t> [--publish]
      Works even on a list no reader honours: that is the repair.
  quarantine reset [--publish]
      Replace the list with an empty one, for a file that does not parse.
  quarantine-list --runner <r> [--out <json>] [--lines <txt>] [--title <t>]
                  [--offline]   (--runner is REQUIRED: the lines carry none)
      What a queue job reads the list with, filtered to its own runner. ALWAYS
      exits 0: an unreadable list writes an empty one, and empty means every
      test blocks as normal.
  quarantine-gate --runner <r> --suite-exit <n> --reports <path>... [--list <f>]
                  [--title <t>]
      Passes only when the runner's own failure tally is exactly the set the
      lane absorbed.

every command:
  --root <dir>   repo root (default: the nearest directory up holding ci/config.yaml)
  --now <iso>    the clock (default: now); decides allowlist expiry and new ledger ids

exit codes: 0 clean, 1 findings, 2 bad usage or an internal error
root aliases: pnpm ci:census, ci:ledger-check, ci:ledger-new, ci:status, ci:pulse,
              ci:report (daily-report), ci:local-export
              ci:local-export, ci:flaky, ci:quarantine
`;

function findRoot(start: string): string | null {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, CONFIG_PATH))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

/** Parse `git diff --name-status --no-renames -z`: status, NUL, path, NUL, repeated. */
function parseChanged(nameStatusZ: string): ChangedFile[] {
  const parts = nameStatusZ.split('\0').filter((p) => p !== '');
  const out: ChangedFile[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    out.push({ status: parts[i]!.charAt(0), path: parts[i + 1]! });
  }
  return out;
}

function gitShow(root: string, rev: string, rel: string): string | null {
  try {
    return execFileSync('git', ['show', `${rev}:${rel}`], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

function report(io: Io, tool: string, findings: Finding[]): number {
  (findings.length ? io.err : io.out)(formatFindings(tool, findings));
  return findings.length ? 1 : 0;
}

function ledgerCheck(
  root: string,
  io: Io,
  opts: { coverage: boolean; base?: string; branch?: string }
): number {
  const { files, findings } = loadHandFiles(root);
  if (!files) return report(io, 'ledger-check', findings);
  if (!opts.coverage) return report(io, 'ledger-check', [...findings, ...checkLedger(root, files)]);
  if (!opts.base) {
    io.err('ledger-check --coverage needs --base <sha>: the commit the PR is compared against.\n');
    return 2;
  }
  const workflows = loadWorkflows(root, files.config.workflows_dir, () => undefined);
  const gates = discoverGates(root, files, workflows, findings);
  const branch = opts.branch || git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const changed = parseChanged(
    git(root, ['diff', '--name-status', '--no-renames', '-z', opts.base, 'HEAD'])
  );
  const rootScripts = readRootScripts(root, files.config.root_package_json);
  const base = opts.base;
  const coverage = checkCoverage({
    root,
    files,
    workflows,
    gates,
    rootScripts,
    changed,
    branch,
    readBase: (rel) => gitShow(root, base, rel),
    readHead: (rel) => gitShow(root, 'HEAD', rel),
  });
  return report(io, 'ledger-check --coverage', [...findings, ...coverage]);
}

function ledgerNew(
  root: string,
  io: Io,
  now: Date,
  opts: { slug?: string; kind?: string; title?: string }
): number {
  const kinds = ['experiment', 'incident-fix', 'hygiene'];
  const kind = opts.kind ?? 'experiment';
  if (!opts.slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(opts.slug) || !kinds.includes(kind)) {
    io.err(
      `ledger-new needs --slug <kebab-case> and, optionally, --kind one of ${kinds.join(', ')}. See ledger-new --help.\n`
    );
    return 2;
  }
  const { files, findings } = loadHandFiles(root);
  if (!files) return report(io, 'ledger-new', findings);
  const dir = path.join(root, files.config.ledger_dir);
  mkdirSync(dir, { recursive: true });
  const taken = new Set(
    readdirSync(dir).flatMap((n) => {
      const id = LEDGER_FILE_RE.exec(n)?.[1];
      return id ? [id] : [];
    })
  );
  const id = allocateId((x) => taken.has(x), now);
  const rel = `${files.config.ledger_dir}/${id}-${opts.slug}.md`;
  const hypothesis =
    kind === 'hygiene'
      ? ''
      : [
          'hypothesis:',
          '  metric: <a ci/metrics.yaml id, the narrowest one this change can move>',
          '  slo: <optional SLO id from ci/slos.yaml>',
          '  baseline: <number>',
          '  baseline_source: <the run sample, report or PR the baseline was read from>',
          '  target: <number>',
          '  after_days: 14',
          '',
        ].join('\n');
  const text = [
    '---',
    `id: ${id}`,
    `title: ${opts.title ?? '<one line: what changes>'}`,
    `kind: ${kind}`,
    'status: proposed',
    'actor: agent',
    'gates: []',
    'prs: []',
    hypothesis + 'ratchet-release: []',
    'field-changes: []',
    '---',
    '',
    'Why, what was tried, and what would make us revert. Short.',
    '',
  ].join('\n');
  writeFileSync(path.join(root, rel), text, { flag: 'wx' });
  io.out(`${rel}\n`);
  return 0;
}

/** What the phase-1 commands reach outside the process through; tests replace it. */
export type { Deps };

const NEEDS_DATA = new Set([
  'collect',
  'verdicts',
  'triage',
  'report',
  'daily',
  'data-prepare',
  'data-publish',
]);

function observe(
  command: string,
  root: string,
  now: Date,
  io: Io,
  values: {
    data?: string;
    day?: string[];
    today?: boolean;
    ref?: string;
    keep?: boolean;
    open?: boolean;
    clone?: string;
    'no-push'?: boolean;
    message?: string;
    'tag-week'?: boolean;
  },
  deps: Deps
): number {
  const { files, findings } = loadHandFiles(root);
  if (!files || findings.length) return report(io, command, findings);
  if (NEEDS_DATA.has(command) && !values.data) {
    io.err(
      `${command} needs --data <dir>: a working tree of the ${files.config.data_branch} branch.\n`
    );
    return 2;
  }
  const bad = (values.day ?? []).filter((d) => !isDay(d));
  if (bad.length) {
    io.err(`--day ${bad.join(', ')} is not a YYYY-MM-DD day.\n`);
    return 2;
  }
  const env = buildEnv(root, files, now, io, deps);
  const data = values.data ? path.resolve(values.data) : '';
  switch (command) {
    case 'collect':
      return cmdCollect(env, data, { days: values.day, today: values.today });
    case 'verdicts':
      return cmdVerdicts(env, data);
    case 'triage':
      return cmdTriage(env, data);
    case 'daily-report':
      return cmdDailyReport(env, {
        day: values.day?.[0],
        data: values.data ? data : undefined,
        open: values.open,
      });
    case 'report':
      return cmdReport(env, data);
    case 'daily':
      return cmdDaily(env, data);
    case 'data-prepare':
      return cmdDataPrepare(env, data);
    case 'data-publish':
      return cmdDataPublish(env, data, {
        message: values.message,
        tagWeek: values['tag-week'],
      });
    case 'status':
      return cmdStatus(env, { ref: values.ref, data: values.data ? data : undefined });
    case 'pulse':
      return cmdPulse(env, { keep: values.keep });
    default:
      return cmdLocalExport(env, { clone: values.clone, push: values['no-push'] !== true });
  }
}

/**
 * Run one command.
 *
 * @param argv - Arguments after the script path.
 * @param io - Output sinks.
 * @param cwd - Where to start looking for the repo root.
 * @param deps - GitHub and git access for the phase-1 commands (tests inject fakes).
 */
export function main(
  argv: readonly string[],
  io: Io,
  cwd: string = process.cwd(),
  deps: Deps = {}
): number {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        fix: { type: 'boolean' },
        coverage: { type: 'boolean' },
        base: { type: 'string' },
        branch: { type: 'string' },
        slug: { type: 'string' },
        kind: { type: 'string' },
        title: { type: 'string' },
        root: { type: 'string' },
        now: { type: 'string' },
        data: { type: 'string' },
        day: { type: 'string', multiple: true },
        today: { type: 'boolean' },
        ref: { type: 'string' },
        keep: { type: 'boolean' },
        open: { type: 'boolean' },
        clone: { type: 'string' },
        'no-push': { type: 'boolean' },
        message: { type: 'string' },
        'tag-week': { type: 'boolean' },
        days: { type: 'string' },
        fetch: { type: 'boolean' },
        builds: { type: 'string' },
        json: { type: 'boolean' },
        runner: { type: 'string' },
        file: { type: 'string' },
        reports: { type: 'string', multiple: true },
        'suite-exit': { type: 'string' },
        list: { type: 'string' },
        offline: { type: 'boolean' },
        out: { type: 'string' },
        lines: { type: 'string' },
        reason: { type: 'string' },
        by: { type: 'string' },
        'expiry-days': { type: 'string' },
        evidence: { type: 'string' },
        ledger: { type: 'string' },
        publish: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help || positionals[0] === 'help' || positionals.length === 0) {
    (positionals.length === 0 && !values.help ? io.err : io.out)(USAGE);
    return positionals.length === 0 && !values.help ? 2 : 0;
  }
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    io.err(`--now ${values.now} is not a date.\n`);
    return 2;
  }
  const root = values.root ? path.resolve(values.root) : findRoot(cwd);
  if (!root || !existsSync(path.join(root, CONFIG_PATH))) {
    io.err(`No ${CONFIG_PATH} found${values.root ? ` under ${values.root}` : ` above ${cwd}`}.\n`);
    return 2;
  }
  switch (positionals[0]) {
    case 'census': {
      const result = runCensus({ root, now, fix: values.fix });
      for (const f of result.fixed) io.out(`rewrote the generated block in ${f}\n`);
      return report(io, 'census', result.findings);
    }
    case 'ledger-check':
      return ledgerCheck(root, io, {
        coverage: values.coverage === true,
        base: values.base,
        branch: values.branch,
      });
    case 'ledger-new':
      return ledgerNew(root, io, now, values);
    case 'collect':
    case 'verdicts':
    case 'triage':
    case 'report':
    case 'daily-report':
    case 'daily':
    case 'data-prepare':
    case 'data-publish':
    case 'status':
    case 'pulse':
    case 'local-export':
      return observe(positionals[0], root, now, io, values, deps);
    case 'flaky':
    case 'quarantine':
    case 'quarantine-list':
    case 'quarantine-gate':
      return quarantine(positionals[0], root, now, io, values, positionals, deps);
    default:
      io.err(USAGE);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  // The one place the engine reads the environment.
  // eslint-disable-next-line no-restricted-syntax -- the CLI entry is this package's env boundary
  const { GITHUB_STEP_SUMMARY, CI_STEWARD_CLONE, CI_STEWARD_PUSH_TOKEN } = process.env;
  try {
    process.exitCode = main(
      process.argv.slice(2),
      { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
      process.cwd(),
      {
        stepSummary: GITHUB_STEP_SUMMARY,
        cloneName: CI_STEWARD_CLONE,
        git: CI_STEWARD_PUSH_TOKEN ? tokenGit(CI_STEWARD_PUSH_TOKEN) : undefined,
      }
    );
  } catch (e) {
    process.stderr.write(
      `ci-steward: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
    );
    process.exitCode = 2;
  }
}

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
import { CONFIG_PATH, loadHandFiles } from './load.ts';
import { loadWorkflows } from './workflows.ts';

/** Where a command writes. */
export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const USAGE = `usage: ci-steward <census [--fix] | ledger-check [--coverage --base <sha> [--branch <name>]] | ledger-new --slug <slug> [--kind experiment|incident-fix|hygiene] [--title <text>]> [--root <dir>] [--now <iso>]\n`;

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

function parseChanged(nameStatus: string): ChangedFile[] {
  return nameStatus
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { status: status!.charAt(0), path: rest.at(-1)! };
    });
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
    git(root, ['diff', '--name-status', '--no-renames', opts.base, 'HEAD'])
  );
  const rootScripts = readRootScripts(root, files.config.root_package_json);
  const coverage = checkCoverage({ root, files, workflows, gates, rootScripts, changed, branch });
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
    io.err(`ledger-new needs --slug <kebab-case> and --kind one of ${kinds.join(', ')}.\n`);
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

/**
 * Run one command.
 *
 * @param argv - Arguments after the script path.
 * @param io - Output sinks.
 * @param cwd - Where to start looking for the repo root.
 */
export function main(argv: readonly string[], io: Io, cwd: string = process.cwd()): number {
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
      },
    });
  } catch (e) {
    io.err(`${e instanceof Error ? e.message : String(e)}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
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
    default:
      io.err(USAGE);
      return 2;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === import.meta.filename;
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2), {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    });
  } catch (e) {
    process.stderr.write(
      `ci-steward: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`
    );
    process.exitCode = 2;
  }
}

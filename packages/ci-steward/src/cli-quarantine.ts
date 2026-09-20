/**
 * The command line's quarantine half: option parsing and dispatch for `flaky`,
 * `quarantine`, `quarantine-list` and `quarantine-gate`.
 *
 * Split from `cli.ts` so the option surface of the lane — which is the widest
 * of any command here, because an add carries a whole piece of evidence — does
 * not crowd out the rest of the tool.
 */
import path from 'node:path';
import { buildEnv, type Deps } from './commands.ts';
import { formatFindings } from './finding.ts';
import { loadHandFiles } from './load.ts';
import { RUNNERS, type Runner } from './quarantine.ts';
import { cmdFlaky } from './flaky-sources.ts';
import { cmdQuarantine, cmdQuarantineGate, cmdQuarantineList } from './quarantine-commands.ts';
import type { Io } from './cli.ts';

/** Options the quarantine commands read off the command line. */
interface QuarantineValues {
  days?: string;
  fetch?: boolean;
  builds?: string;
  json?: boolean;
  data?: string;
  runner?: string;
  file?: string;
  title?: string;
  reports?: string[];
  'suite-exit'?: string;
  list?: string;
  offline?: boolean;
  out?: string;
  lines?: string;
  reason?: string;
  by?: string;
  'expiry-days'?: string;
  publish?: boolean;
  evidence?: string;
  ledger?: string;
}

/**
 * Parse a whole-number option: `undefined` when absent, `null` when unusable.
 *
 * The blank check is not pedantry. `Number('')` is 0, and the workflows pass
 * `--suite-exit "${{ steps.suite.outputs.exit-code }}"`, which is EMPTY
 * whenever the suite step died before reaching its echo — a runner killed at
 * the step timeout, most of all. Reading that as exit 0 would turn the one
 * case the gate exists to catch into a silent pass.
 *
 * @param io - Where the refusal is written.
 * @param name - The option's name, for the message.
 * @param raw - What the command line carried.
 */
function intOpt(io: Io, name: string, raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (raw.trim() === '') {
    io.err(
      `--${name} was empty. An empty value is not zero: it means whatever was meant to produce it never did, and this refuses to read that as success.\n`
    );
    return null;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    io.err(`--${name} ${raw} is not a whole number.\n`);
    return null;
  }
  return n;
}

/**
 * Dispatch `flaky`, `quarantine`, `quarantine-list` and `quarantine-gate`.
 *
 * @param command - The positional command.
 * @param root - Repo root.
 * @param now - The clock.
 * @param io - Where it writes.
 * @param values - The parsed options.
 * @param positionals - All positionals, for `quarantine <action>`.
 * @param deps - Injected GitHub and git access.
 */
export function quarantine(
  command: string,
  root: string,
  now: Date,
  io: Io,
  values: QuarantineValues,
  positionals: readonly string[],
  deps: Deps
): number {
  const { files, findings } = loadHandFiles(root);
  if (!files || findings.length) {
    io.err(formatFindings(command, findings));
    return 1;
  }
  const env = buildEnv(root, files, now, io, deps);
  const days = intOpt(io, 'days', values.days);
  const builds = intOpt(io, 'builds', values.builds);
  const expiry = intOpt(io, 'expiry-days', values['expiry-days']);
  if (days === null || builds === null || expiry === null) return 2;
  if (command === 'flaky') {
    return cmdFlaky(env, {
      data: values.data ? path.resolve(values.data) : undefined,
      days,
      fetch: values.fetch,
      json: values.json,
      builds,
    });
  }
  const runner = values.runner;
  if (runner !== undefined && !(RUNNERS as readonly string[]).includes(runner)) {
    io.err(`--runner ${runner} is not one of ${RUNNERS.join(', ')}.\n`);
    return 2;
  }
  if (command === 'quarantine-list') {
    // Required, not optional. The `--lines` file carries no runner, so a caller
    // who omits this hands a vitest entry to the browser gate and ejects every
    // queue build. There is no non-CI caller to inconvenience.
    if (!runner) {
      io.err(
        `quarantine-list needs --runner ${RUNNERS.join('|')}: the list it writes carries no runner, so the caller has to say which one it is reading for.\n`
      );
      return 2;
    }
    return cmdQuarantineList(env, {
      runner: runner as Runner,
      out: values.out,
      lines: values.lines,
      title: values.title,
      offline: values.offline,
    });
  }
  if (command === 'quarantine-gate') {
    const exit = intOpt(io, 'suite-exit', values['suite-exit']);
    if (exit === null) return 2;
    if (!runner || exit === undefined || !values.reports?.length) {
      io.err(
        'quarantine-gate needs --runner, --suite-exit and at least one --reports <path>. See --help.\n'
      );
      return 2;
    }
    return cmdQuarantineGate(env, {
      runner: runner as Runner,
      reports: values.reports,
      suiteExit: exit,
      list: values.list,
      title: values.title,
    });
  }
  return cmdQuarantine(env, positionals[1] ?? 'list', {
    runner,
    file: values.file,
    title: values.title,
    reason: values.reason,
    by: values.by,
    expiryDays: expiry,
    publish: values.publish,
    data: values.data ? path.resolve(values.data) : undefined,
    fetch: values.fetch,
    builds,
    json: values.json,
    evidence: values.evidence,
    ledger: values.ledger,
  });
}

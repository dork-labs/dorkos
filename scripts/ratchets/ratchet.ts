/**
 * One command for every ratchet (DOR-4948): run each ratchet's own check, then
 * print one summary, a line per ratchet.
 *
 * --help
 * Purpose: run every ratchet (a count in a baseline file that may only fall)
 *          with its own check, and print one line per ratchet. The list, with
 *          each one's owner and the ticket that lowers it: scripts/ratchets/registry.ts.
 * Runs in: pre-push (`ratchets`, with --pre-push); the required `typecheck`
 *          job (every ratchet, after the typecheck step builds the packages).
 * To fix:  read the failing ratchet's own lines above the summary, then its
 *          `node <script> --help`. After lowering counts, `pnpm ratchet --update`
 *          runs every ratchet's own --update, which only lowers. Never raise a
 *          baseline by hand. An advisory ratchet (knip) is reported, never fails.
 * Usage:   pnpm ratchet [--base <ref>] [--pre-push] [--queue]
 *          pnpm ratchet --update [--pre-push]
 *          About 20 s, light enough to run without the load gate. knip needs
 *          the packages built; without them it reports "cannot measure".
 * --help end
 *
 * WHAT IT DOES NOT DO. It does not measure anything itself. Each ratchet's
 * script, flags and exit codes are what they were; this calls `node <script>`,
 * the same command `pnpm check:<name>` runs, with the arguments it was given:
 *
 *   --base <ref>   passed to every ratchet: each refuses a baseline raised
 *                  against <ref>, as it always has.
 *   --queue        passed only to a ratchet that takes it (api-lint).
 *   --pre-push     runs only the ratchets marked `prePush` in the registry.
 *   --update       runs each ratchet's own `--update`, which only lowers.
 *                  Refused under CI: a baseline is lowered in a commit, never
 *                  by the gate that checks it.
 *
 * The ratchets run at once, as the separate pre-push commands did. A ratchet's
 * own output is printed in full when it is more than its one summary line; a
 * failing one always is. Exit 1 when a ratchet that is not advisory exits
 * non-zero (its own exit 2, "cannot measure", counts as failing), else 0.
 *
 * HEAVINESS. Measured 2026-11-26 on the operator Mac: the whole run takes
 * about 20 s of wall time, bound by max-lines (about 18 s alone); knip takes
 * about 6 s once the packages are built. It spawns no build or typecheck, so it
 * runs directly, not through the load gate. knip reads the built package
 * output, so it is measured only after a build (CI runs it after the
 * typecheck step for that reason); without one it reports "cannot measure",
 * which, being advisory, fails nothing.
 *
 * @module scripts/ratchets/ratchet
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exitOnHelp } from '../lib/gate-help.mjs';
import { RATCHETS, type Ratchet } from './registry.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// eslint-disable-next-line no-restricted-syntax -- A root CLI reading CI; no app env.ts applies.
const ENV: NodeJS.ProcessEnv = process.env;

/** What one ratchet's run came to. */
export interface Outcome {
  ratchet: Ratchet;
  /** Its exit code; null when it could not start or was killed. */
  code: number | null;
  /** Its stdout and stderr, in the order they arrived. */
  output: string;
}

/** The options `pnpm ratchet` takes. */
export interface Options {
  base?: string;
  queue: boolean;
  prePush: boolean;
  update: boolean;
}

/** Thrown for arguments it cannot act on; the message is the whole answer. */
export class RatchetUsageError extends Error {}

/** Whether `CI` is set the way GitHub Actions sets it. */
export function underCi(env: NodeJS.ProcessEnv = ENV): boolean {
  const ci = env.CI;
  return ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false';
}

/**
 * Parse `pnpm ratchet`'s arguments (a leading `--` from pnpm is dropped).
 *
 * @param argv - The arguments after the script.
 * @param env - The environment, for the CI refusal.
 */
export function parseOptions(argv: string[], env: NodeJS.ProcessEnv = ENV): Options {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options: Options = { queue: false, prePush: false, update: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--base') {
      const ref = args[++i];
      if (!ref || ref.startsWith('--')) throw new RatchetUsageError('--base needs a ref');
      options.base = ref;
    } else if (arg === '--queue') options.queue = true;
    else if (arg === '--pre-push') options.prePush = true;
    else if (arg === '--update') options.update = true;
    else throw new RatchetUsageError(`unknown argument ${arg}; see pnpm ratchet --help`);
  }
  if (options.update && underCi(env)) {
    throw new RatchetUsageError(
      '--update is refused under CI: lower a baseline in a commit, by hand, never in the gate that checks it.'
    );
  }
  if (options.update && (options.base || options.queue)) {
    throw new RatchetUsageError('--update takes no --base or --queue: each --update only lowers.');
  }
  return options;
}

/** The ratchets a run with these options covers, in registry order. */
export function selected(options: Options, ratchets: readonly Ratchet[] = RATCHETS): Ratchet[] {
  return ratchets.filter((r) => !options.prePush || r.prePush);
}

/** The arguments one ratchet's script is given. */
export function argsFor(ratchet: Ratchet, options: Options): string[] {
  if (options.update) return ['--update'];
  const args = options.base ? ['--base', options.base] : [];
  if (options.queue && ratchet.queue) args.push('--queue');
  return args;
}

/**
 * The one line that sums up a ratchet's run, from the lines it starts with its
 * own name: its `clean` line when it passed, its problem count (or why it
 * could not run) when it failed, never one of its notes. Else its last line.
 */
export function summaryLine(outcome: Outcome): string {
  const lines = outcome.output.split('\n').filter((l) => l.trim() !== '');
  const own = lines.filter((l) => l.startsWith(`${outcome.ratchet.name}:`));
  const verdict =
    outcome.code === 0 ? /\bclean\b/ : /problem|violation|cannot|increased|raised|refus/;
  return own.find((l) => verdict.test(l)) ?? own.at(-1) ?? lines.at(-1) ?? '(no output)';
}

/** Whether a ratchet's run failed, advisory or not. */
function failed(outcome: Outcome): boolean {
  return outcome.code !== 0;
}

/** Whether these outcomes fail `pnpm ratchet`: a non-advisory ratchet failed. */
export function failing(outcomes: Outcome[]): Outcome[] {
  return outcomes.filter((o) => failed(o) && !o.ratchet.advisory);
}

/** The summary block: a line per ratchet, then the verdict. */
export function summary(outcomes: Outcome[], options: Options): string {
  const width = Math.max(...outcomes.map((o) => o.ratchet.name.length));
  const lines = outcomes.map((o) => {
    const state = !failed(o) ? 'clean' : o.ratchet.advisory ? 'advisory' : 'FAILING';
    return `  ${o.ratchet.name.padEnd(width)}  ${state.padEnd(8)}  ${summaryLine(o)}`;
  });
  const bad = failing(outcomes);
  const verb = options.update ? 'updated' : 'checked';
  const verdict = bad.length
    ? `ratchet: ${bad.length} of ${outcomes.length} failing: ${bad.map((o) => o.ratchet.name).join(', ')}. Fix each above; \`node <script> --help\` says how.`
    : `ratchet: ${outcomes.length} ${verb}, none failing.`;
  return [
    `ratchet: ${outcomes.length} ratchet(s); owners and what lowers each: scripts/ratchets/registry.ts`,
    ...lines,
    verdict,
  ].join('\n');
}

/** Run one ratchet's own script and collect what it printed. */
function runOne(ratchet: Ratchet, options: Options): Promise<Outcome> {
  return new Promise((done) => {
    let output = '';
    const child = spawn(process.execPath, [ratchet.script, ...argsFor(ratchet, options)], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', (err) => done({ ratchet, code: null, output: `${output}${err.message}\n` }));
    child.on('close', (code) => done({ ratchet, code, output }));
  });
}

/** Run every selected ratchet at once and print their output and the summary. */
async function main(options: Options): Promise<number> {
  const outcomes = await Promise.all(selected(options).map((r) => runOne(r, options)));
  for (const o of outcomes) {
    const text = o.output.trimEnd();
    if (text && text !== summaryLine(o)) process.stdout.write(`--- ${o.ratchet.name}\n${text}\n`);
  }
  process.stdout.write(`${summary(outcomes, options)}\n`);
  return failing(outcomes).length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  exitOnHelp(import.meta.url);
  let options: Options;
  try {
    options = parseOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`ratchet: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  main(options).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`ratchet: cannot run: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  );
}

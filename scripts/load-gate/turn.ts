/**
 * The repo's own heavy runs take their turn in the app's line (DOR-4209 PR5a).
 *
 *   tsx scripts/load-gate/turn.ts -- <command> [args...]
 *
 * `scripts/heavy-run-lock.sh --job` (and `--tests`) runs this around its
 * command once it has its own slot, so `pnpm build`, `pnpm test`, `pnpm
 * typecheck`, `pnpm verify` and `pnpm heavy` wait in the SAME first-come line
 * as agents' heavy shell jobs: the queue folder `/tmp/dorkos-load-gate-<uid>`
 * that the server's load gate keeps (`apps/server/src/services/core/load-gate/`).
 * It does not re-implement that folder's protocol: it opens the server's own
 * {@link TicketQueue}, so a ticket from here and a ticket from the app are the
 * same kind of file, judged by the same rules. Importing server source from a
 * script has precedent (`scripts/export-openapi.ts`, the search benches) and
 * needs `tsx`, which turns the server's `.js` import specifiers back into `.ts`.
 *
 * ## The settings
 *
 * The app's own `runtimes.loadGate` (slots, max load, hard cap, on or off), read
 * from `$DORK_HOME/config.json`, else `~/.dork/config.json` (the installed app's),
 * and parsed by the app's own schema, so a missing or invalid section means the
 * shipped defaults. Read again on every check, as the server does. Tests and a
 * person can override one run: `DORKOS_LOAD_GATE_SLOTS`, `DORKOS_LOAD_GATE_MAX_LOAD`,
 * `DORKOS_LOAD_GATE_HARD_CAP_MINUTES`, `DORKOS_LOAD_GATE_POLL_MS`,
 * `DORKOS_LOAD_GATE_LOAD` (a fixed five-minute load) and `DORKOS_LOAD_GATE_DIR`
 * (the folder). `DORKOS_LOAD_GATE_LINE=0`, checked by the shell wrapper, skips
 * the line and keeps the repo's own lock.
 *
 * ## The rules, the gate's own
 *
 * - The ticket names its job by program only (`turbo`, `pnpm`), never command text.
 * - It only ever waits. Past the hard cap the job runs anyway, and says so.
 * - NEVER FAILS CLOSED. If the folder or the settings cannot be used, or the
 *   queue throws while waiting, it prints one line and runs the command. The
 *   shell wrapper also runs the command itself if this file never got as far as
 *   starting it (no `tsx`, a broken import).
 * - NESTED RUNS GO STRAIGHT THROUGH. An agent's gated `pnpm build` already holds
 *   a slot in the name of its DorkOS server, which is an ancestor of the shell the
 *   command runs in. Queueing again would wait on that slot until the hard cap,
 *   so a running job owned by any ancestor means "already in line". Known gap: a
 *   light agent command that runs a heavy repo script inside it also goes
 *   through whenever its server holds a slot for some other job.
 * - Its children are told `DORKOS_HEAVY_SLOT_HELD=1`, so a heavy run nested in
 *   this one never queues twice.
 *
 * ## Signals
 *
 * While waiting, SIGINT, SIGTERM and SIGHUP take the ticket out of line and exit
 * `128 + n` without starting the command. While the command runs, SIGTERM and
 * SIGHUP are passed to it (and only to it); SIGINT is not, because a terminal's
 * Ctrl-C already reaches the whole foreground group. The slot is given back
 * however the command ends; if this process is SIGKILLed, the queue frees the
 * slot at its next check, since the owner's pid is gone.
 *
 * ## What it tells the shell wrapper
 *
 * `DORKOS_LOAD_GATE_TURN_FILE`, when set, is a file this writes `ran` to the
 * moment the command starts, or `stopped` when a signal ended the wait. Left
 * empty, the wrapper knows nothing ran and runs the command itself.
 *
 * @module scripts/load-gate-turn
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[load-gate]';
const MS_PER_MINUTE = 60_000;
const DEFAULT_POLL_MS = 5_000;
const NOTICE_EVERY_MS = 60_000;
const MAX_ANCESTORS = 64;
const WAIT_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
const PASSED_SIGNALS = ['SIGTERM', 'SIGHUP'] as const;

/** The settings one check is judged against, after overrides. */
export interface TurnSettings {
  /** Whether heavy jobs wait at all. */
  enabled: boolean;
  /** How many heavy jobs may run at once on this machine. */
  slots: number;
  /** The five-minute load at or above which a job waits. */
  maxLoad: number;
  /** The wait after which a job runs anyway. */
  hardCapMs: number;
}

/** The `runtimes.loadGate` fields this reads, as the app's schema parses them. */
interface ParsedLoadGate {
  enabled: boolean;
  slots: number;
  maxLoad: number;
  maxWaitMinutes: number;
  hardCapMinutes: number;
}

/** A positive whole number from the environment, or `undefined`. */
function envInt(value: string | undefined): number | undefined {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A non-negative number from the environment, or `undefined`. */
function envNumber(value: string | undefined): number | undefined {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * The installed app's config file: `$DORK_HOME/config.json`, else `~/.dork/config.json`.
 *
 * Not the server's `resolveDorkHome()`, whose development default is relative to
 * the working directory: from the repo root that names no server's config.
 *
 * @param env - The environment to read `DORK_HOME` from.
 */
export function configPath(env: Readonly<Record<string, string | undefined>>): string {
  const home = env.DORK_HOME ? env.DORK_HOME : path.join(os.homedir(), '.dork');
  return path.join(home, 'config.json');
}

/**
 * The settings in force: the app's parsed `runtimes.loadGate`, then this run's overrides.
 *
 * @param parsed - The section as the app's schema parsed it (defaults filled in).
 * @param env - The environment carrying the overrides.
 */
export function turnSettings(
  parsed: ParsedLoadGate,
  env: Readonly<Record<string, string | undefined>>
): TurnSettings {
  // The gate's own rule (`hardCapMs` in load-gate.ts): a cap below the notice is
  // read as the notice. An override is taken as given, so a test can use one minute.
  const hardCapMinutes =
    envInt(env.DORKOS_LOAD_GATE_HARD_CAP_MINUTES) ??
    Math.max(parsed.hardCapMinutes, parsed.maxWaitMinutes);
  return {
    enabled: parsed.enabled,
    slots: envInt(env.DORKOS_LOAD_GATE_SLOTS) ?? parsed.slots,
    maxLoad: envInt(env.DORKOS_LOAD_GATE_MAX_LOAD) ?? parsed.maxLoad,
    hardCapMs: hardCapMinutes * MS_PER_MINUTE,
  };
}

/**
 * The program word a ticket is labelled by: the first word that is not an
 * environment assignment, `env`, or a `dotenv … --` prefix. `dotenv -- turbo
 * build` is a `turbo` job.
 *
 * @param command - The command and its arguments.
 */
export function programWord(command: readonly string[]): string {
  let words = [...command];
  if (words[0] === 'dotenv' && words.includes('--')) words = words.slice(words.indexOf('--') + 1);
  while (words.length > 1 && (words[0] === 'env' || /^[A-Za-z_]\w*=/.test(words[0]!))) {
    words = words.slice(1);
  }
  return words[0] ?? 'job';
}

/**
 * Every ancestor of `pid`, nearest first, at most {@link MAX_ANCESTORS}.
 *
 * @param pid - Where to start (not included).
 * @param parentOf - The parent of a pid, or `0` when unknown.
 */
export function ancestorsOf(pid: number, parentOf: (pid: number) => number): Set<number> {
  const found = new Set<number>();
  let at = parentOf(pid);
  while (at > 1 && found.size < MAX_ANCESTORS && !found.has(at)) {
    found.add(at);
    at = parentOf(at);
  }
  return found;
}

/** A pid's parent from `ps`, which names a pid and signals nothing; `0` when it cannot say. */
function psParent(pid: number): number {
  try {
    const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2_000,
    });
    return Number(out.trim()) || 0;
  } catch {
    return 0;
  }
}

/** A short, fixed name for what went wrong: an error code or class, never a message. */
function errorKind(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  return error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'unknown';
}

/** Write the wrapper's one word, best effort. */
function tellWrapper(word: 'ran' | 'stopped'): void {
  const file = process.env.DORKOS_LOAD_GATE_TURN_FILE;
  if (!file) return;
  try {
    fs.writeFileSync(file, word);
  } catch {
    // The wrapper then runs the command itself, which is the fail-open side.
  }
}

const say = (line: string): void => {
  process.stderr.write(`${TAG} ${line}\n`);
};

/** A held turn: refresh it while the command runs, give it back when it ends. */
interface Turn {
  beat: () => void;
  release: () => void;
  pollMs: number;
}

/**
 * Wait for this run's turn in the shared line. Resolves `null` when the run
 * should not hold one (the gate is off, a nested run) or the line failed, in
 * which case it has said so; never rejects.
 *
 * @param command - The command, for its program label.
 */
async function takeTurn(command: readonly string[]): Promise<Turn | null> {
  const env = process.env;
  let release: (() => void) | undefined;
  try {
    const [{ TicketQueue, DEFAULT_LEASE_MS }, { jobLabel }, { LoadGateSettingsSchema }] =
      await Promise.all([
        import('../../apps/server/src/services/core/load-gate/ticket-queue.js'),
        import('../../apps/server/src/services/core/load-gate/job-label.js'),
        // Through the entry, not `config-schema/runtime-settings.js`: entering at the
        // leaf trips a circular import (`RuntimesConfigSchema` before initialization).
        import('../../packages/shared/src/config-schema.js'),
      ]);
    const readSettings = (): TurnSettings => {
      let section: unknown;
      try {
        const config = JSON.parse(fs.readFileSync(configPath(env), 'utf8')) as {
          runtimes?: { loadGate?: unknown };
        };
        section = config.runtimes?.loadGate;
      } catch {
        section = undefined;
      }
      const parsed = LoadGateSettingsSchema.safeParse(section);
      return turnSettings(
        parsed.success ? parsed.data : LoadGateSettingsSchema.parse(undefined),
        env
      );
    };
    const fixedLoad = envNumber(env.DORKOS_LOAD_GATE_LOAD);
    const fiveMinuteLoad = (): number => fixedLoad ?? os.loadavg()[1] ?? 0;
    const pollMs = envInt(env.DORKOS_LOAD_GATE_POLL_MS) ?? DEFAULT_POLL_MS;

    let settings = readSettings();
    if (!settings.enabled) return null;
    const queue = new TicketQueue({
      ...(env.DORKOS_LOAD_GATE_DIR ? { dir: env.DORKOS_LOAD_GATE_DIR } : {}),
      leaseMs: Math.max(DEFAULT_LEASE_MS, 3 * pollMs),
    });
    const ancestors = ancestorsOf(process.pid, psParent);
    if (queue.runningOwners().some((pid) => ancestors.has(pid))) return null;

    const job = jobLabel(programWord(command));
    const ticket = queue.enqueue({ job });
    release = () => queue.release(ticket);
    const stop = (signal: NodeJS.Signals): void => {
      try {
        release?.();
      } catch {
        // Other readers free it once its owner, this process, is gone.
      }
      tellWrapper('stopped');
      process.exit(128 + (os.constants.signals[signal] ?? 0));
    };
    for (const signal of WAIT_SIGNALS) process.on(signal, stop);

    const startedAt = Date.now();
    let nextNotice = startedAt;
    try {
      for (;;) {
        try {
          settings = readSettings();
        } catch {
          // Keep the last settings that read.
        }
        if (!settings.enabled) {
          queue.release(ticket);
          return null;
        }
        const load = fiveMinuteLoad();
        const limits = { slots: settings.slots, load, maxLoad: settings.maxLoad };
        queue.beat(ticket);
        let result = queue.tryAcquire(ticket, limits);
        if (result === 'lost') {
          // Its file went (a temp cleaner, a missed lease): back in at its own number.
          queue.rejoin(ticket);
          result = queue.tryAcquire(ticket, limits);
        }
        if (result === 'slot' || result === 'let-through') break;
        const waitedMs = Date.now() - startedAt;
        if (waitedMs >= settings.hardCapMs) {
          queue.forceAcquire(ticket);
          say(
            `a ${job} job ran after waiting ${Math.round(waitedMs / MS_PER_MINUTE)} min, the hard cap.`
          );
          break;
        }
        if (Date.now() >= nextNotice) {
          const place = queue.position(ticket);
          if (place > 0) {
            say(
              `waiting in this computer's line for heavy jobs: number ${place}, ` +
                `${queue.runningCount()} running of ${settings.slots}, load ${load.toFixed(2)} ` +
                `(waits at ${settings.maxLoad}).`
            );
          }
          nextNotice = Date.now() + NOTICE_EVERY_MS;
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    } finally {
      for (const signal of WAIT_SIGNALS) process.off(signal, stop);
    }
    return {
      pollMs,
      beat: () => {
        queue.beat(ticket);
      },
      release: () => queue.release(ticket),
    };
  } catch (error) {
    try {
      release?.();
    } catch {
      // Already failing; other readers free it once its owner is gone.
    }
    say(
      `the shared line for heavy jobs could not be used (${errorKind(error)}) — running without it.`
    );
    return null;
  }
}

/**
 * Run the command in the foreground, holding `turn` while it runs.
 *
 * @param command - The command and its arguments.
 * @param turn - The held turn, or `null` to run without one.
 * @returns The command's exit code, or `128 + n` when a signal ended it.
 */
function runCommand(command: readonly string[], turn: Turn | null): Promise<number> {
  return new Promise((resolve) => {
    let given = false;
    const giveBack = (): void => {
      if (given) return;
      given = true;
      clearInterval(timer);
      try {
        turn?.release();
      } catch {
        // Other readers free it once this process is gone.
      }
    };
    const timer = setInterval(() => {
      try {
        turn?.beat();
      } catch {
        // A missed beat; the next one, or the release, settles it.
      }
    }, turn?.pollMs ?? DEFAULT_POLL_MS);
    const child = spawn(command[0]!, command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, DORKOS_HEAVY_SLOT_HELD: '1' },
    });
    // Ctrl-C reaches the command through the terminal; this process only waits for it.
    const ignore = (): void => {};
    const pass = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };
    process.on('SIGINT', ignore);
    for (const signal of PASSED_SIGNALS) process.on(signal, pass);
    child.on('spawn', () => tellWrapper('ran'));
    child.on('error', (error) => {
      giveBack();
      say(`could not start ${path.basename(command[0]!)} (${errorKind(error)}).`);
      resolve((error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 126);
    });
    child.on('exit', (code, signal) => {
      giveBack();
      resolve(code ?? 128 + (signal ? (os.constants.signals[signal] ?? 0) : 0));
    });
  });
}

/**
 * Take a turn, run the command, give the turn back.
 *
 * @param argv - This script's arguments: `-- <command> [args...]`.
 * @returns The exit code to leave with.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0] === '--' ? argv.slice(1) : [...argv];
  if (command.length === 0) {
    say('no command given.');
    return 2;
  }
  return runCommand(command, await takeTurn(command));
}

/** Whether this file is the entry point. Real paths, so a symlinked checkout still runs. */
function isEntry(): boolean {
  try {
    return (
      fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isEntry()) {
  // Exit 70 without starting the command: the wrapper sees nothing ran and runs it.
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(70)
  );
}

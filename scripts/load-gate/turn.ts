/**
 * The repo's own heavy runs take their turn in the app's line (DOR-4209 PR5a).
 *
 *   tsx scripts/load-gate/turn.ts --wrap <heavy-run-lock.sh> <--job|--tests> -- <command> [args...]
 *   tsx scripts/load-gate/turn.ts -- <command> [args...]
 *
 * `scripts/heavy-run-lock.sh --job` (and `--tests`) runs this FIRST, before its
 * own slot, so `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm verify` and
 * `pnpm heavy` wait in the SAME first-come line as agents' heavy shell jobs: the
 * queue folder `/tmp/dorkos-load-gate-<uid>` that the server's load gate keeps
 * (`apps/server/src/services/core/load-gate/`). With `--wrap`, the command this
 * runs once its turn comes is the wrapper again (`bash <wrapper> <mode> <command>`,
 * told `DORKOS_LOAD_GATE_IN_TURN=1`), which then takes the repo's own slot inside
 * the turn. That is the agents' order: an agent's gated command already holds
 * the app's slot when its nested `heavy-run-lock --job` asks for the repo's, so
 * every run must take the app's turn first and the repo's slot second, or a run
 * holding a repo slot while it waits for the app's turn can stall the agent's.
 *
 * It does not re-implement the folder's protocol: it opens the server's own
 * `TicketQueue`, so a ticket from here and a ticket from the app are the same kind
 * of file, judged by the same rules. Importing server source from a script has
 * precedent (`scripts/export-openapi.ts`, the search benches) and needs `tsx`,
 * which turns the server's `.js` import specifiers back into `.ts`. The imports
 * are by computed path and typed by the small {@link QueueModule} below, so the
 * scripts typecheck does not pull the server and `@dorkos/shared` into its
 * program; `scripts/test-load-gate-turn.sh` runs the real code.
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
 *   starting it (no `tsx`, a broken import, a start that hangs).
 * - NESTED RUNS GO STRAIGHT THROUGH. An agent's gated `pnpm build` already holds
 *   a slot in the name of its DorkOS server, which is an ancestor of the shell the
 *   command runs in. Queueing again would wait on that slot until the hard cap,
 *   so a running job owned by any ancestor means "already in line". Ancestry is
 *   read with ONE `ps` call; if it cannot be read while any job is running, the
 *   run goes straight through too. Known gap: a light agent command that runs a
 *   heavy repo script inside it also goes through whenever its server holds a
 *   slot for some other job.
 * - A held slot is refreshed until a lease past the hard cap, then left to its
 *   lease, as the server's own slots are (`beatUntil` in `load-gate.ts`), so a
 *   job that never ends cannot hold the machine forever.
 *
 * ## Signals
 *
 * From the moment this module loads until the command starts, SIGINT, SIGTERM
 * and SIGHUP take the ticket out of line (if there is one yet) and exit `128 + n`
 * without starting the command. While the command runs, SIGTERM and SIGHUP are
 * passed to it (and only to it); SIGINT is not, because a terminal's Ctrl-C
 * already reaches the whole foreground group. The slot is given back however the
 * command ends; if this process is SIGKILLed, the queue frees the slot at its
 * next check, since the owner's pid is gone.
 *
 * ## What it tells the shell wrapper
 *
 * `DORKOS_LOAD_GATE_TURN_FILE`, when set, is a file this writes `waiting` to once
 * its ticket is in line, `ran` the moment the command starts, or `stopped` when a
 * signal ended the wait. The wrapper reads anything else as "never started" and
 * runs the command itself. If `<file>.late` exists (the wrapper gave up on a slow
 * start and already ran the command), this never starts it.
 *
 * @module scripts/load-gate/turn
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TAG = '[load-gate]';
const MS_PER_MINUTE = 60_000;
const DEFAULT_POLL_MS = 5_000;
/** The server's lease (`DEFAULT_LEASE_MS` in ticket-queue.ts), the margin past the hard cap. */
const LEASE_MS = 30_000;
const NOTICE_EVERY_MS = 60_000;
const MAX_ANCESTORS = 64;
const PS_TIMEOUT_MS = 5_000;
const STOP_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

/** What this process is doing, which decides what a signal means. */
const state: {
  phase: 'waiting' | 'running';
  release: (() => void) | undefined;
  child: ChildProcess | undefined;
} = { phase: 'waiting', release: undefined, child: undefined };

/** A signal before the command starts ends the wait; one after it is the command's. */
function onSignal(signal: NodeJS.Signals): void {
  if (state.phase === 'running') {
    if (signal !== 'SIGINT') state.child?.kill(signal);
    return;
  }
  try {
    state.release?.();
  } catch {
    // Other readers free it once its owner, this process, is gone.
  }
  tellWrapper('stopped');
  process.exit(128 + (os.constants.signals[signal] ?? 0));
}

// First thing, before the imports, the `ps` call and the ticket: a Ctrl-C at any
// point before the command starts must never let the wrapper start it.
if (isEntry()) for (const signal of STOP_SIGNALS) process.on(signal, onSignal);

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
export interface ParsedLoadGate {
  /** Whether heavy jobs wait at all. */
  enabled: boolean;
  /** Concurrent heavy jobs. */
  slots: number;
  /** The load jobs wait at. */
  maxLoad: number;
  /** Minutes before the "still waiting" notice. */
  maxWaitMinutes: number;
  /** Minutes before a job runs anyway. */
  hardCapMinutes: number;
}

/** One ticket, as far as this file uses it. */
interface QueueTicket {
  id: string;
  seq: number;
}

/** The part of the server's `TicketQueue` this file calls. Kept in step by the shell fixtures. */
interface Queue {
  enqueue(info: { job: string }): QueueTicket;
  rejoin(ticket: QueueTicket): void;
  beat(ticket: QueueTicket): boolean;
  disown(ticket: QueueTicket): void;
  list(): QueueTicket[];
  position(ticket: QueueTicket): number;
  runningCount(): number;
  runningOwners(): number[];
  tryAcquire(
    ticket: QueueTicket,
    limits: { slots: number; load: number; maxLoad: number }
  ): 'slot' | 'let-through' | 'wait' | 'lost';
  forceAcquire(ticket: QueueTicket): void;
  release(ticket: QueueTicket): void;
}

/** The modules this file loads at run time, typed only as far as it uses them. */
interface QueueModule {
  TicketQueue: new (options: { dir?: string; leaseMs?: number }) => Queue;
  DEFAULT_LEASE_MS: number;
}
interface LabelModule {
  jobLabel: (word: string) => string;
}
interface SchemaModule {
  LoadGateSettingsSchema: {
    safeParse(value: unknown): { success: true; data: ParsedLoadGate } | { success: false };
    parse(value: unknown): ParsedLoadGate;
  };
}

// Computed, so the scripts typecheck does not follow them into the server's tree.
const QUEUE_MODULE = '../../apps/server/src/services/core/load-gate/ticket-queue.js';
const LABEL_MODULE = '../../apps/server/src/services/core/load-gate/job-label.js';
// Through the entry, not `config-schema/runtime-settings.js`: entering at the
// leaf trips a circular import (`RuntimesConfigSchema` before initialization).
const SCHEMA_MODULE = '../../packages/shared/src/config-schema.js';

/** A positive whole number from the environment, or `undefined`. */
function envInt(value: string | undefined): number | undefined {
  const n = value === undefined || value === '' ? NaN : Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** A positive number from the environment (zero too, when `inclusive`), or `undefined`. */
function envNumber(value: string | undefined, inclusive: boolean): number | undefined {
  const n = value === undefined || value === '' ? NaN : Number(value);
  if (!Number.isFinite(n)) return undefined;
  return n > 0 || (inclusive && n === 0) ? n : undefined;
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
    maxLoad: envNumber(env.DORKOS_LOAD_GATE_MAX_LOAD, false) ?? parsed.maxLoad,
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
 * Each pid's parent, from `ps -A -o pid=,ppid=` output.
 *
 * @param psOutput - What `ps` printed: one `pid ppid` pair per line.
 */
export function parentMap(psOutput: string): Map<number, number> {
  const parents = new Map<number, number>();
  for (const line of psOutput.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
    if (match) parents.set(Number(match[1]), Number(match[2]));
  }
  return parents;
}

/**
 * Every ancestor of a process, nearest first, or `null` when the chain cannot be
 * followed to the top (a pid `ps` did not list, or more than {@link MAX_ANCESTORS}).
 *
 * @param parent - The process's own parent, where the walk starts.
 * @param parents - Each pid's parent.
 */
export function ancestorsFrom(
  parent: number,
  parents: ReadonlyMap<number, number>
): Set<number> | null {
  const found = new Set<number>();
  let at = parent;
  while (at > 1) {
    if (found.has(at) || found.size >= MAX_ANCESTORS) return null;
    found.add(at);
    const next = parents.get(at);
    if (next === undefined) return null;
    at = next;
  }
  return found;
}

/** This process's ancestors from one `ps` call, which names pids and signals nothing; `null` when unreadable. */
function readAncestors(): Set<number> | null {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: PS_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return ancestorsFrom(process.ppid, parentMap(out));
  } catch {
    return null;
  }
}

/** A short, fixed name for what went wrong: an error code or class, never a message. */
function errorKind(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code)) return code;
  return error instanceof Error && /^\w{1,40}$/.test(error.name) ? error.name : 'unknown';
}

/** Write the wrapper's one word, best effort. */
function tellWrapper(word: 'waiting' | 'ran' | 'stopped'): void {
  const file = process.env.DORKOS_LOAD_GATE_TURN_FILE;
  if (!file) return;
  try {
    fs.writeFileSync(file, word);
  } catch {
    // The wrapper then runs the command itself, which is the fail-open side.
  }
}

/** Whether the wrapper gave up on this start and ran the command itself. */
function wrapperGaveUp(): boolean {
  const file = process.env.DORKOS_LOAD_GATE_TURN_FILE;
  return Boolean(file) && fs.existsSync(`${file}.late`);
}

const say = (line: string): void => {
  process.stderr.write(`${TAG} ${line}\n`);
};

/** A held turn: refresh it while the command runs, give it back when it ends. */
interface Turn {
  beat: () => void;
  disown: () => void;
  release: () => void;
  pollMs: number;
  /** How long after the start to keep refreshing: the hard cap and a lease. */
  beatForMs: number;
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
  try {
    const [{ TicketQueue, DEFAULT_LEASE_MS }, { jobLabel }, { LoadGateSettingsSchema }] =
      (await Promise.all([import(QUEUE_MODULE), import(LABEL_MODULE), import(SCHEMA_MODULE)])) as [
        QueueModule,
        LabelModule,
        SchemaModule,
      ];
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
    const fixedLoad = envNumber(env.DORKOS_LOAD_GATE_LOAD, true);
    const fiveMinuteLoad = (): number => fixedLoad ?? os.loadavg()[1] ?? 0;
    const pollMs = envInt(env.DORKOS_LOAD_GATE_POLL_MS) ?? DEFAULT_POLL_MS;

    let settings = readSettings();
    if (!settings.enabled) return null;
    const queue = new TicketQueue({
      ...(env.DORKOS_LOAD_GATE_DIR ? { dir: env.DORKOS_LOAD_GATE_DIR } : {}),
      leaseMs: Math.max(DEFAULT_LEASE_MS, 3 * pollMs),
    });
    const owners = queue.runningOwners();
    if (owners.length > 0) {
      const ancestors = readAncestors();
      if (ancestors === null) {
        say('could not tell whether this run is inside a running heavy job — not waiting in line.');
        return null;
      }
      if (owners.some((pid) => ancestors.has(pid))) return null;
    }

    const job = jobLabel(programWord(command));
    const ticket = queue.enqueue({ job });
    state.release = () => queue.release(ticket);
    tellWrapper('waiting');

    const startedAt = Date.now();
    let nextNotice = startedAt;
    for (;;) {
      try {
        settings = readSettings();
      } catch {
        // Keep the last settings that read.
      }
      if (!settings.enabled) {
        queue.release(ticket);
        state.release = undefined;
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
    return {
      pollMs,
      beatForMs: settings.hardCapMs + LEASE_MS,
      beat: () => {
        queue.beat(ticket);
      },
      disown: () => queue.disown(ticket),
      release: () => queue.release(ticket),
    };
  } catch (error) {
    try {
      state.release?.();
    } catch {
      // Already failing; other readers free it once its owner is gone.
    }
    state.release = undefined;
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
 * @param env - The command's environment.
 * @param turn - The held turn, or `null` to run without one.
 * @returns The command's exit code, or `128 + n` when a signal ended it.
 */
function runCommand(
  command: readonly string[],
  env: NodeJS.ProcessEnv,
  turn: Turn | null
): Promise<number> {
  return new Promise((resolve) => {
    let given = false;
    const beatUntil = Date.now() + (turn?.beatForMs ?? 0);
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
        if (Date.now() <= beatUntil) {
          turn?.beat();
          return;
        }
        // Past the hard cap and a lease: stop keeping it fresh, so the lease frees it.
        clearInterval(timer);
        turn?.disown();
      } catch {
        // A missed beat; the next one, or the release, settles it.
      }
    }, turn?.pollMs ?? DEFAULT_POLL_MS);
    if (wrapperGaveUp()) {
      // The wrapper already ran the command: running it here would run it twice.
      giveBack();
      resolve(0);
      return;
    }
    state.phase = 'running';
    const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', env });
    state.child = child;
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

/** The command and how to run it, from this script's arguments. */
interface Invocation {
  /** The job's own command, for its label. */
  command: string[];
  /** What actually runs: the command, or the wrapper around it. */
  run: string[];
  /** The environment it runs with. */
  env: NodeJS.ProcessEnv;
}

/**
 * Read `[--wrap <wrapper> <mode>] -- <command...>`.
 *
 * @param argv - This script's arguments.
 * @param env - This process's environment.
 * @returns What to run, or `null` when no command was given.
 */
export function invocation(argv: readonly string[], env: NodeJS.ProcessEnv): Invocation | null {
  let rest = [...argv];
  let wrapper: [string, string] | undefined;
  if (rest[0] === '--wrap' && rest.length >= 3) {
    wrapper = [rest[1]!, rest[2]!];
    rest = rest.slice(3);
  }
  const command = rest[0] === '--' ? rest.slice(1) : rest;
  if (command.length === 0) return null;
  const childEnv: NodeJS.ProcessEnv = { ...env };
  delete childEnv.DORKOS_LOAD_GATE_TURN_FILE;
  if (wrapper) {
    // The wrapper again, inside the turn: it skips the line and takes its own slot.
    childEnv.DORKOS_LOAD_GATE_IN_TURN = '1';
    return { command, run: ['bash', wrapper[0], wrapper[1], ...command], env: childEnv };
  }
  childEnv.DORKOS_HEAVY_SLOT_HELD = '1';
  return { command, run: command, env: childEnv };
}

/**
 * Take a turn, run the command, give the turn back.
 *
 * @param argv - This script's arguments: `[--wrap <wrapper> <mode>] -- <command> [args...]`.
 * @returns The exit code to leave with.
 */
async function main(argv: readonly string[]): Promise<number> {
  const call = invocation(argv, process.env);
  if (call === null) {
    say('no command given.');
    return 2;
  }
  return runCommand(call.run, call.env, await takeTurn(call.command));
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

/**
 * Each allow-list program, pinned when its list is written (DOR-4315,
 * Security's ruling).
 *
 * An exact command line limits the words, not what the program does, and the
 * program usually sits in a folder the agent can write. So DorkOS records the
 * program's real path and sha256 in its own task row (never in a file in the
 * agent's folder), and a run whose program no longer matches is refused and
 * the person told: the old command line never runs on new bytes.
 *
 * - **Only added entries are pinned.** An entry already on the list keeps the
 *   pin it was approved with, so a call that keeps it can't re-approve changed
 *   bytes.
 * - **The first-set time is kept** after the list is cleared, so a later list
 *   is never mistaken for a first one (the first list is the only one an agent
 *   sets without a person).
 *
 * What a pin covers, plainly: the first program's bytes at its real path, and
 * nothing else. A script's `#!` interpreter, and any file it reads or sources,
 * are not pinned. The check runs once, before the run starts; a program swapped
 * by another process after that is not caught. A program that is itself a
 * shell, a language runtime or a wrapper that starts another program is refused
 * by its real path, so a link can't stand in for one.
 *
 * @module services/tasks/allow-list/allow-list-pins
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isInterpreter } from '@dorkos/shared/permission-rules';

/** The largest program hashed. A real script or binary is far smaller. */
const MAX_PROGRAM_BYTES = 256 * 1024 * 1024;

/**
 * Programs that start, or run files as, another program, beyond the card's
 * interpreter list: an exact line that starts one runs something nobody pinned.
 */
const WRAPPERS = new Set([
  'timeout',
  'gtimeout',
  'nice',
  'nohup',
  'time',
  'caffeinate',
  'arch',
  'script',
  'flock',
  'stdbuf',
  'doas',
  'awk',
  'gawk',
  'nawk',
  'make',
  'gmake',
  'find',
  'git',
  'rscript',
  'java',
  'tclsh',
  'expect',
  'open',
  'osascript',
  'launchctl',
  'chroot',
  'su',
]);

/**
 * Whether a program, by its path or name, runs what it is handed: a shell or
 * language runtime (`isInterpreter`) or one of {@link WRAPPERS}.
 *
 * @param program - The program's path or file name.
 */
export function runsAnotherProgram(program: string): boolean {
  const name = (program.split(/[\\/]/).pop() ?? '').toLowerCase();
  return isInterpreter(program) || WRAPPERS.has(name) || WRAPPERS.has(name.replace(/[\d.]+$/, ''));
}

/** One program as pinned. */
export interface ProgramPin {
  /** Its real path when pinned. */
  path: string;
  /** sha256 of its bytes when pinned. */
  sha256: string;
}

/** A task's pins, as kept in its row. */
export interface AllowListPins {
  /** When the task's first list was set, or `null` when it never had one. */
  firstSetAt: string | null;
  /** The pin of each entry on the list, by the entry. */
  programs: Record<string, ProgramPin>;
  /** The column was there but could not be read: every run with a list is refused. */
  unreadable?: true;
}

/**
 * The program an exact `Bash(...)` entry runs: its first word.
 *
 * @param rule - An entry `judgeTaskAllowEntry` kept.
 */
export function programOf(rule: string): string {
  return rule.slice('Bash('.length, -1).split(' ')[0]!;
}

/**
 * A program's pin now, or `null` when it is missing, not a file, too big, or
 * really a shell or other program that runs what it is handed: a link named
 * `run` that points at `bash` is judged by where it points.
 */
async function pinOf(program: string): Promise<ProgramPin | null> {
  try {
    const real = await fs.realpath(program);
    if (runsAnotherProgram(real)) return null;
    const stat = await fs.stat(real);
    if (!stat.isFile() || stat.size > MAX_PROGRAM_BYTES) return null;
    const sha256 = createHash('sha256')
      .update(await fs.readFile(real))
      .digest('hex');
    return { path: real, sha256 };
  } catch {
    return null;
  }
}

/**
 * Pin each entry's program, or name the first that can't be pinned.
 *
 * @param rules - The entries being added.
 */
export async function pinPrograms(
  rules: readonly string[]
): Promise<{ ok: true; programs: Record<string, ProgramPin> } | { ok: false; rule: string }> {
  const programs: Record<string, ProgramPin> = {};
  for (const rule of rules) {
    const pin = await pinOf(programOf(rule));
    if (!pin) return { ok: false, rule };
    programs[rule] = pin;
  }
  return { ok: true, programs };
}

/**
 * The pins after a list change: kept entries keep their pins, added ones get
 * theirs, removed ones are dropped, and the first-set time never moves.
 *
 * @param previous - The pins as stored, or `null`.
 * @param added - Pins for the entries this change adds.
 * @param after - The list after the change.
 * @param now - When the change is made.
 */
export function mergePins(
  previous: AllowListPins | null,
  added: Record<string, ProgramPin>,
  after: readonly string[],
  now: string
): AllowListPins {
  const programs: Record<string, ProgramPin> = {};
  for (const rule of after) {
    const pin = previous?.programs[rule] ?? added[rule];
    if (pin) programs[rule] = pin;
  }
  const firstSetAt = previous?.firstSetAt ?? (after.length > 0 ? now : null);
  // Narrowing never makes unreadable pins readable again.
  return { firstSetAt, programs, ...(previous?.unreadable ? { unreadable: true as const } : {}) };
}

/**
 * Whether every entry's program is still the one pinned: same real path, same
 * bytes. Names the first entry that isn't.
 *
 * @param rules - The list a run would carry.
 * @param pins - The task's pins.
 */
export async function checkPins(
  rules: readonly string[],
  pins: AllowListPins
): Promise<{ ok: true } | { ok: false; rule: string }> {
  for (const rule of rules) {
    const pinned = pins.programs[rule];
    const now = pinned ? await pinOf(programOf(rule)) : null;
    if (!pinned || !now || now.path !== pinned.path || now.sha256 !== pinned.sha256) {
      return { ok: false, rule };
    }
  }
  return { ok: true };
}

/**
 * The pins column, read. An empty column is no pins. A column that is there
 * but can't be read is marked `unreadable`: DorkOS can no longer tell which
 * rules its agent set, so every run that carries a list is refused
 * (`run-allow-list.ts`), and a later list is never taken for a first one.
 *
 * @param column - The `allow_list_pins` column.
 */
export function parsePins(column: string | null | undefined): AllowListPins {
  if (!column) return { firstSetAt: null, programs: {} };
  const unreadable: AllowListPins = { firstSetAt: 'unreadable', programs: {}, unreadable: true };
  try {
    const parsed = JSON.parse(column) as Partial<AllowListPins>;
    if (typeof parsed !== 'object' || parsed === null || parsed.unreadable) return unreadable;
    if (typeof parsed.programs !== 'object' || parsed.programs === null) return unreadable;
    const programs: Record<string, ProgramPin> = {};
    for (const [rule, pin] of Object.entries(parsed.programs)) {
      const { path, sha256 } = (pin ?? {}) as Partial<ProgramPin>;
      if (typeof path !== 'string' || typeof sha256 !== 'string') return unreadable;
      programs[rule] = { path, sha256 };
    }
    return {
      firstSetAt: typeof parsed.firstSetAt === 'string' ? parsed.firstSetAt : null,
      programs,
    };
  } catch {
    return unreadable;
  }
}

/**
 * The pins column, written.
 *
 * @param pins - The pins.
 */
export function serializePins(pins: AllowListPins): string {
  return JSON.stringify(pins);
}

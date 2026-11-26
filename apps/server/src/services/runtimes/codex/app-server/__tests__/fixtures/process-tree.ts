/**
 * Process-tree and pnpm helpers for the real-binary permission rows: they find
 * processes by PID and program name only (never a command line), and find a
 * pnpm install without running it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** One process: its PID, its parent's, and its program name (never a command line). */
export interface Proc {
  pid: number;
  parent: number;
  name: string;
}

/** Every process under `pid`, named as `pgrep -l` finds it, in the same call. */
export function namedDescendants(pid: number): Proc[] {
  const found: Proc[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    const parent = queue.pop()!;
    let rows: string[] = [];
    try {
      rows = execFileSync('pgrep', ['-l', '-P', String(parent)], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
    } catch {
      // pgrep exits 1 when there are none.
    }
    for (const row of rows) {
      const [id, ...name] = row.trim().split(/\s+/);
      const child = { pid: Number(id), parent, name: path.basename(name.join(' ')) };
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/** Every process under `pid`, by PID only. */
export function descendants(pid: number): number[] {
  return namedDescendants(pid).map((proc) => proc.pid);
}

/**
 * The sandboxed command's own processes among `procs`: the command's shell,
 * a child of the app-server (sandboxed in place on macOS), and everything under
 * it. Codex starts its own helpers beside it (`codex`, and `sandbox-exec` for
 * its own tools), which a whole-tree count would add in.
 *
 * @param procs - The app-server's new descendants, named.
 * @param rootPid - The app-server's PID.
 */
const COMMAND_SHELLS = new Set(['zsh', 'bash', 'sh']);

export function commandProcesses(procs: Proc[], rootPid: number): Proc[] {
  const inside = new Set(
    procs.filter((p) => p.parent === rootPid && COMMAND_SHELLS.has(p.name)).map((p) => p.pid)
  );
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of procs)
      if (!inside.has(p.pid) && inside.has(p.parent)) {
        inside.add(p.pid);
        grew = true;
      }
  }
  return procs.filter((p) => inside.has(p.pid));
}

/**
 * Count the processes the app-server starts from now on (`peak`), and those of
 * the sandboxed command alone (`commandPeak`), and kill them all by PID once
 * `limitMs` passes or more than 40 are running at once (on the whole tree).
 * `counted` is the command's peak, or the whole tree's when no poll saw the
 * command's shell, so a missed command can never count as 0.
 */
export function watchChildren(rootPid: number, limitMs: number) {
  const before = new Set(descendants(rootPid));
  const started = Date.now();
  let peak = 0;
  let commandPeak = 0;
  let commandNames = '';
  let polls = 0;
  let sandboxPolls = 0;
  let killed = false;
  const timer = setInterval(() => {
    const procs = namedDescendants(rootPid).filter((p) => !before.has(p.pid));
    const extra = procs.map((p) => p.pid);
    peak = Math.max(peak, extra.length);
    const command = commandProcesses(procs, rootPid);
    polls += 1;
    if (command.length > 0) sandboxPolls += 1;
    if (command.length > commandPeak) {
      commandPeak = command.length;
      // Program names at the peak, for the row's log line: never command lines.
      commandNames = command.map((p) => p.name).join(' ');
    }
    if (Date.now() - started <= limitMs && extra.length <= 40) return;
    killed = true;
    for (const pid of extra)
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
  }, 25);
  return {
    stop() {
      clearInterval(timer);
      // A command never seen counts the whole tree, so a missed poll can't pass as 0.
      const counted = sandboxPolls > 0 ? commandPeak : peak;
      return { peak, commandPeak, commandNames, counted, polls, sandboxPolls, killed };
    },
  };
}

/**
 * The first executable `name` on PATH outside this checkout, or `undefined`.
 * CI's pnpm sits in its setup action's own `node_modules/.bin`, so only the
 * checkout's package bins are skipped.
 */
export function findOnPath(name: string): string | undefined {
  const checkout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir || dir === checkout || dir.startsWith(`${checkout}/`)) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
    } catch {
      continue;
    }
    // A Corepack shim fetches pnpm on first use: never run one here.
    return fs.realpathSync(file).includes('corepack') ? undefined : file;
  }
  return undefined;
}

/** The version a pnpm install says it is, from its own package.json, without running it. */
export function ownVersion(pnpm: string): string | undefined {
  try {
    const manifest = path.join(path.dirname(path.dirname(fs.realpathSync(pnpm))), 'package.json');
    return (JSON.parse(fs.readFileSync(manifest, 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

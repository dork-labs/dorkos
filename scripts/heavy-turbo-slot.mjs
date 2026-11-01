#!/usr/bin/env node
// The turbo task `//#heavy-slot` (DOR-3274 Phase 2). Every build, typecheck,
// test and lint task in turbo.json depends on it, so it runs once, first, in any
// `turbo` invocation that would run one of them. It finds the turbo process that
// started it and takes a host-wide heavy-run slot for that process's lifetime
// (`scripts/heavy-run-lock.sh --job --hold <pid>`), so a bare `turbo build`
// queues behind the other heavy runs on the host exactly like `pnpm build`.
//
// It never fails the run: every path out exits 0, and a run it cannot cap
// (no turbo parent found, a long-lived dev or watch run, Windows) is let
// through with one line. Under CI, `DORKOS_HEAVY_LOCK=0`, or inside a run that
// already holds a slot (`pnpm build` exports DORKOS_HEAVY_SLOT_HELD), it is a
// no-op. turbo.json passes those variables to this task alone.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** True when the environment says this run must not take a slot here. */
export function exempt(env, platform = process.platform) {
  if (!['', '0', 'false'].includes(env.CI ?? '')) return true;
  if (env.DORKOS_HEAVY_LOCK === '0' || env.DORKOS_HEAVY_SLOT_HELD) return true;
  return platform === 'win32';
}

/** Task names turbo.json marks persistent: a run of one never ends on its own. */
export function persistentTasks(turboJson) {
  return Object.entries(turboJson.tasks ?? {})
    .filter(([, task]) => task.persistent)
    .map(([name]) => name.split('#').pop());
}

/**
 * True for a turbo command line that runs until stopped (`turbo dev`, `turbo
 * watch build`): holding a slot for its whole life would take one away for
 * hours. Its builds run uncapped, as they did before Phase 2.
 */
export function longLived(args, persistent) {
  const positional = args
    .trim()
    .split(/\s+/)
    .slice(1)
    .filter((word) => !word.startsWith('-'));
  if (positional[0] === 'watch') return true;
  return positional.some((word) => persistent.includes(word));
}

/**
 * The nearest ancestor whose executable is turbo, as `{ pid, args }`, or null.
 * `ps` names a pid; it signals nothing.
 */
export function findTurbo(startPid, ps) {
  let pid = startPid;
  for (let depth = 0; depth < 64 && pid > 1; depth += 1) {
    if (path.basename(ps('comm', pid)) === 'turbo') return { pid, args: ps('args', pid) };
    pid = Number(ps('ppid', pid)) || 0;
  }
  return null;
}

function ps(field, pid) {
  try {
    return execFileSync('ps', ['-o', `${field}=`, '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function main() {
  if (exempt(process.env)) return;
  const say = (line) => console.error(`[heavy-run-lock] ${line}`);
  const turbo = findTurbo(process.ppid, ps);
  if (!turbo) {
    say('no turbo process above this task, so there is no run to hold a slot for.');
    return;
  }
  let persistent = [];
  try {
    persistent = persistentTasks(
      JSON.parse(readFileSync(path.join(repoRoot, 'turbo.json'), 'utf8'))
    );
  } catch {
    // Unreadable turbo.json: only `watch` is recognised as long-lived.
  }
  if (longLived(turbo.args, persistent)) {
    say('a dev or watch run lives until stopped, so it does not hold a slot.');
    return;
  }
  // Waiters see `turbo build --filter=…`, not the binary's full path.
  const describe = ['turbo', ...turbo.args.trim().split(/\s+/).slice(1)].join(' ');
  spawnSync(
    'bash',
    [
      path.join(repoRoot, 'scripts', 'heavy-run-lock.sh'),
      '--job',
      '--hold',
      String(turbo.pid),
      describe,
    ],
    { stdio: 'inherit' }
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch {
    // Never fail the run over the cap.
  }
  process.exit(0);
}

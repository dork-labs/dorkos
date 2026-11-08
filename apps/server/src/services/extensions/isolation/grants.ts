/**
 * The fixed grants an isolated extension's child starts with (DOR-2686, spec
 * §3 and §4): where its files folder is, what its environment holds, whether
 * its assets folder may be granted, and whether its self-check passed. Pure
 * helpers for `isolated-host.ts`, kept apart so each rule is testable alone.
 *
 * @module services/extensions/isolation/grants
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ISOLATION_LIMITS, type HelloMessage } from './ipc-protocol.js';

/**
 * Where an extension's writable files folder is.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param extensionId - The extension id.
 */
export function isolatedFilesDir(dorkHome: string, extensionId: string): string {
  return path.join(dorkHome, 'extension-data', extensionId, 'files');
}

/**
 * The folder an extension's child reads its code and assets from, staged
 * fresh at every start. Host-owned: the child can read it, never write it.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param extensionId - The extension id.
 */
export function isolatedRunDir(dorkHome: string, extensionId: string): string {
  return path.join(dorkHome, 'cache', 'extensions', 'isolated', extensionId);
}

/**
 * Every folder above any of the given paths, up to and including the root,
 * without duplicates. The child's self-check must find each one unreadable.
 *
 * @param paths - Absolute paths (the grants).
 */
export function ancestorsOf(paths: readonly string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    let dir = path.dirname(p);
    for (;;) {
      out.add(dir);
      const up = path.dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  for (const p of paths) out.delete(p);
  return [...out];
}

/**
 * Whether `child` is `root` or inside it.
 *
 * @param root - A folder.
 * @param child - A path.
 */
export function isWithin(root: string, child: string): boolean {
  const rel = path.relative(root, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Find a symbolic link under `assets/` whose target leaves it (or does not
 * resolve). Node follows links outside granted paths, so a link to `~/.ssh`
 * would otherwise be readable.
 *
 * @param assetsReal - The real path of the assets folder.
 * @returns The offending entry, or `null`.
 */
export async function findEscapingLink(assetsReal: string): Promise<string | null> {
  const stack = [assetsReal];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(full).catch(() => null);
        if (!target || !isWithin(assetsReal, target)) return full;
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return null;
}

/**
 * Whether a self-check report shows the child running with its limits.
 *
 * @param hello - The child's first message.
 */
export function selfCheckPassed(hello: HelloMessage): boolean {
  const p = hello.permission;
  return (
    p.present &&
    p.readsBootstrap &&
    !p.fsWriteRoot &&
    !p.fsReadRoot &&
    !p.readsDorkHome &&
    p.readableAncestors.length === 0 &&
    !p.inspector &&
    !p.child &&
    !p.worker &&
    !p.addon &&
    !p.wasi &&
    !p.sqlite
  );
}

/**
 * The Node flags an isolated child starts with: the permission model with
 * exactly its read and write grants, no `node:sqlite`, and its memory cap.
 *
 * `node:sqlite` ignores `--permission`, so with it a child could open and
 * write any SQLite file, DorkOS's own database included (DOR-3547).
 * `--no-experimental-sqlite` removes the module, so `require`, `import()` and
 * `getBuiltinModule` all fail, and `NODE_OPTIONS` can't put it back (the
 * environment is scrubbed). The self-check proves it held.
 *
 * @param reads - The read grants (real paths).
 * @param filesReal - The one write grant, the files folder (real path).
 * @param memoryMb - The heap cap.
 * @param seams - Test seams. `omitPermission` drops the model and its grants
 *   together (a grant without `--permission` is a startup error, which would
 *   never reach the self-check the seam exists to prove); `omitSqliteOff`
 *   drops the sqlite flag alone.
 */
export function childExecArgv(
  reads: readonly string[],
  filesReal: string,
  memoryMb: number,
  seams: { omitPermission?: boolean; omitSqliteOff?: boolean } = {}
): string[] {
  return [
    ...(seams.omitPermission
      ? []
      : [
          '--permission',
          ...reads.map((p) => `--allow-fs-read=${p}`),
          `--allow-fs-write=${filesReal}`,
        ]),
    ...(seams.omitSqliteOff ? [] : ['--no-experimental-sqlite']),
    `--max-old-space-size=${memoryMb}`,
  ];
}

/** Timings, overridable by tests so a hang is caught in seconds, not minutes. */
export interface IsolatedHostTimings {
  helloTimeoutMs: number;
  loadTimeoutMs: number;
  pingIntervalMs: number;
  pongTimeoutMs: number;
  stopGraceMs: number;
}

/** The default timings (spec §9). */
export const DEFAULT_TIMINGS: IsolatedHostTimings = {
  helloTimeoutMs: ISOLATION_LIMITS.helloTimeoutMs,
  loadTimeoutMs: 15_000,
  pingIntervalMs: ISOLATION_LIMITS.pingIntervalMs,
  pongTimeoutMs: ISOLATION_LIMITS.pongTimeoutMs,
  stopGraceMs: ISOLATION_LIMITS.stopGraceMs,
};

/** V8's message when a process dies at its heap limit. */
export const OOM_MARKER = /heap out of memory|Reached heap limit/i;

/**
 * Whether an exit looks like V8's heap-limit abort (SIGABRT on POSIX; a
 * normalized abort code on Windows), so a child that merely PRINTS the marker and exits
 * is still reported as a crash.
 *
 * @param code - The exit code.
 * @param signal - The signal, if one ended it.
 */
export function abortedLike(code: number | null, signal: NodeJS.Signals | null): boolean {
  if (signal === 'SIGABRT' || signal === 'SIGTRAP' || signal === 'SIGILL') return true;
  // Node normalizes its Windows ABORT path to kAbort (134), not any nonzero exit.
  // https://github.com/nodejs/node/blob/v22.x/src/node_exit_code.h
  return process.platform === 'win32' && code === 134;
}

/**
 * Build the child's environment from nothing.
 *
 * @param extensionId - The extension id.
 * @param filesDir - Its files folder (real path).
 * @param source - The host environment to copy locale and time zone from.
 * @param platform - Host platform; Windows prevents libuv's host-variable refill.
 * @param electronRunAsNode - Whether the binary is Electron, run as plain Node.
 */
export function buildChildEnv(
  extensionId: string,
  filesDir: string,
  source: NodeJS.ProcessEnv,
  electronRunAsNode: boolean = Boolean(process.versions.electron),
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // SystemRoot and windir name the Windows folder, not a secret; without them
  // Winsock cannot load its providers, so not even an allowed connection works.
  for (const key of ['NODE_ENV', 'TZ', 'LANG', 'SystemRoot', 'windir']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && value !== undefined) env[key] = value;
  }
  if (platform === 'win32') {
    // libuv refills these from the host if omitted. Explicit empty values
    // preserve the scrubbed environment without leaking host identity or PATH.
    // https://github.com/libuv/libuv/blob/v1.x/src/win/process.c#L47
    for (const key of ['PATH', 'USERNAME', 'USERDOMAIN', 'LOGONSERVER']) env[key] = '';
    const drive = path.win32.parse(filesDir).root.replace(/\\$/, '');
    env.HOMEDRIVE = drive;
    env.HOMEPATH = filesDir.slice(drive.length);
  }
  const tmp = path.join(filesDir, '.tmp');
  env.HOME = filesDir;
  env.USERPROFILE = filesDir;
  env.TMPDIR = tmp;
  env.TMP = tmp;
  env.TEMP = tmp;
  env.DORKOS_EXT_ID = extensionId;
  if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

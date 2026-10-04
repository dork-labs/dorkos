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
import type { HelloMessage } from './ipc-protocol.js';

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
    p.present && p.readsBootstrap && !p.fsWriteRoot && !p.child && !p.worker && !p.addon && !p.wasi
  );
}

/**
 * Build the child's environment from nothing.
 *
 * @param extensionId - The extension id.
 * @param filesDir - Its files folder (real path).
 * @param source - The host environment to copy locale and time zone from.
 * @param electronRunAsNode - Whether the binary is Electron, run as plain Node.
 */
export function buildChildEnv(
  extensionId: string,
  filesDir: string,
  source: NodeJS.ProcessEnv,
  electronRunAsNode: boolean = Boolean(process.versions.electron)
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['NODE_ENV', 'TZ', 'LANG']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('LC_') && value !== undefined) env[key] = value;
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

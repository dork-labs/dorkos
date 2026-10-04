/**
 * The one normalized view of how an extension that runs separately is
 * limited (`record.isolation`, DOR-2686 task 1.2), built by discovery from
 * its validated manifest so the lifecycle, the approval queue and the app
 * never re-derive it.
 *
 * @module services/extensions/isolation/isolation-view
 */
import {
  ISOLATION_MEMORY_MB,
  type ExtensionIsolation,
  type ExtensionManifest,
  type ExtensionRecord,
} from '@dorkos/extension-api';
import fs from 'fs/promises';
import path from 'path';
import { ISOLATED_SERVER_PARTS_RUN } from '@dorkos/shared/extension-server-status';
import { resolveProgram, type ResolveProgramOptions } from './resolve-program.js';

/**
 * The folders an extension ships in, as named and as they really are: its own
 * folder and, when it sits at `<root>/.dork/extensions/<id>`, the whole
 * package `<root>` (a plugin, a dev-linked working folder, or a project).
 * Programs inside them are refused (`resolve-program.ts`).
 *
 * @param extensionDir - The extension's folder.
 */
async function ownFoldersOf(extensionDir: string, dorkHome: string): Promise<string[]> {
  const named = path.resolve(extensionDir);
  const real = await fs.realpath(named).catch(() => named);
  const homes = new Set([
    path.resolve(dorkHome),
    await fs.realpath(dorkHome).catch(() => dorkHome),
  ]);
  const folders = new Set<string>([named, real]);
  for (const dir of [named, real]) {
    const dotDork = path.dirname(path.dirname(dir));
    // `{dorkHome}/extensions/<id>` is installed directly: DorkOS's data
    // directory is not a package, and the folder above it is not either.
    if (homes.has(dotDork)) continue;
    if (path.basename(path.dirname(dir)) === 'extensions' && path.basename(dotDork) === '.dork') {
      folders.add(path.dirname(dotDork));
    }
  }
  return [...folders];
}

/**
 * Build the isolation view for a validated manifest.
 *
 * @param manifest - The parsed `extension.json`.
 * @param options - Where to look for `allow.run` programs (see {@link resolveProgram}).
 * @returns The view, or `null` for an extension that runs inside DorkOS.
 */
export async function isolationOf(
  manifest: ExtensionManifest,
  options: ResolveProgramOptions & { extensionDir?: string }
): Promise<ExtensionIsolation | null> {
  const caps = manifest.serverCapabilities;
  if (caps?.runtime !== 'subprocess') return null;
  const net = [...(caps.allow?.net ?? [])];
  const run = [...(caps.allow?.run ?? [])];
  const refusedRoots = [
    ...(options.refusedRoots ?? []),
    ...(options.extensionDir ? await ownFoldersOf(options.extensionDir, options.dorkHome) : []),
  ];
  const resolvedRun = await Promise.all(
    run.map(async (name) => {
      const found = await resolveProgram(name, { ...options, refusedRoots });
      return found.path === null
        ? { name, path: null, reason: found.reason }
        : { name, path: found.path };
    })
  );
  return {
    runtime: 'subprocess',
    net,
    run,
    resolvedRun,
    agents: caps.allow?.agents ?? false,
    memoryMb: caps.limits?.memoryMb ?? ISOLATION_MEMORY_MB.default,
  };
}

/**
 * Where the extension runs and what it may reach, as part of what a running
 * instance was built from (DOR-2686): a manifest-only change to `runtime`,
 * `allow` or `limits` restarts it (narrower) or, once the approval no longer
 * covers it, leaves it waiting (wider).
 *
 * @param record - The extension's discovery record.
 */
export function isolationKeyOf(record: Pick<ExtensionRecord, 'isolation'>): {
  runtime: 'subprocess';
  net: string[];
  run: string[];
  agents: boolean;
  memoryMb: number;
} | null {
  const isolation = record.isolation;
  if (!isolation) return null;
  return {
    runtime: isolation.runtime,
    net: isolation.net,
    run: isolation.run,
    agents: isolation.agents,
    memoryMb: isolation.memoryMb,
  };
}

/**
 * Whether this extension asks to run separately and so does not run yet
 * (DOR-2686 phase 1): its server half is refused with `isolation_not_ready`,
 * and nothing it ships — skills included — reaches agents as if it ran. Gated
 * by `ISOLATED_SERVER_PARTS_RUN` (`@dorkos/shared/extension-server-status`),
 * the same switch that puts "can't run in this version yet" on every card, so
 * the refusal and the warning cannot drift apart. The phase that starts
 * isolated extensions flips that switch, then deletes this and its uses.
 *
 * @param manifest - The parsed `extension.json`.
 */
export function waitsForIsolation(manifest: ExtensionManifest): boolean {
  // One switch for the refusal and the card line that warns of it.
  return !ISOLATED_SERVER_PARTS_RUN && manifest.serverCapabilities?.runtime === 'subprocess';
}

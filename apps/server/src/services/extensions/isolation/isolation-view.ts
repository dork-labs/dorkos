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
} from '@dorkos/extension-api';
import { resolveProgram, type ResolveProgramOptions } from './resolve-program.js';

/**
 * Build the isolation view for a validated manifest.
 *
 * @param manifest - The parsed `extension.json`.
 * @param options - Where to look for `allow.run` programs (see {@link resolveProgram}).
 * @returns The view, or `null` for an extension that runs inside DorkOS.
 */
export async function isolationOf(
  manifest: ExtensionManifest,
  options: ResolveProgramOptions
): Promise<ExtensionIsolation | null> {
  const caps = manifest.serverCapabilities;
  if (caps?.runtime !== 'subprocess') return null;
  const net = [...(caps.allow?.net ?? [])];
  const run = [...(caps.allow?.run ?? [])];
  const resolvedRun = await Promise.all(
    run.map(async (name) => ({ name, path: await resolveProgram(name, options) }))
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

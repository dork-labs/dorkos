/**
 * What the compiler holds a plugin-carried extension to, so the code that runs
 * is the code DorkOS judged (security reviews of DOR-2527, spec
 * `flow-multiproject` §9.1).
 *
 * Two checks, both in {@link ExtensionCompiler}:
 *
 * - **Containment.** An extension's bundle may import only files inside its
 *   own plugin's install folder. An import that resolves anywhere else — a
 *   relative path climbing out, or a bare package found in the PROJECT's
 *   `node_modules` rather than the plugin's own — is refused and the build
 *   fails. A project copy's digest covers the plugin folder and nothing
 *   beyond it, so code from outside would run under the plugin's approval
 *   without ever being checked. The host's externals (`react`,
 *   `@dorkos/extension-api`, `express`) and Node's built-ins are left to the
 *   host, as before.
 * - **The pinned digest.** A copy whose trust was judged against a plugin
 *   folder digest (`ExtensionRecord.pinnedDigest`) is re-hashed immediately
 *   before the bundle is built or served and again right after, so files
 *   swapped between the scan and the load, or during the build, never run.
 *   The bundle is then held in memory and the cache; later edits on disk
 *   change nothing until the next load, which checks again.
 *
 * @module services/extensions/extension-plugin-guard
 */
import fs from 'fs/promises';
import path from 'path';
import type { Plugin } from 'esbuild';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { installFolderDigest } from '../marketplace/lib/install-digest.js';
import { installRootOf } from './extension-trusted-origin.js';

/** The code a pinned-digest refusal carries. */
export const PLUGIN_CHANGED_CODE = 'plugin_changed_since_check';

/**
 * The folder a copy's bundle is contained to: a plugin-carried copy's install
 * folder, and every other copy's own folder (DOR-3068): the snapshot it runs
 * from, or else its real path. No bundle inlines a file from outside it, so
 * a copy approved by its folder, or one that keeps path trust, can never pull
 * in a file nobody approved (`../../.ssh/id_rsa`, another agent's code). A
 * copy's own `node_modules` sits inside its folder and resolves as before.
 *
 * A dev link (DOR-2696) keeps what it had before: a person linked a working
 * folder on purpose and approved it by path, and its build may reach the
 * workspace around it. One carried in a plugin slot is still contained to it.
 */
export function containmentRootOf(
  record: Pick<ExtensionRecord, 'path' | 'sourcePlugin' | 'runPath' | 'realPath' | 'devLink'>
): string | null {
  if (record.sourcePlugin) return installRootOf(record.runPath ?? record.path);
  if (record.devLink) return null;
  return path.resolve(record.runPath ?? record.realPath ?? record.path);
}

/**
 * Which folder {@link containmentRootOf} holds a copy to, in words a refusal
 * can name: the plugin's folder for a plugin-carried copy, and the
 * extension's own folder for every other.
 */
export type ContainmentBoundary = 'plugin' | 'extension';

/**
 * The boundary {@link containmentRootOf} applies to a copy.
 *
 * @param record - The copy being compiled.
 */
export function containmentBoundaryOf(
  record: Pick<ExtensionRecord, 'sourcePlugin'>
): ContainmentBoundary {
  return record.sourcePlugin ? 'plugin' : 'extension';
}

/**
 * Whether `target` is `root` or inside it.
 *
 * @param target - An absolute, canonical path.
 * @param root - An absolute, canonical folder.
 */
function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * An esbuild plugin that refuses every import resolving outside `root`.
 *
 * It asks esbuild to resolve each import as it normally would, then checks
 * where the answer is on disk, links followed. Host externals and anything
 * esbuild itself marks external (Node built-ins on the server) pass through.
 *
 * @param root - The folder imports must stay inside ({@link containmentRootOf}).
 * @param externals - The build's `external` list, which the host provides.
 * @param boundary - Which folder `root` is, so a refusal names the rule that
 *   applies ({@link containmentBoundaryOf}).
 */
export function containmentPlugin(
  root: string,
  externals: readonly string[],
  boundary: ContainmentBoundary = 'plugin'
): Plugin {
  const rule =
    boundary === 'plugin'
      ? `outside this plugin's folder (${root}). A plugin's extension may import only files ` +
        `its plugin ships`
      : `outside this extension's folder (${root}). An extension may import only files ` +
        `inside its own folder`;
  return {
    name: 'dorkos-plugin-containment',
    setup(build) {
      const realRoot = fs.realpath(root).catch(() => path.resolve(root));
      build.onResolve({ filter: /.*/ }, async (args) => {
        if ((args.pluginData as { dorkosContained?: boolean } | undefined)?.dorkosContained) {
          return undefined;
        }
        if (args.kind === 'entry-point') return undefined;
        if (externals.some((name) => args.path === name || args.path.startsWith(`${name}/`))) {
          return undefined;
        }
        const resolved = await build.resolve(args.path, {
          kind: args.kind,
          importer: args.importer,
          resolveDir: args.resolveDir,
          namespace: args.namespace,
          pluginData: { dorkosContained: true },
        });
        if (resolved.errors.length > 0) return { errors: resolved.errors };
        if (resolved.external || !resolved.path) return undefined;
        const real = await fs.realpath(resolved.path).catch(() => path.resolve(resolved.path));
        if (!isInside(real, await realRoot)) {
          return {
            errors: [
              {
                text: `'${args.path}' resolves to ${real}, ${rule}, so DorkOS did not build it.`,
              },
            ],
          };
        }
        return {
          path: resolved.path,
          namespace: resolved.namespace,
          sideEffects: resolved.sideEffects,
          suffix: resolved.suffix,
        };
      });
    },
  };
}

/**
 * Whether a copy's digested folder (its plugin's, or its own) still has the
 * digest it was judged against. A copy with no pinned digest has nothing to
 * hold to and always passes.
 *
 * @param record - The copy being compiled.
 */
export async function stillPinned(
  record: Pick<ExtensionRecord, 'path' | 'sourcePlugin' | 'pinnedDigest' | 'runPath'>
): Promise<boolean> {
  if (!record.pinnedDigest) return true;
  // A snapshot is re-hashed too (DOR-3068): its folder name says what it
  // should hold, not what it does, and its files could be edited after it
  // was written. The digest's stamp cache keeps an unchanged one cheap.
  const root = containmentRootOf(record);
  if (!root) return false;
  const now = await installFolderDigest(root);
  return now.kind === 'digest' && now.digest === record.pinnedDigest;
}

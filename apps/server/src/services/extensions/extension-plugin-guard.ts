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

/** The install folder a plugin-carried copy is contained to, or null. */
export function containmentRootOf(
  record: Pick<ExtensionRecord, 'path' | 'sourcePlugin' | 'runPath'>
): string | null {
  return record.sourcePlugin ? installRootOf(record.runPath ?? record.path) : null;
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
 * @param root - The plugin's install folder.
 * @param externals - The build's `external` list, which the host provides.
 */
export function containmentPlugin(root: string, externals: readonly string[]): Plugin {
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
                text:
                  `'${args.path}' resolves to ${real}, outside this plugin's folder. DorkOS ` +
                  `only bundles files the plugin itself ships, so it did not build it.`,
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
 * Whether a copy's plugin folder still has the digest it was judged against.
 * A copy with no pinned digest has nothing to hold to and always passes.
 *
 * @param record - The copy being compiled.
 */
export async function stillPinned(
  record: Pick<ExtensionRecord, 'path' | 'sourcePlugin' | 'pinnedDigest' | 'runPath'>
): Promise<boolean> {
  if (!record.pinnedDigest) return true;
  // A snapshot is named by its digest and verified when it was written: it is
  // the pinned files, by construction, and nothing else writes to it.
  if (record.runPath) return true;
  const root = containmentRootOf(record);
  if (!root) return false;
  const now = await installFolderDigest(root);
  return now.kind === 'digest' && now.digest === record.pinnedDigest;
}

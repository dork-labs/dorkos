/**
 * What decides whether a running server half is still current, and where it
 * runs (DOR-1336, DOR-2686).
 *
 * @module services/extensions/server-bundle/source-key
 */
import path from 'path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import { extensionDeclarationDigest } from '../agent-tools/declaration-digest.js';
import { isolationKeyOf } from '../isolation/isolation-view.js';

/**
 * Everything the running instance of an extension was built from, as one
 * comparable string: the directory it was read from, the manifest fields that
 * decide what gets mounted, and — for an extension with a server entry — the
 * content hash of its compiled server bundle.
 *
 * This is what makes {@link ExtensionServerLifecycle.initialize} idempotent. The
 * client asks the server to initialize every server-side extension on every page
 * load and every tab, and before this each of those tore the extension down and
 * re-evaluated its module (DOR-1336).
 *
 * The server bundle's hash is the one that matters, not `record.sourceHash` —
 * that field is the CLIENT bundle's hash, which answers a different question and
 * would have missed an edited `server.ts`.
 *
 * The manifest's tool and skill declarations are covered too
 * ({@link extensionDeclarationDigest}): a running instance's tools are the
 * ones its manifest declared when it started, so a changed declaration needs
 * a restart to take effect (DOR-2685).
 *
 * The bundle hash covers everything `server.ts` imports, because it is the
 * hash of the bundled output (`ExtensionCompiler.compileServer`, DOR-2491): an
 * edit to a helper module changes the bundle and so restarts the extension,
 * while an edit that leaves the output identical does not.
 *
 * @param record - The extension's discovery record.
 * @param serverSourceHash - Content hash of the compiled server bundle, or
 *   `null` for a proxy-only extension (there is no server source to hash).
 */
export function buildSourceKey(record: ExtensionRecord, serverSourceHash: string | null): string {
  return JSON.stringify({
    path: path.resolve(record.path),
    runPath: record.runPath ?? null,
    version: record.manifest.version,
    serverEntryPath: record.serverEntryPath ?? null,
    dataProxy: record.manifest.dataProxy ?? null,
    declarations: extensionDeclarationDigest(record.manifest),
    isolation: isolationKeyOf(record),
    separate: runsSeparately(record),
    serverSourceHash,
  });
}

/**
 * Whether an extension's server half runs in its own process: its manifest
 * asks for it, or discovery says so. Either one is enough, so a record
 * missing its isolation view is refused rather than run inside DorkOS.
 *
 * @param record - The extension's discovery record.
 */
export function runsSeparately(record: ExtensionRecord): boolean {
  return record.manifest.serverCapabilities?.runtime === 'subprocess' || !!record.isolation;
}

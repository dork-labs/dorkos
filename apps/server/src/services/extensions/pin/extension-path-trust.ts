/**
 * When an approved extension keeps running after its files change, and when
 * an edit waits for a person (DOR-3068).
 *
 * ## The rule
 *
 * An approval names one copy's files: the digest of its folder at the moment
 * of the yes (`approvedSources[id].digest`). An edit to them stops the code
 * running until a person looks again, because a yes to one set of files is
 * not a yes to whatever an agent writes next.
 *
 * One kind of copy keeps PATH trust instead, so its edit → test → reload loop
 * never asks (the DOR-504/506 routine-card harm): an extension one of our
 * agents created, while all of these hold (Security's conditions, option 1):
 *
 * 1. **It runs separately** (`serverCapabilities.runtime: "subprocess"`), so
 *    its server half is held to the limits it declares. An extension that
 *    runs inside DorkOS has the server's full access, and is always pinned.
 * 2. **It declares exactly what it declared at the yes**: where it runs, its
 *    `allow` lists, its secrets, its data proxy and its server entry
 *    ({@link grantsDigestOf}). A change to any of them waits for a person.
 * 3. **It lives inside its author's own folder, by real path.** The approval
 *    records the creating agent's folder (`authorHome`, real path) when
 *    `create_extension` scaffolds it there, never inferred later from where
 *    a folder sits. The copy's real path ({@link ExtensionRecord.realPath})
 *    must stay inside that folder's `.dork/extensions/`, so a link out of it,
 *    a copy moved into another agent's folder, or one promoted or copied to
 *    the global folder (scope `global`) is pinned. An approval with no author
 *    (a person's yes by hand, or a create from a turn that read a stranger's
 *    words or ran under a ceiling) is pinned.
 *
 * Path trust covers the SERVER half only. The screen half (the client bundle
 * the app `import()`s into its own page, where it carries the person's
 * session) is always pinned by content: the approval stores the digest of
 * the exact bundle bytes ({@link bundleDigestOf}), and a bundle that differs
 * is never served or tested until a person approves again
 * ({@link clientPinHolds}), while the server half keeps running.
 *
 * Everything else (marketplace and plugin copies, copies approved by hand,
 * older approvals) is pinned by content and checked at every load.
 *
 * Pure: no I/O. The real path is read by discovery, the digest by
 * `extension-content-pin.ts`.
 *
 * @module services/extensions/pin/extension-path-trust
 */
import { createHash } from 'crypto';
import path from 'path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';

/** The fields of a copy the path-trust rule reads. */
export type PathTrustCopy = Pick<ExtensionRecord, 'manifest' | 'sourcePlugin'> &
  Partial<Pick<ExtensionRecord, 'realPath' | 'devLink' | 'scope'>>;

/**
 * A digest of what a manifest declares it may reach: where its server half
 * runs, its `allow` lists, its secrets, its data proxy and its server entry.
 * Tools, skills and display fields are left out, so editing them never asks.
 *
 * @param manifest - The parsed `extension.json`.
 * @returns `sha256:<hex>`.
 */
export function grantsDigestOf(manifest: ExtensionManifest): string {
  const caps = manifest.serverCapabilities;
  const grants = {
    runtime: caps?.runtime ?? 'in-process',
    net: caps?.allow?.net ?? [],
    run: caps?.allow?.run ?? [],
    agents: caps?.allow?.agents ?? false,
    secrets: caps?.secrets ?? [],
    serverEntry: caps ? caps.serverEntry : null,
    dataProxy: manifest.dataProxy ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(grants)).digest('hex')}`;
}

/**
 * Whether `target` is `root` or inside it. Both are expected to be real paths.
 *
 * @param target - A real path.
 * @param root - A real folder.
 */
export function isInsideFolder(target: string, root: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether this copy keeps path trust under the approval stored for it: an
 * agent-created extension that runs separately, declares what it declared at
 * the yes, and lives inside its author's folder (conditions 1 to 3 above).
 * The caller has already checked the approval names this copy's path.
 *
 * @param copy - The extension record.
 * @param source - The approval stored for its id.
 */
export function keepsPathTrust(copy: PathTrustCopy, source: ExtensionApprovedSource): boolean {
  if (!source.authorHome || !source.grants) return false;
  // Plugins and dev links come from outside an agent's own folder.
  if (copy.sourcePlugin || copy.devLink) return false;
  if (copy.manifest.serverCapabilities?.runtime !== 'subprocess') return false;
  if (source.grants !== grantsDigestOf(copy.manifest)) return false;
  // The global folder is a person's; a copy promoted there is pinned.
  if (copy.scope !== 'local') return false;
  return (
    !!copy.realPath &&
    isInsideFolder(copy.realPath, path.join(source.authorHome, '.dork', 'extensions'))
  );
}

/**
 * Whether an approval leaves its copy's files unpinned: path trust, which
 * stores no folder digest but names an author. The screen half of such a
 * copy is held by {@link clientPinHolds} instead.
 *
 * @param source - The approval stored for an id.
 */
export function isPathTrustApproval(source: ExtensionApprovedSource): boolean {
  return !source.digest && !!source.authorHome && !source.devLink;
}

/**
 * The digest of a client bundle: the exact bytes the app would load.
 *
 * @param code - The compiled bundle, as served.
 * @returns `sha256:<hex>`.
 */
export function bundleDigestOf(code: string): string {
  return `sha256:${createHash('sha256').update(code, 'utf8').digest('hex')}`;
}

/**
 * Whether a copy's screen half may load under the approval stored for it
 * (Security's condition: the client bundle is always pinned). A copy pinned
 * by folder digest already holds its bundle's sources to the approved files,
 * so only a path-trust approval is checked here: the bundle must be exactly
 * the one approved. One with no stored bundle digest loads nothing.
 *
 * @param bundleDigest - The digest of the bundle about to load, or undefined
 *   when there is no compiled bundle to load.
 * @param source - The approval stored for this copy, if any.
 */
export function clientPinHolds(
  bundleDigest: string | undefined,
  source: ExtensionApprovedSource | undefined
): boolean {
  if (!source || !isPathTrustApproval(source) || bundleDigest === undefined) return true;
  return source.clientDigest === bundleDigest;
}

/**
 * Whether a stored approval was written before approvals named content: no
 * digest, no author, no grants and no dev link, and marked so by the
 * `'0.126.0'` config migration (`legacyPathOnly`). Those are pinned once, to
 * the files found on the first scan after the upgrade; a digest-less approval
 * written since is not, and does not run.
 *
 * @param source - The approval stored for an id.
 */
export function isPathOnlyApproval(source: ExtensionApprovedSource): boolean {
  return (
    source.legacyPathOnly === true &&
    !source.digest &&
    !source.authorHome &&
    !source.grants &&
    !source.devLink
  );
}

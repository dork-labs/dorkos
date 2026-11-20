/**
 * The ctx dependencies a discovery record decides, kept apart from the ctx
 * factory itself so a test that stands in for the factory still starts a
 * server half with the record's real dependencies.
 *
 * @module services/extensions/server-bundle/extension-context-deps
 */
import type { ExtensionRecord } from '@dorkos/extension-api';
import { checkDeclaredTools, type ExtensionToolCheck } from '@dorkos/extension-api/tool-check';
import type { CreateContextDeps } from '../extension-server-api-factory.js';
import type { ExtensionApprovals } from '../extension-load-policy.js';
import { allowedPlacesOf } from '../isolation/place-grace.js';
import { requireRunDir } from '../pin/run-dir.js';

/** What {@link recordContextDeps} decides from a record. */
export type RecordContextDeps = Pick<
  CreateContextDeps,
  'extensionId' | 'extensionDir' | 'dorkHome' | 'extensionName' | 'contributions' | 'allowedPlaces'
> & {
  /** Discovery's verdict on each tool the manifest declares. */
  toolChecks: ExtensionToolCheck[];
};

/**
 * The ctx dependencies a discovery record decides, for both ways a server
 * half starts (in process and isolated).
 *
 * @param id - The extension id.
 * @param record - Its discovery record. Read again on every inbox call, so
 *   the places follow the record as it is then.
 * @param dorkHome - DorkOS's data directory.
 * @param approvals - Reads the stored approvals as they are now
 *   (`config.extensions`).
 * @throws {Error} When the copy is pinned to its files but has no verified
 *   snapshot to run from (`pin/run-dir.ts`): it does not start.
 */
export function recordContextDeps(
  id: string,
  record: ExtensionRecord,
  dorkHome: string,
  approvals: () => ExtensionApprovals
): RecordContextDeps {
  return {
    extensionId: id,
    // A pinned copy runs from its verified snapshot, so what it reaches
    // relative to itself at runtime is the snapshot's too; one with no
    // snapshot never falls back to the folder it was found in.
    extensionDir: requireRunDir(record),
    dorkHome,
    extensionName: record.manifest.name,
    toolChecks: checkDeclaredTools(record.manifest),
    // `ctx.inbox` only for an app whose card named Inbox cards (DOR-4282),
    contributions: record.manifest.contributions ?? {},
    // and only while the person's stored yes covers them.
    allowedPlaces: () => allowedPlacesOf(record, approvals()),
  };
}

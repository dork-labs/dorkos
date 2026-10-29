/**
 * The Trusted-install approval for an extension one of our agents just created
 * (DOR-2739), split from `extension-manager.ts`, which calls it from
 * `createExtension`.
 *
 * @module services/extensions/pin/extension-scaffold-approval
 */
import { ExtensionManifestSchema, type ExtensionRecord } from '@dorkos/extension-api';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { trustPosture } from '@dorkos/shared/permissions';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { declaredSet } from '../isolation/permission-coverage.js';
import { approvalFor, liveDigestOf, realPathOf } from './extension-content-pin.js';
import { isPathTrustApproval } from './extension-path-trust.js';
import { rulePath } from '../../runtimes/claude-code/messaging/directory-grants.js';
import path from 'path';

/**
 * Approve a copy one of our agents just scaffolded, when the install is
 * Trusted (ADR 261006-225605, item 5; spec `trusted-by-default-flip` §5.5).
 *
 * Written through the same three fields `ExtensionManager.approveToRun` writes, so the
 * approval is exactly as narrow as a person's: bound to this folder
 * (`approvedSources`) and to the permission set the manifest declares now
 * (`approvedPermissions`). A marketplace or hand-copied extension with the
 * same id at another path, or a later version that asks for more, still
 * waits for a person.
 *
 * Written BEFORE the scan that first sees the copy, so the copy is never
 * counted as waiting: the approval inbox does not raise a row for it and then
 * retire it a moment later.
 *
 * Skipped on Careful, and for an id the person said "Not now" to: that answer
 * stands until they turn the extension on themselves.
 *
 * It records the creating agent's folder (its real path) and the grants the
 * manifest declares (DOR-3068), so the copy keeps path trust while it runs
 * separately inside that folder (`extension-path-trust.ts`). Anything else,
 * including every template that runs inside DorkOS, is pinned to the files
 * just scaffolded, so the agent's first edit waits for a person.
 *
 * @param id - The new extension's id.
 * @param scaffold - The folder and manifest the scaffolder just wrote, and
 *   the digest of the files it wrote. Only those exact files are approved: a
 *   folder that changed since, or one DorkOS could not digest, waits.
 * @param authorHome - The creating agent's folder, recorded as the author
 *   only when the create came from that agent's own unmarked, unceilinged
 *   turn and was scaffolded inside it (`ExtensionManager.createExtension`).
 * @returns The approved permission set, or `null` when nothing was approved.
 */
export async function approveNewScaffold(
  id: string,
  scaffold: {
    targetDir: string;
    manifest: object;
    scope?: 'global' | 'local';
    digest: string | null;
  },
  authorHome?: string
): Promise<ApprovedPermissionSet | null> {
  if (trustPosture(configManager.get('permissions')?.preset) !== 'trusted') return null;
  if (!scaffold.digest) return null;
  if (configManager.get('extensions').dismissedApprovals?.[id]) return null;
  const manifest = ExtensionManifestSchema.safeParse(scaffold.manifest);
  // A manifest the host cannot read would not run anyway; it waits like any other.
  if (!manifest.success) return null;
  const permissions = declaredSet(manifest.data);
  const copy = {
    id,
    origin: 'user' as const,
    path: scaffold.targetDir,
    manifest: manifest.data,
    realPath: (await realPathOf(scaffold.targetDir)) ?? undefined,
    ...(scaffold.scope ? { scope: scaffold.scope } : {}),
  };
  // Only a copy scaffolded into its agent's own folder is given an author, and
  // only when every launch can name that folder in a deny rule (DOR-3068).
  const realAuthorHome =
    authorHome && scaffold.scope === 'local' ? await realPathOf(authorHome) : null;
  const author =
    realAuthorHome && rulePath(path.join(realAuthorHome, '.dork', 'extensions'))
      ? realAuthorHome
      : null;
  // Approve only what the scaffolder wrote: a write since then waits.
  const live = await liveDigestOf(copy);
  if (live !== scaffold.digest) return null;
  const source = approvalFor(copy, {
    digest: live,
    ...(author ? { authorHome: author } : {}),
  });
  // A folder DorkOS cannot digest waits for a person like any other.
  if (!source) return null;
  // Read after the awaits above, so a write made meanwhile is kept.
  const before = configManager.get('extensions');
  configManager.set('extensions', {
    ...before,
    approvedToRun: before.approvedToRun.includes(id)
      ? before.approvedToRun
      : [...before.approvedToRun, id],
    approvedSources: {
      ...(before.approvedSources ?? {}),
      [id]: source,
    },
    approvedPermissions: { ...(before.approvedPermissions ?? {}), [id]: permissions },
  });
  logConfigWrite(
    'approving an extension an agent created',
    'extensions',
    before,
    configManager.get('extensions')
  );
  return permissions;
}

/**
 * Pin the screen half of an extension an agent just created to the client
 * bundle built from its scaffold (DOR-3068). Its path trust covers the server
 * half only, so the app loads new screen code only after a person approves
 * it. Writes only when the stored approval keeps path trust; an approval
 * pinned by folder digest already holds the screen code to those files.
 *
 * Pinned only when the bundle was built from a verified snapshot of exactly
 * the files DorkOS scaffolded (`record.pinnedDigest`, the snapshot it ran
 * from), so an edit that landed mid-build, even one reverted since, is never
 * what gets pinned. Otherwise nothing is pinned and the screen half waits
 * for a person.
 *
 * @param record - The new extension, just compiled.
 * @param scaffolded - The digest of its folder right after it was scaffolded.
 */
export function pinScaffoldClient(
  record: Pick<ExtensionRecord, 'id' | 'clientDigest' | 'pinnedDigest' | 'runPath'>,
  scaffolded: string | null
): void {
  const { id, clientDigest } = record;
  if (!clientDigest || !scaffolded || !record.runPath || record.pinnedDigest !== scaffolded) {
    return;
  }
  const before = configManager.get('extensions');
  const source = before.approvedSources?.[id];
  if (!source || !isPathTrustApproval(source) || source.clientDigest) return;
  configManager.set('extensions', {
    ...before,
    approvedSources: { ...(before.approvedSources ?? {}), [id]: { ...source, clientDigest } },
  });
  logConfigWrite(
    'pinning the screen code of an extension an agent created',
    'extensions',
    before,
    configManager.get('extensions')
  );
}

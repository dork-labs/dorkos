/**
 * The Trusted-install approval for an extension one of our agents just created
 * (DOR-2739), split from `extension-manager.ts`, which calls it from
 * `createExtension`.
 *
 * @module services/extensions/extension-scaffold-approval
 */
import { ExtensionManifestSchema } from '@dorkos/extension-api';
import type { ApprovedPermissionSet } from '@dorkos/shared/config-schema';
import { trustPosture } from '@dorkos/shared/permissions';
import { configManager } from '../core/config-manager.js';
import { logConfigWrite } from '../core/operator/config-write.js';
import { approvedSourceOf } from './extension-load-policy.js';
import { declaredSet } from './isolation/permission-coverage.js';

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
 * @param id - The new extension's id.
 * @param scaffold - The folder and manifest the scaffolder just wrote.
 * @returns The approved permission set, or `null` when nothing was approved.
 */
export function approveNewScaffold(
  id: string,
  scaffold: { targetDir: string; manifest: object }
): ApprovedPermissionSet | null {
  if (trustPosture(configManager.get('permissions')?.preset) !== 'trusted') return null;
  const before = configManager.get('extensions');
  if (before.dismissedApprovals?.[id]) return null;
  const manifest = ExtensionManifestSchema.safeParse(scaffold.manifest);
  // A manifest the host cannot read would not run anyway; it waits like any other.
  if (!manifest.success) return null;
  const permissions = declaredSet(manifest.data);
  configManager.set('extensions', {
    ...before,
    approvedToRun: before.approvedToRun.includes(id)
      ? before.approvedToRun
      : [...before.approvedToRun, id],
    approvedSources: {
      ...(before.approvedSources ?? {}),
      [id]: approvedSourceOf({ id, origin: 'user', path: scaffold.targetDir }),
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

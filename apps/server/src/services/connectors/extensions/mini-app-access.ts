/**
 * What the owner's Connections page shows about mini apps reading connected
 * apps (DOR-3547): what each one waits for, and each yes it holds.
 *
 * Nothing here is stored. A declared app **waits** when the running copy has
 * no live approval for it, or the one it has no longer matches: its files or
 * its declared reads changed. The page only lists and revokes; a yes is given
 * on its own page, outside the app.
 *
 * @module services/connectors/extensions/mini-app-access
 */
import type { ExtensionRecord } from '@dorkos/extension-api';
import { connections, inArray, type Db, type ExtensionConnectionApprovalRow } from '@dorkos/db';
import type {
  MiniAppAccessAllowed,
  MiniAppAccessList,
  MiniAppAccessWaiting,
} from '@dorkos/shared/mini-app-access-schemas';
import {
  operationsDigestOf,
  type ExtensionConnectionApprovalStore,
} from './extension-connection-approvals.js';
import type { LiveExtensionInstall } from './live-extension-install.js';

/** What {@link MiniAppAccess} reads. */
export interface MiniAppAccessDeps {
  readonly db: Db;
  readonly approvals: Pick<
    ExtensionConnectionApprovalStore,
    'liveApproval' | 'liveApprovals' | 'revokeApproval'
  >;
  /** Every extension copy that runs here, one per id. */
  readonly extensions: () => readonly ExtensionRecord[];
  /** The broker's facts for a copy, or `undefined` when its folder can't be read. */
  readonly installOf: (record: ExtensionRecord) => LiveExtensionInstall | undefined;
}

/** Statuses of a copy a person turned on. */
const TURNED_ON = new Set<ExtensionRecord['status']>(['enabled', 'compiled', 'active']);

/** Lists and revokes mini apps' access to connected apps. */
export class MiniAppAccess {
  /**
   * Construct the view.
   *
   * @param deps - See {@link MiniAppAccessDeps}.
   */
  constructor(private readonly deps: MiniAppAccessDeps) {}

  /** What each turned-on mini app waits for, and every live yes. */
  list(): MiniAppAccessList {
    const records = this.deps.extensions();
    return { waiting: this.waiting(records), allowed: this.allowed(records) };
  }

  /**
   * Take one yes back, and its grants unless another live yes still covers
   * that account.
   *
   * @param approvalId - The approval.
   * @returns Whether a live approval was revoked.
   */
  revoke(approvalId: string): boolean {
    return this.deps.approvals.revokeApproval(approvalId) > 0;
  }

  /** Every declared app a turned-on, isolated copy may not read now. */
  private waiting(records: readonly ExtensionRecord[]): MiniAppAccessWaiting[] {
    const out: MiniAppAccessWaiting[] = [];
    for (const record of records) {
      const capabilities = record.manifest.serverCapabilities;
      const declarations = capabilities?.connections ?? [];
      if (declarations.length === 0 || !TURNED_ON.has(record.status)) continue;
      if (capabilities?.runtime !== 'subprocess') continue;
      const install = this.deps.installOf(record);
      if (!install || install.origin === null || install.liveFilesDigest === undefined) continue;
      for (const declaration of declarations) {
        const approval = this.deps.approvals.liveApproval(install, declaration.service);
        const reason = !approval
          ? 'new'
          : approval.approvedFilesDigest !== install.liveFilesDigest
            ? 'files_changed'
            : approval.approvedOperationsDigest !== operationsDigestOf(declaration.operations)
              ? 'operations_changed'
              : undefined;
        if (!reason) continue;
        out.push({
          extensionId: record.id,
          extensionName: record.manifest.name,
          service: declaration.service,
          operations: [...declaration.operations],
          reason,
        });
      }
    }
    return out;
  }

  /** Every live yes, with the account's name. */
  private allowed(records: readonly ExtensionRecord[]): MiniAppAccessAllowed[] {
    const rows = this.deps.approvals.liveApprovals();
    if (rows.length === 0) return [];
    const labels = this.labelsOf(rows);
    const names = new Map(records.map((record) => [record.id, record.manifest.name]));
    return rows.map((row) => ({
      approvalId: row.id,
      extensionId: row.extensionId,
      extensionName: names.get(row.extensionId) ?? row.extensionId,
      service: row.service,
      connectionId: row.connectionId,
      connectionLabel: labels.get(row.connectionId) ?? row.service,
      approvedAt: row.approvedAt,
    }));
  }

  /** The label of each account these approvals name. */
  private labelsOf(rows: readonly ExtensionConnectionApprovalRow[]): Map<string, string> {
    const ids = [...new Set(rows.map((row) => row.connectionId))];
    const found = this.deps.db
      .select({ id: connections.id, label: connections.label })
      .from(connections)
      .where(inArray(connections.id, ids))
      .all();
    return new Map(found.map((row) => [row.id, row.label]));
  }
}

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
import {
  and,
  connections,
  connectorProviderInstances,
  eq,
  inArray,
  ne,
  type Db,
  type ExtensionConnectionApprovalRow,
} from '@dorkos/db';
import type {
  MiniAppAccessAllowed,
  MiniAppAccessList,
  MiniAppAccessWaiting,
} from '@dorkos/shared/mini-app-access-schemas';
import { ExtensionConnectionError } from '@dorkos/extension-api/server';
import {
  operationsDigestOf,
  type ExtensionApprovalResult,
  type ExtensionConnectionApprovalStore,
} from './extension-connection-approvals.js';
import type { LiveExtensionInstall } from './live-extension-install.js';

/** What {@link MiniAppAccess} reads. */
export interface MiniAppAccessDeps {
  readonly db: Db;
  readonly approvals: Pick<
    ExtensionConnectionApprovalStore,
    'approve' | 'liveApproval' | 'liveApprovals' | 'revokeApproval'
  >;
  /** Every extension copy that runs here, one per id. */
  readonly extensions: () => readonly ExtensionRecord[];
  /** The broker's facts for a copy, or `undefined` when its folder can't be read. */
  readonly installOf: (record: ExtensionRecord) => LiveExtensionInstall | undefined;
}

/** One waiting read as the decide page shows it, read fresh from the server. */
export interface MiniAppAccessRequest {
  readonly waiting: MiniAppAccessWaiting;
  /** Who made the mini app, from its manifest. */
  readonly author?: string;
  /** Where its trusted copy came from, when DorkOS can prove it. */
  readonly source?: string;
  /** The files a yes would cover, so a later change refuses it. */
  readonly filesDigest: string;
  /** The person's accounts for the service a mini app may read (not DorkOS-account ones yet). */
  readonly accounts: readonly { connectionId: string; label: string }[];
}

/** One waiting read, with the copy and install it was worked out from. */
interface Waiting {
  readonly item: MiniAppAccessWaiting;
  readonly record: ExtensionRecord;
  readonly install: LiveExtensionInstall & { liveFilesDigest: string };
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
   * One waiting read, for the decide page, or `undefined` when nothing waits.
   *
   * @param extensionId - The mini app.
   * @param service - The app it reads.
   */
  describe(extensionId: string, service: string): MiniAppAccessRequest | undefined {
    const found = this.find(extensionId, service);
    if (!found) return undefined;
    const { item, record, install } = found;
    return {
      waiting: item,
      ...(record.manifest.author ? { author: record.manifest.author } : {}),
      ...(record.trustedOrigin ? { source: record.trustedOrigin.source } : {}),
      filesDigest: install.liveFilesDigest,
      accounts: this.accountsFor(service),
    };
  }

  /**
   * Record a person's yes from the decide page. Refused when nothing waits,
   * or the mini app's files are no longer the ones the page showed.
   *
   * @param input - The read, the account the person picked, the files the page
   *   showed, and who said yes.
   */
  approve(input: {
    extensionId: string;
    service: string;
    connectionId: string;
    filesDigest: string;
    approvedBy: string;
  }): ExtensionApprovalResult {
    const found = this.find(input.extensionId, input.service);
    if (!found) {
      throw new ExtensionConnectionError(
        'EXTENSION_CONNECTION_NOT_ALLOWED',
        'Nothing waits here now.'
      );
    }
    if (found.install.liveFilesDigest !== input.filesDigest) {
      throw new ExtensionConnectionError(
        'EXTENSION_CONNECTION_NOT_ALLOWED',
        'This mini app changed since the page opened. Open it again.'
      );
    }
    return this.deps.approvals.approve({
      install: found.install,
      service: input.service,
      connectionId: input.connectionId,
      approvedBy: input.approvedBy,
    });
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
    return this.waitingWith(records).map((entry) => entry.item);
  }

  /** The waiting read for this mini app and app, worked out fresh. */
  private find(extensionId: string, service: string): Waiting | undefined {
    const record = this.deps.extensions().find((candidate) => candidate.id === extensionId);
    if (!record) return undefined;
    return this.waitingWith([record]).find((entry) => entry.item.service === service);
  }

  /** Each waiting read, with the copy and install behind it. */
  private waitingWith(records: readonly ExtensionRecord[]): Waiting[] {
    const out: Waiting[] = [];
    for (const record of records) {
      const capabilities = record.manifest.serverCapabilities;
      const declarations = capabilities?.connections ?? [];
      if (declarations.length === 0 || !TURNED_ON.has(record.status)) continue;
      if (capabilities?.runtime !== 'subprocess') continue;
      const found = this.deps.installOf(record);
      if (!found || found.origin === null || found.liveFilesDigest === undefined) continue;
      const install = { ...found, liveFilesDigest: found.liveFilesDigest };
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
          record,
          install,
          item: {
            extensionId: record.id,
            extensionName: record.manifest.name,
            service: declaration.service,
            operations: [...declaration.operations],
            reason,
          },
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

  /** The person's connected, turned-on accounts for a service, not reached through DorkOS. */
  private accountsFor(service: string): { connectionId: string; label: string }[] {
    return this.deps.db
      .select({ connectionId: connections.id, label: connections.label })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connectorProviderInstances.id, connections.providerInstanceId)
      )
      .where(
        and(
          eq(connections.toolkit, service),
          eq(connections.lifecycleState, 'connected'),
          eq(connections.enabled, true),
          ne(connectorProviderInstances.mode, 'managed')
        )
      )
      .all();
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

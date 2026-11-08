/**
 * `ctx.connections` for one extension copy (DOR-3547): what the host gives an
 * isolated extension that declares connections, built from the copy it
 * started and never from anything the extension says.
 *
 * - {@link originOf} decides whether a copy may hold grants at all (Security
 *   Q7): one that ships with DorkOS, one with a provable trusted source, or
 *   one a person approved by its exact files. Path-trust, dev-link and
 *   agent-built copies may not.
 * - {@link installOf} builds the facts the broker checks on every call, with
 *   the real path from `fs.realpathSync.native` (P4-1).
 * - {@link settleApprovals} revokes the approvals a start no longer matches:
 *   another install, another origin, or the copy no longer isolated (N3).
 *
 * @module services/extensions/connections/extension-connections-ctx
 */
import fs from 'node:fs';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionConnectionsApi } from '@dorkos/extension-api/server';
import type { ExtensionApprovalOrigin } from '@dorkos/db';
import type { ExtensionsConfig } from '../extension-enable-resolution.js';
import { getExtensionConnectionServices } from '../../connectors/extensions/extension-connections-seam.js';
import type { LiveExtensionInstall } from '../../connectors/extensions/live-extension-install.js';
import { isApprovedByDigest, type ExtensionApprovals } from '../extension-load-policy.js';
import { logger } from '../../../lib/logger.js';
import { configManager } from '../../core/config-manager.js';

/** Why a copy's code may be trusted, or `null` when it may hold no grant. */
export interface CopyOrigin {
  readonly origin: ExtensionApprovalOrigin | null;
  readonly source?: string;
}

/**
 * Whether this copy may hold connection grants, and why (Security Q7).
 *
 * @param record - The extension copy.
 * @param approvals - `config.extensions`, or its approval fields.
 */
export function originOf(record: ExtensionRecord, approvals: ExtensionApprovals): CopyOrigin {
  if (record.devLink) return { origin: null };
  if (record.origin === 'core') return { origin: 'core' };
  if (record.trustedOrigin && !record.originProblem) {
    return { origin: 'trusted_source', source: record.trustedOrigin.source };
  }
  if (isApprovedByDigest(record, approvals) && byPerson(approvals.approvedSources?.[record.id])) {
    return { origin: 'digest_pinned' };
  }
  return { origin: null };
}

/**
 * Whether a person gave this digest yes: not `create_extension` on its own
 * (Security C1), and not DorkOS pinning an old path approval to whatever
 * files it found after an upgrade.
 *
 * @param source - The stored approval for the copy.
 */
function byPerson(
  source: { autoApprovedBy?: string; pinnedOnFirstUse?: string } | undefined
): boolean {
  return !!source && !source.autoApprovedBy && !source.pinnedOnFirstUse;
}

/**
 * The digest of the files this copy runs: the one it was judged against when
 * pinned, else its folder now. A core extension ships with DorkOS, so its
 * version stands for its files.
 *
 * @param record - The extension copy.
 */
function liveFilesDigestOf(record: ExtensionRecord): string | undefined {
  if (record.origin === 'core') return `core:${record.manifest.version}`;
  return record.pinnedDigest ?? record.currentDigest;
}

/**
 * The real path of a copy's folder, case and links resolved, or `undefined`
 * when it can't be read.
 *
 * @param folder - The copy's folder.
 */
function realPathOf(folder: string): string | undefined {
  try {
    return fs.realpathSync.native(folder);
  } catch {
    return undefined;
  }
}

/**
 * The facts the broker checks this copy against, or `undefined` when its
 * folder can't be resolved.
 *
 * @param record - The extension copy.
 * @param approvals - `config.extensions`.
 * @param isolated - Whether it runs isolated now with sqlite refused (S2).
 */
export function installOf(
  record: ExtensionRecord,
  approvals: ExtensionApprovals,
  isolated: () => boolean
): LiveExtensionInstall | undefined {
  const realPath = realPathOf(record.path);
  if (!realPath) return undefined;
  const { origin, source } = originOf(record, approvals);
  return {
    extensionId: record.id,
    scope: record.scope,
    realPath,
    origin,
    ...(source ? { originSource: source } : {}),
    liveFilesDigest: liveFilesDigestOf(record),
    version: record.manifest.version,
    declarations: record.manifest.serverCapabilities?.connections ?? [],
    isolated,
  };
}

/**
 * Revoke this extension's approvals a start no longer matches (Security N3): a
 * different install or origin, or a copy that no longer runs isolated. Its
 * grants go with them, in the same transaction. Never throws.
 *
 * @param record - The copy being started.
 * @param approvals - `config.extensions`.
 * @param isolatedRuntime - Whether this start runs the copy in its own process.
 */
export function settleApprovals(
  record: ExtensionRecord,
  approvals: ExtensionApprovals,
  isolatedRuntime: boolean
): void {
  const services = getExtensionConnectionServices();
  if (!services) return;
  try {
    const live = services.approvals.liveApprovalsOf(record.id);
    if (live.length === 0) return;
    const install = isolatedRuntime ? installOf(record, approvals, () => false) : undefined;
    for (const approval of live) {
      const matches =
        install !== undefined &&
        approval.installScope === install.scope &&
        approval.installRealPath === install.realPath &&
        approval.installOrigin === install.origin;
      if (!matches) services.approvals.revokeApproval(approval.id);
    }
  } catch (err) {
    logger.warn(`[Extensions] ${record.id}: could not settle its connection approvals`, { err });
  }
}

/**
 * `ctx.connections` as the host holds it: the extension's `read`, plus the
 * signal that cancels a read in flight when the extension is stopped (C2).
 */
export interface HostConnectionsApi {
  read(
    operation: string,
    params?: Record<string, unknown>,
    signal?: AbortSignal
  ): ReturnType<ExtensionConnectionsApi['read']>;
  status: ExtensionConnectionsApi['status'];
}

/** What an isolated start wires: the ctx member, and where to say which host runs it. */
export interface IsolatedConnections {
  /** `ctx.connections`, or `undefined` when the copy declares none. */
  readonly api: HostConnectionsApi | undefined;
  /** Name the host once it exists, so the broker can read its live self-check. */
  attach(host: { readonly sqliteRefused: boolean }): void;
}

/**
 * Settle this copy's approvals for an isolated start, then build its
 * `ctx.connections`, bound to the host that will run it.
 *
 * @param record - The copy being started.
 * @param config - Reads `config.extensions` now (the live config by default).
 */
export function isolatedConnectionsFor(
  record: ExtensionRecord,
  config: () => ExtensionsConfig = () => configManager.get('extensions')
): IsolatedConnections {
  settleApprovals(record, config(), true);
  let host: { readonly sqliteRefused: boolean } | undefined;
  return {
    api: extensionConnectionsFor(record, config, () => host?.sqliteRefused === true),
    attach: (started) => {
      host = started;
    },
  };
}

/**
 * The `ctx.connections` to give this copy, or `undefined` when it declares
 * none or the connection services aren't wired. Every call re-reads the
 * install, so a stopped child or a changed approval answers at once.
 *
 * @param record - The copy being started.
 * @param config - Reads `config.extensions` now.
 * @param isolated - Whether it runs isolated now with sqlite refused (S2).
 */
export function extensionConnectionsFor(
  record: ExtensionRecord,
  config: () => ExtensionsConfig,
  isolated: () => boolean
): HostConnectionsApi | undefined {
  const services = getExtensionConnectionServices();
  if (!services || !record.manifest.serverCapabilities?.connections?.length) return undefined;
  const install = (): LiveExtensionInstall => {
    const facts = installOf(record, config(), isolated);
    if (!facts) {
      return {
        extensionId: record.id,
        scope: record.scope,
        realPath: '/',
        origin: null,
        liveFilesDigest: undefined,
        version: record.manifest.version,
        declarations: [],
        isolated: () => false,
      };
    }
    return facts;
  };
  return {
    read: (operation, params, signal) => services.reader.read(install(), operation, params, signal),
    status: async () => services.reader.status(install()),
  };
}

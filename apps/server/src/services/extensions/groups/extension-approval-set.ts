/**
 * Allowing a plugin's extensions as one set (DOR-3583): the sets a person can
 * be asked about, and the one "Allow all" that answers a set.
 *
 * A group is the plugin that installed its members (`sourcePlugin`), never a
 * field an extension writes about itself. Location alone is not enough: a
 * member joins only when the plugin's installed-files record (written by the
 * installer at install, `.dork/installed-files.json`) lists its manifest and
 * the bytes on disk still match. A folder an agent or a person drops into an
 * installed plugin later is in no such record, so it never joins a set and
 * keeps its own card (Security, Nov 8, Must 1). The residual, named: the
 * record sits in the plugin's folder, so code that can rewrite the record
 * with matching hashes can still forge membership; it cannot forge the
 * per-member digest the person approves.
 *
 * Only first asks join. A member the person allowed before (its files or
 * permissions moved since) keeps its own card, which says what changed
 * (Security, Nov 8, M3).
 *
 * "Allow all" is N approvals, never one. Each member is approved with its own
 * digest and permission set, through the same `approveToRun` a single card
 * uses, so each writes its own pin and its own config-change record, and the
 * caller records each Activity entry the moment that member is allowed.
 * Nothing is stored about the group (Must 3).
 *
 * @module services/extensions/groups/extension-approval-set
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { ExtensionRecord, ExtensionRecordPublic } from '@dorkos/extension-api';
import {
  APPROVAL_SET_MAX_MEMBERS,
  NOT_IN_SET_CODE,
  STALE_SET_CODE,
  TOO_MANY_IN_SET_CODE,
  approvalSetHash,
  type ApprovalSetGrant,
  type ApprovalSetMember,
  type ApprovalSetMemberView,
  type ApprovalSetResult,
  type ApproveExtensionSetRequest,
  type ExtensionApprovalSet,
} from '@dorkos/shared/extension-approval-schemas';
import { configManager } from '../../core/config-manager.js';
import { logger } from '../../../lib/logger.js';
import type { ExtensionManager } from '../extension-manager.js';
import { isPendingApproval, permissionsOf, provenanceOf } from '../extension-approval-queue.js';
import { mayLoadClientHalf } from '../extension-load-policy.js';
import { declaredSet } from '../isolation/permission-coverage.js';
import { ApprovalRefusedError, liveDigestOf } from '../pin/extension-content-pin.js';
import {
  isProvenPackageFile,
  readInstalledFiles,
} from '../../marketplace/lib/records/installed-files.js';

/** A set needs at least this many first asks; one waiting member asks on its own card. */
const MIN_WAITING = 2;

/** The part of the extension manager a set reads and approves through. */
export type ApprovalSetSource = Pick<ExtensionManager, 'listRecords' | 'dorkHome'> & {
  approveToRun: (
    id: string,
    options: { expectedDigest?: string }
  ) => Promise<ExtensionRecordPublic | null>;
};

/** Hex SHA-256, the hash both sides of a set use. */
function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** One line on what it is for: its summary, else the first sentence of its description. */
function purposeOf(record: ExtensionRecord): string {
  const summary = record.manifest.summary?.trim();
  if (summary) return summary;
  const description = record.manifest.description?.trim() ?? '';
  const match = /^.*?[.!?](?=\s|$)/s.exec(description);
  return (match ? match[0] : description).replace(/\s+/g, ' ');
}

/**
 * Whether the plugin's installed-files record proves the installer put this
 * copy there: its manifest is listed, reached through real folders, with the
 * bytes the installer recorded.
 *
 * @param record - The extension record.
 */
async function isCarriedByInstall(record: ExtensionRecord): Promise<boolean> {
  const installRoot = path.resolve(record.path, '..', '..', '..');
  const installed = await readInstalledFiles(installRoot);
  if (!installed || installed.inferred) return false;
  const relDir = path.relative(installRoot, path.resolve(record.path));
  if (relDir.startsWith('..') || path.isAbsolute(relDir)) return false;
  const manifest = [...relDir.split(path.sep), 'extension.json'].join('/');
  return isProvenPackageFile(installRoot, manifest, installed);
}

/**
 * Whether this copy belongs to `plugin`'s set: carried by that plugin, not a
 * dev link, recorded by DorkOS's installer, and listed in what that install
 * put on disk.
 *
 * @param record - The extension record.
 * @param plugin - The plugin.
 * @param dorkHome - DorkOS's data directory.
 */
async function isInstalledBy(
  record: ExtensionRecord,
  plugin: string,
  dorkHome: string
): Promise<boolean> {
  if (record.origin !== 'user' || record.devLink || record.sourcePlugin !== plugin) return false;
  if ((await provenanceOf(record, dorkHome)).kind !== 'installer') return false;
  return isCarriedByInstall(record);
}

/**
 * Whether the person allowed this id before: a waiting copy of it is a
 * re-ask, which its own card explains.
 *
 * @param id - The extension id.
 * @param extensions - `config.extensions`.
 */
function wasAllowedBefore(
  id: string,
  extensions: { approvedToRun?: string[]; approvedSources?: Record<string, unknown> }
): boolean {
  return (
    (extensions.approvedToRun ?? []).includes(id) || extensions.approvedSources?.[id] !== undefined
  );
}

/**
 * The waiting members' combined grant: the card's total, from the same
 * members the hash binds.
 *
 * @param waiting - The members "Allow all" would approve.
 */
function combinedGrant(waiting: readonly WaitingMember[]): ApprovalSetGrant {
  const fullAccess: string[] = [];
  const programs = new Set<string>();
  const tools = new Set<string>();
  const hosts = new Set<string>();
  for (const { record, echo } of waiting) {
    const runsServer = record.hasServerEntry || record.hasDataProxy;
    if (echo.permissions.runtime === 'in-process' && runsServer)
      fullAccess.push(record.manifest.name);
    for (const program of echo.permissions.run) programs.add(program);
    for (const host of echo.permissions.net) hosts.add(host);
    for (const check of record.toolChecks ?? []) if (check.ok) tools.add(check.title || check.name);
  }
  const sorted = (values: Set<string>) => [...values].sort((a, b) => a.localeCompare(b));
  return {
    fullAccess,
    programs: sorted(programs),
    agentTools: sorted(tools),
    network: { anything: fullAccess.length > 0, hosts: sorted(hosts) },
  };
}

/** A member the set would approve, with what it was checked against. */
interface WaitingMember {
  record: ExtensionRecord;
  echo: ApprovalSetMember;
}

/**
 * One plugin's members, read from DorkOS's own records: who waits (with the
 * digest read from disk now), who is already allowed, and who can't be
 * approved and why.
 *
 * @param source - The extension manager.
 * @param plugin - The plugin.
 */
async function readSet(
  source: ApprovalSetSource,
  plugin: string
): Promise<{ waiting: WaitingMember[]; views: ApprovalSetMemberView[] }> {
  const extensions = configManager.get('extensions');
  const waiting: WaitingMember[] = [];
  const views: ApprovalSetMemberView[] = [];
  const members = source
    .listRecords()
    .filter((record) => record.sourcePlugin === plugin)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  for (const record of members) {
    if (!(await isInstalledBy(record, plugin, source.dorkHome))) continue;
    const permissions = await permissionsOf(record);
    const view = {
      id: record.id,
      name: record.manifest.name,
      purpose: purposeOf(record),
      version: record.manifest.version,
      runsInServer: record.hasServerEntry || record.hasDataProxy,
      reachesInternet:
        permissions.runtime === 'subprocess'
          ? permissions.net.length > 0
          : record.hasServerEntry || record.hasDataProxy,
      permissions,
    };
    if (record.status === 'invalid') {
      views.push({ ...view, state: 'skipped', reason: 'DorkOS can’t read its manifest.' });
      continue;
    }
    if (mayLoadClientHalf(record, extensions)) {
      views.push({ ...view, state: 'allowed' });
      continue;
    }
    if (!isPendingApproval(record, extensions)) continue;
    // A re-ask keeps its own card, which says what changed.
    if (wasAllowedBefore(record.id, extensions)) continue;
    const digest = await liveDigestOf(record);
    if (!digest) {
      views.push({ ...view, state: 'skipped', reason: 'DorkOS can’t read its folder.' });
      continue;
    }
    const echo = {
      id: record.id,
      version: record.manifest.version,
      expectedDigest: digest,
      permissions: declaredSet(record.manifest),
    };
    waiting.push({ record, echo });
    views.push({ ...view, state: 'waiting', echo });
  }
  return { waiting, views };
}

/**
 * Every plugin with two or more first asks waiting, as the card asks about
 * it. One waiting member asks through its own card.
 *
 * @param source - The extension manager.
 */
export async function listApprovalSets(source: ApprovalSetSource): Promise<ExtensionApprovalSet[]> {
  const plugins = [
    ...new Set(source.listRecords().flatMap((record) => record.sourcePlugin ?? [])),
  ].sort();
  const sets: ExtensionApprovalSet[] = [];
  for (const plugin of plugins) {
    const { waiting, views } = await readSet(source, plugin);
    if (waiting.length < MIN_WAITING) continue;
    sets.push({
      plugin,
      members: views,
      grant: combinedGrant(waiting),
      setHash: await approvalSetHash(
        waiting.map((member) => member.echo),
        sha256
      ),
      tooMany: waiting.length > APPROVAL_SET_MAX_MEMBERS,
    });
  }
  return sets;
}

/** Why a set was refused before anything was written. */
export interface ApprovalSetRefusal {
  ok: false;
  code: typeof STALE_SET_CODE | typeof NOT_IN_SET_CODE | typeof TOO_MANY_IN_SET_CODE;
  error: string;
}

/** What "Allow all" did: one result per member, in the order they were approved. */
export interface ApprovalSetOutcome {
  ok: true;
  results: ApprovalSetResult[];
  /** Every member was allowed. */
  allAllowed: boolean;
}

/**
 * Whether two echoes name the same copy and files. Permission sets are bound
 * by the set's hash alone, so there is one place that decides them (Must 2).
 */
function sameCopy(a: ApprovalSetMember, b: ApprovalSetMember): boolean {
  return a.id === b.id && a.version === b.version && a.expectedDigest === b.expectedDigest;
}

const STALE: ApprovalSetRefusal = {
  ok: false,
  code: STALE_SET_CODE,
  error: 'These extensions changed since you saw them. Nothing was turned on.',
};

/**
 * Allow every waiting member of one plugin's set, each with its own digest.
 *
 * Checks everything, then writes (Must 3): the set is derived from DorkOS's
 * own records and must match the request exactly (Must 1), and the hash over
 * every member's id, version, digest and permission set must match the one
 * the card was drawn with (Must 2). Only then does the first approval run.
 * A member that still fails at its own approval, for any reason, is reported
 * and the loop goes on: the answer always says exactly which ones are now
 * allowed (Security, Nov 8, M2).
 *
 * @param source - The extension manager.
 * @param request - The plugin, the members the card showed, and their hash.
 * @param onAllowed - Called right after each member is allowed, before the
 *   next one starts, so its Activity entry exists even if the loop is cut short.
 */
export async function approveExtensionSet(
  source: ApprovalSetSource,
  request: ApproveExtensionSetRequest,
  onAllowed: (result: ApprovalSetResult) => Promise<void> = async () => {}
): Promise<ApprovalSetRefusal | ApprovalSetOutcome> {
  const records = new Map(source.listRecords().map((record) => [record.id, record]));
  for (const member of request.members) {
    const record = records.get(member.id);
    if (
      !record ||
      record.sourcePlugin !== request.plugin ||
      !(await isInstalledBy(record, request.plugin, source.dorkHome))
    ) {
      return {
        ok: false,
        code: NOT_IN_SET_CODE,
        error: `${member.id} wasn’t installed by ${request.plugin}. Nothing was turned on.`,
      };
    }
  }

  const { waiting } = await readSet(source, request.plugin);
  if (waiting.length < MIN_WAITING) return STALE;
  if (waiting.length > APPROVAL_SET_MAX_MEMBERS) {
    return {
      ok: false,
      code: TOO_MANY_IN_SET_CODE,
      error: `More than ${APPROVAL_SET_MAX_MEMBERS} are waiting. Allow them one at a time.`,
    };
  }
  const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
  const live = waiting.map((member) => member.echo).sort(byId);
  const shown = [...request.members].sort(byId);
  if (live.length !== shown.length || live.some((echo, i) => !sameCopy(echo, shown[i]!))) {
    return STALE;
  }
  if ((await approvalSetHash(live, sha256)) !== request.setHash) return STALE;

  const results: ApprovalSetResult[] = [];
  for (const { record, echo } of waiting) {
    const name = record.manifest.name;
    try {
      const approved = await source.approveToRun(record.id, {
        expectedDigest: echo.expectedDigest,
      });
      if (!approved) {
        results.push({ id: record.id, name, ok: false, reason: 'It’s no longer installed.' });
        continue;
      }
      const result = { id: record.id, name, ok: true };
      results.push(result);
      // It is allowed whatever happens next; a failed record of it must not
      // turn this member's answer into a refusal.
      await onAllowed(result).catch((err: unknown) =>
        logger.warn(`[Extensions] Couldn’t record that ${record.id} was allowed`, err)
      );
    } catch (err) {
      results.push({
        id: record.id,
        name,
        ok: false,
        reason: err instanceof ApprovalRefusedError ? err.message : 'DorkOS couldn’t turn it on.',
      });
    }
  }
  return { ok: true, results, allAllowed: results.every((result) => result.ok) };
}

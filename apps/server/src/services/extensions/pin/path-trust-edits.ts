/**
 * Path trust follows the level of the agent that owns the copy (DOR-3440, Security's Must).
 *
 * A copy that keeps path trust (`extension-path-trust.ts`) has no digest in its approval, so an edit
 * keeps running with no card. Each scan reads the owning agent's current level:
 *
 * - **At Full**, an edit runs, and one Activity line says so.
 * - **Below Full**, or when the level cannot be read, the approval is pinned to the files last seen,
 *   so an edit made since, and any later one, waits for a person. A pinned copy runs from a verified
 *   snapshot of those files (`placeSnapshots`), never from its live folder.
 *
 * Raising the agent back runs nothing: a held edit stays held until a person approves it, or the
 * agent makes a new edit at Full, which lifts the pin, runs and logs. The last-seen digests are kept
 * on disk, so the first scan after a restart still sees an edit made while the server was down.
 *
 * @module services/extensions/pin/path-trust-edits
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ExtensionRecord } from '@dorkos/extension-api';
import type { ExtensionApprovedSource } from '@dorkos/shared/config-schema';
import { levelOfMode } from '@dorkos/shared/permission-semantics';
import { configManager } from '../../core/config-manager.js';
import { logConfigWrite } from '../../core/operator/config-write.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { recordFullAction, isFullLevel } from '../../core/turn-power/full-autonomy.js';
import { resolveAgentLaunchLevel } from '../../session/resolution/agent-launch-level.js';
import { readAgentExecutionDefaults } from '../../session/resolution/resolve-session-defaults.js';
import { logger } from '../../../lib/logger.js';
import { keepsPathTrust } from './extension-path-trust.js';

/** What a scan needs from the rest of the server (tests pass their own). */
export interface PathTrustEditDeps {
  /** Whether the agent at this folder is at Full autonomy now. A failure counts as no. */
  agentAtFull: (agentPath: string) => Promise<boolean>;
  /** Pin one copy's approval to these files. */
  pin: (id: string, digest: string) => void;
  /** Take the pin off one copy's approval. */
  unpin: (id: string) => void;
}

/**
 * Whether the agent at this folder is at Full, on the runtime it runs on. An agent that names no
 * runtime runs on the server's default; a runtime that is not here, or a level it cannot say, is no.
 *
 * @param agentPath - The agent's folder.
 * @throws {Error} When no runtime is registered yet, so nothing can say the level.
 */
export async function agentAtFullNow(agentPath: string): Promise<boolean> {
  const { runtime } = await readAgentExecutionDefaults(agentPath);
  const all = runtimeRegistry.getAllCapabilities();
  if (Object.keys(all).length === 0) throw new Error('no runtime is registered yet');
  const capabilities = all[runtime ?? runtimeRegistry.getDefaultType()];
  if (!capabilities) return false;
  const { mode } = await resolveAgentLaunchLevel({ agentPath, capabilities });
  return isFullLevel(levelOfMode(capabilities.permissionModes, mode));
}

/** Write one approval back, spreading what is there. */
function writeSource(
  id: string,
  edit: (source: ExtensionApprovedSource) => ExtensionApprovedSource
): void {
  const before = configManager.get('extensions');
  const source = before.approvedSources?.[id];
  if (!source) return;
  configManager.set('extensions', {
    ...before,
    approvedSources: { ...before.approvedSources, [id]: edit(source) },
  });
  logConfigWrite(
    'an extension following its agent',
    'extensions',
    before,
    configManager.get('extensions')
  );
}

const LIVE: PathTrustEditDeps = {
  agentAtFull: agentAtFullNow,
  pin: (id, digest) => writeSource(id, (source) => ({ ...source, digest })),
  unpin: (id) => writeSource(id, ({ digest: _pinned, ...source }) => source),
};

/** The file the last-seen digests are kept in. */
const seenFile = (dorkHome: string) =>
  path.join(dorkHome, 'extension-data', 'path-trust-seen.json');

/** The digests the last scan saw; unreadable reads as none. */
async function readSeen(dorkHome: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(seenFile(dorkHome), 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/**
 * Apply the rule to every path-trust copy a scan found. The first sight of a copy only records.
 * Never throws: a failure leaves the copy as it was for the next scan.
 *
 * @param records - The copies this scan found.
 * @param approvals - `config.extensions`, or the approval fields of it.
 * @param dorkHome - The DorkOS data directory.
 * @param deps - Where the level is read and the pin written.
 */
export async function notePathTrustEdits(
  records: readonly ExtensionRecord[],
  approvals: { approvedSources?: Record<string, ExtensionApprovedSource> } | undefined,
  dorkHome: string,
  deps: PathTrustEditDeps = LIVE
): Promise<void> {
  try {
    const seen = await readSeen(dorkHome);
    let changed = false;
    for (const record of records) {
      const source = approvals?.approvedSources?.[record.id];
      const digest = record.currentDigest;
      if (!source || !digest || !source.authorHome) continue;
      if (!keepsPathTrust(record, source)) continue;
      const before = seen[record.id];
      const edited = before !== undefined && before !== digest;
      const atFull = await deps.agentAtFull(source.authorHome).catch(() => undefined);
      if (atFull === undefined) {
        // Hold it, and keep the last-seen files, so the next scan that can read the level still
        // sees an edit made since: the first scan at boot runs before the runtimes are registered.
        if (!source.digest) deps.pin(record.id, before ?? digest);
        continue;
      }
      if (before !== digest) {
        seen[record.id] = digest;
        changed = true;
      }
      if (!atFull) {
        // The files last seen, so an edit made since this scan's lowering does not run.
        if (!source.digest) deps.pin(record.id, before ?? digest);
        continue;
      }
      // Pinned and back at Full: a raise alone runs nothing. Only an edit made now does.
      if (source.digest) {
        if (!edited || digest === source.digest) continue;
        deps.unpin(record.id);
      }
      if (edited) {
        recordFullAction({
          actionId: 'extension.edit',
          did: `edited the extension ${record.id}, and its server code runs as edited`,
          limit: 'an edit to an extension waits for a person',
          agentPath: source.authorHome,
        });
      }
    }
    if (changed) {
      await fs.mkdir(path.dirname(seenFile(dorkHome)), { recursive: true });
      await fs.writeFile(seenFile(dorkHome), JSON.stringify(seen));
    }
  } catch (err) {
    logger.warn('[Extensions] could not check path-trust copies', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

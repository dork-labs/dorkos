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
 * At Full, an edit runs only when every file it changed can be traced, by content, to the
 * author's own turn that held no mark and ran under no ceiling (`path-trust-writers.ts`,
 * DOR-4528). The files it is traced from are the ones last TRUSTED: first seen, last run after
 * such an edit, or last approved by a person. They never move while the agent is below Full, so a
 * change made then is traced too. Both sides are read from verified snapshots, never the live
 * folder. An edit that cannot be traced (a marked turn's, a shell's, one made while the server
 * was down) is pinned to the trusted files, and stays held until a person approves it: a later
 * edit by the author does not lift that pin.
 *
 * @module services/extensions/pin/path-trust-edits
 */
import { randomUUID } from 'node:crypto';
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
import { verifiedFilesOf } from './extension-content-pin.js';
import { keepsPathTrust } from './extension-path-trust.js';
import { markTrusted, tiedToAuthor, type AuthorCheck } from './path-trust-writers.js';

/** What a scan needs from the rest of the server (tests pass their own). */
export interface PathTrustEditDeps {
  /** Whether the agent at this folder is at Full autonomy now. A failure counts as no. */
  agentAtFull: (agentPath: string) => Promise<boolean>;
  /** Pin one copy's approval to these files. */
  pin: (id: string, digest: string) => void;
  /** Take the pin off one copy's approval. */
  unpin: (id: string) => void;
  /**
   * The content of the files a digest names, by relative path, or null when they cannot be read.
   * Defaults to a verified snapshot of them (`verifiedFilesOf`).
   */
  filesOf?: (record: ExtensionRecord, digest: string) => Promise<Record<string, string> | null>;
  /** Whether a change is the author's own unheld work. Defaults to the server's write record. */
  tiedToAuthor?: (check: AuthorCheck) => boolean;
  /** Note a copy's files trusted as of now. Defaults to the server's write record. */
  markTrusted?: (id: string) => void;
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

/**
 * The file the last-seen digests and trusted files are kept in. No agent may write it
 * (`PERSON_ONLY_DATA_PATHS`), and it is replaced whole through a temp file beside it.
 */
const seenFile = (dorkHome: string) =>
  path.join(dorkHome, 'extension-data', 'path-trust-seen.json');

/** A pin no files match: a copy held to it runs nothing until a person approves. */
const MATCHES_NOTHING = `sha256:${'0'.repeat(64)}`;

/** The files a copy may run as without a person: their digest and each file's content. */
interface TrustedFiles {
  digest: string;
  files: Record<string, string>;
}

/**
 * What the last scan saw: each copy's digest, the copies whose agent was below Full, the copies
 * whose edit could not be traced to their author, and each copy's trusted files. `distrustNew`
 * once the file was ever found there but unreadable: what it held is gone, so a copy it does not
 * name is never taken on first sight again, and waits for a person instead.
 */
interface SeenState {
  digests: Record<string, string>;
  below: string[];
  untied: string[];
  trusted: Record<string, TrustedFiles>;
  distrustNew?: true;
}

/** Whether a value is a plain object. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the last scan saw: nothing when the file is not there, `distrustNew` when it is but fails. */
async function readSeen(dorkHome: string): Promise<SeenState> {
  const empty = (): SeenState => ({ digests: {}, below: [], untied: [], trusted: {} });
  let text: string;
  try {
    text = await fs.readFile(seenFile(dorkHome), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return empty();
    return { ...empty(), distrustNew: true };
  }
  try {
    const parsed = JSON.parse(text) as Partial<SeenState>;
    if (!isRecord(parsed)) throw new Error('not an object');
    const state: SeenState = {
      digests: parsed.digests ?? {},
      below: parsed.below ?? [],
      untied: parsed.untied ?? [],
      trusted: parsed.trusted ?? {},
      ...(parsed.distrustNew === true ? { distrustNew: true as const } : {}),
    };
    if (!isRecord(state.digests) || !isRecord(state.trusted)) throw new Error('bad shape');
    if (!Array.isArray(state.below) || !Array.isArray(state.untied)) throw new Error('bad shape');
    return state;
  } catch {
    return { ...empty(), distrustNew: true };
  }
}

/** Replace the file whole, so a crash mid-write leaves the old one, never half of a new one. */
async function writeSeen(dorkHome: string, state: SeenState): Promise<void> {
  const file = seenFile(dorkHome);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const { digests, below, untied, trusted, distrustNew } = state;
  await fs.writeFile(temp, JSON.stringify({ digests, below, untied, trusted, distrustNew }));
  await fs.rename(temp, file);
}

/** The last read or write of the file queued, so two never interleave. */
let queue: Promise<unknown> = Promise.resolve();

/** Run `work` after every earlier read or write of the file has finished. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Record a person's yes to a path-trust copy's files as they were shown (`approveToRun`): those
 * files are trusted now, and a hold on the copy is lifted. Files that changed since the yes, or
 * cannot be read, are not trusted, so the copy stays held. Never throws.
 *
 * @param dorkHome - The DorkOS data directory.
 * @param record - The approved copy.
 * @param digest - The digest of the files the person approved.
 * @param filesOf - Reads the files a digest names (tests pass their own).
 */
export function notePersonApproval(
  dorkHome: string,
  record: ExtensionRecord,
  digest: string,
  filesOf: NonNullable<PathTrustEditDeps['filesOf']> = (r, d) => verifiedFilesOf(dorkHome, r, d)
): Promise<void> {
  return oneAtATime(async () => {
    try {
      const state = await readSeen(dorkHome);
      const files = await filesOf(record, digest);
      if (!files) return;
      state.trusted[record.id] = { digest, files };
      state.digests[record.id] = digest;
      state.untied = state.untied.filter((id) => id !== record.id);
      markTrusted(record.id);
      await writeSeen(dorkHome, state);
    } catch (err) {
      logger.warn('[Extensions] could not record an approval of a path-trust copy', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });
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
export function notePathTrustEdits(
  records: readonly ExtensionRecord[],
  approvals: { approvedSources?: Record<string, ExtensionApprovedSource> } | undefined,
  dorkHome: string,
  deps: PathTrustEditDeps = LIVE
): Promise<void> {
  return oneAtATime(() => scan(records, approvals, dorkHome, deps));
}

/** One scan, run by {@link notePathTrustEdits} after any other read or write of the file. */
async function scan(
  records: readonly ExtensionRecord[],
  approvals: { approvedSources?: Record<string, ExtensionApprovedSource> } | undefined,
  dorkHome: string,
  deps: PathTrustEditDeps
): Promise<void> {
  try {
    const state = await readSeen(dorkHome);
    const seen = state.digests;
    const below = new Set(state.below);
    const untied = new Set(state.untied);
    const trusted = state.trusted;
    const filesOf = deps.filesOf ?? ((r, d) => verifiedFilesOf(dorkHome, r, d));
    const tied = deps.tiedToAuthor ?? tiedToAuthor;
    const noteTrusted = deps.markTrusted ?? markTrusted;
    let changed = false;
    /** Trust a copy's files as they are now. Unreadable files are not trusted. */
    const trust = async (record: ExtensionRecord, digest: string): Promise<void> => {
      const files = await filesOf(record, digest);
      if (!files) return;
      trusted[record.id] = { digest, files };
      noteTrusted(record.id);
      changed = true;
    };
    for (const record of records) {
      const source = approvals?.approvedSources?.[record.id];
      const digest = record.currentDigest;
      if (!source || !digest || !source.authorHome) continue;
      if (!keepsPathTrust(record, source)) continue;
      const before = seen[record.id];
      if (before === undefined && state.distrustNew) {
        // What the file held is gone: a copy it does not name waits for a person.
        if (!source.digest) deps.pin(record.id, MATCHES_NOTHING);
        untied.add(record.id);
        seen[record.id] = digest;
        changed = true;
        continue;
      }
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
      // First sight, or a copy seen before trusted files were kept: unchanged, not held, and
      // running freely or pinned to exactly the files last seen (the boot scan pins first).
      const settled =
        !edited &&
        !untied.has(record.id) &&
        !below.has(record.id) &&
        (!source.digest || source.digest === before);
      if (!trusted[record.id] && (before === undefined || settled)) await trust(record, digest);
      if (!atFull) {
        if (!below.has(record.id)) {
          below.add(record.id);
          changed = true;
        }
        // The files last seen, so an edit made since this scan's lowering does not run.
        if (!source.digest) deps.pin(record.id, before ?? digest);
        continue;
      }
      // The scan that finds the agent raised: whatever changed was made while it was below Full.
      const raisedNow = below.delete(record.id);
      if (raisedNow) changed = true;
      // Held until a person approves (`notePersonApproval` lifts it).
      const held = untied.has(record.id);
      if (held && source.digest) continue;
      // Pinned and back at Full: a raise alone runs nothing. Only an edit made now does.
      if (source.digest && (raisedNow || !edited || digest === source.digest)) continue;
      // A held copy found unpinned without a person's recorded yes is traced like an edit.
      if (!edited && !held) continue;
      const base = trusted[record.id];
      const next = base && base.digest !== digest ? await filesOf(record, digest) : null;
      const traced =
        !!base &&
        (base.digest === digest ||
          (!!next &&
            tied({
              id: record.id,
              folder: record.realPath!,
              authorHome: source.authorHome,
              trusted: base.files,
              next,
            })));
      if (!traced) {
        // Not traced to the author's own unheld turn: the trusted files stay.
        if (!source.digest) deps.pin(record.id, base?.digest ?? before ?? digest);
        untied.add(record.id);
        changed = true;
        continue;
      }
      if (held) {
        untied.delete(record.id);
        changed = true;
      }
      if (next) {
        trusted[record.id] = { digest, files: next };
        noteTrusted(record.id);
        changed = true;
      }
      if (source.digest) deps.unpin(record.id);
      if (!edited) continue;
      recordFullAction({
        actionId: 'extension.edit',
        did: `edited the extension ${record.id}, and its server code runs as edited`,
        limit: 'an edit to an extension waits for a person',
        agentPath: source.authorHome,
      });
    }
    if (changed) {
      await writeSeen(dorkHome, {
        ...state,
        digests: seen,
        below: [...below],
        untied: [...untied],
        trusted,
      });
    }
  } catch (err) {
    logger.warn('[Extensions] could not check path-trust copies', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

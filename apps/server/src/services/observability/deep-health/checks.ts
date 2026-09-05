/**
 * The pure checks behind `GET /api/health/deep`.
 *
 * Each one takes already-gathered facts and returns a {@link CheckResult}. They
 * read nothing, log nothing, and throw nothing, which is what makes them
 * testable against a fabricated broken machine as easily as a healthy one.
 * Gathering the facts is `collect.ts`'s job.
 *
 * Every result here is **content-free**: counts and plain sentences only. No
 * message text, no session id, no absolute path, no adapter id — the deep
 * health endpoint is reachable by anything that can reach the server.
 *
 * @module services/observability/deep-health/checks
 */
import type { CheckResult } from '@dorkos/shared/health-schemas';
import type { RoomSessionBinding } from '../../rooms/session-bindings/room-session-ledger.js';

/** Facts needed to judge whether room members still have a conversation to continue. */
export interface RoomSessionTranscriptInput {
  /** How many bindings the transcript probe reached a verdict on. */
  judgedCount: number;
  /** The judged bindings whose conversation is not where a resume would look for it. */
  orphaned: readonly RoomSessionBinding[];
  /**
   * Bindings nothing could be learned about — the transcript or the runtime
   * could not be read.
   *
   * Counted rather than ignored: a broken probe that silently judged nothing
   * would report a confident "0 room members checked — all good", which is the
   * shape of a check that cannot fail.
   */
  unreadableCount?: number;
}

/**
 * Room members whose saved conversation no longer exists on disk.
 *
 * This is the fingerprint of silent amnesia: the room still remembers which
 * session an agent speaks through, but that session's transcript is gone, so
 * every reply starts from nothing while the room looks perfectly normal.
 *
 * @param input - How many bindings were judged, which of them have lost their
 *   conversation, and how many could not be judged at all.
 * @returns A `pass` when every binding has a transcript, a `warn` carrying how
 *   many do not, and `info` when nothing could be judged.
 */
export function checkRoomSessionTranscripts(input: RoomSessionTranscriptInput): CheckResult {
  const unreadable = input.unreadableCount ?? 0;
  if (input.judgedCount === 0 && unreadable > 0) {
    return {
      label: 'Could not check whether rooms remember their conversations',
      status: 'info',
      detail: `DorkOS could not read the saved conversation for ${unreadable} room ${plural(unreadable, 'member', 'members')}, so none could be checked.`,
    };
  }
  const orphaned = input.orphaned;
  if (orphaned.length === 0) {
    return {
      label: 'Rooms remember their conversations',
      status: 'pass',
      detail:
        `${input.judgedCount} ${plural(input.judgedCount, 'room member', 'room members')} checked` +
        (unreadable > 0 ? `; ${unreadable} could not be read and were left out` : ''),
    };
  }
  const roomCount = new Set(orphaned.map((b) => b.roomId)).size;
  return {
    label: `${orphaned.length} room ${plural(orphaned.length, 'member has', 'members have')} lost their conversation`,
    status: 'warn',
    detail:
      `Across ${roomCount} ${plural(roomCount, 'room', 'rooms')}, DorkOS is pointing at a saved ` +
      'conversation that is no longer on disk. Those agents will answer as if the room just started.',
    fix: 'Remove and re-add the affected member, or start a fresh session in that room.',
  };
}

/** Facts needed to judge the relay's access rules. */
export interface RelayAccessRulesInput {
  /** Whether the rules file exists but could not be read as a rule list. */
  quarantined: boolean;
  /** How many rules are currently loaded. */
  ruleCount: number;
}

/**
 * Whether the relay's access rules loaded.
 *
 * When the rules file exists but cannot be read, the relay holds no rules at
 * all and denies every message. Nothing gets through and nothing says why, so
 * this is a `fail`.
 *
 * @param input - Quarantine state and the loaded rule count.
 * @returns A `fail` while quarantined, otherwise a `pass`.
 */
export function checkRelayAccessRules(input: RelayAccessRulesInput): CheckResult {
  if (input.quarantined) {
    return {
      label: 'Agent messaging rules could not be read',
      status: 'fail',
      detail:
        'While the rules file is unreadable, every message between agents is blocked. ' +
        'DorkOS has left the file exactly as it is.',
      fix: 'Fix or delete `relay/access-rules.json` in your DorkOS data folder, then restart.',
    };
  }
  return {
    label: 'Agent messaging rules loaded',
    status: 'pass',
    detail: `${input.ruleCount} ${plural(input.ruleCount, 'rule', 'rules')} in effect`,
  };
}

/** Facts needed to judge the saved chat integrations. */
export interface AdapterEntriesInput {
  /** How many saved integrations DorkOS could not read. */
  unparsedCount: number;
}

/**
 * Saved chat integrations whose settings could not be read.
 *
 * An unreadable entry does not start, and — because nothing about it could be
 * understood — it is kept on disk byte for byte. If it holds a bot token, that
 * token stays in the file in plain text instead of moving into the encrypted
 * store, which is the part worth saying out loud.
 *
 * @param input - The count of unreadable entries.
 * @returns A `pass` when everything read, otherwise a `warn`.
 */
export function checkAdapterEntries(input: AdapterEntriesInput): CheckResult {
  if (input.unparsedCount === 0) {
    return { label: 'Chat integrations are readable', status: 'pass' };
  }
  return {
    label: `${input.unparsedCount} chat ${plural(input.unparsedCount, 'integration', 'integrations')} could not be read`,
    status: 'warn',
    detail:
      'They are not running, and they were left on disk untouched so nothing is lost. ' +
      'If one holds a bot token, that token is still sitting in the file in plain text.',
    fix: 'Fix the integration in Settings (it is encrypted on the next save), or delete it.',
  };
}

/** One agent manifest as found on disk. */
export interface AgentManifestLocation {
  /** The id the manifest claims. */
  id: string;
  /** The folder the manifest was read from. */
  directory: string;
}

/** Facts needed to judge agent id uniqueness. */
export interface DuplicateAgentIdInput {
  manifests: readonly AgentManifestLocation[];
}

/**
 * Agent ids claimed by more than one folder.
 *
 * Ids are the key everything else uses — messages, bindings, task ownership.
 * When two folders claim one id (almost always because a project was copied),
 * only one of them is ever reachable and the other is silently invisible.
 *
 * @param input - Every manifest found, with the folder it came from.
 * @returns A `pass` when every id is unique, otherwise a `warn`.
 */
export function checkDuplicateAgentIds(input: DuplicateAgentIdInput): CheckResult {
  const byId = new Map<string, Set<string>>();
  for (const manifest of input.manifests) {
    const dirs = byId.get(manifest.id) ?? new Set<string>();
    dirs.add(manifest.directory);
    byId.set(manifest.id, dirs);
  }
  const duplicates = [...byId.values()].filter((dirs) => dirs.size > 1);
  if (duplicates.length === 0) {
    return {
      label: 'Agent ids are unique',
      status: 'pass',
      detail: `${byId.size} ${plural(byId.size, 'agent', 'agents')} checked`,
    };
  }
  return {
    label: `${duplicates.length} agent ${plural(duplicates.length, 'id is', 'ids are')} used by more than one folder`,
    status: 'warn',
    detail:
      'Only one folder per id is reachable, so the others are invisible to messaging and tasks. ' +
      'This usually means a project folder was copied along with its agent settings.',
    fix: 'Give the copy its own id in its `.dork/agent.json`, or delete the copy.',
  };
}

/** One relay binding: an agent reachable through a chat integration. */
export interface RelayBinding {
  adapterId: string;
  agentId: string;
}

/** Facts needed to judge whether relay bindings still point at anything. */
export interface RelayBindingGhostInput {
  bindings: readonly RelayBinding[];
  /** Ids of every chat integration that exists. */
  knownAdapterIds: ReadonlySet<string>;
  /** Ids of every agent registered in the mesh. */
  registeredAgentIds: ReadonlySet<string>;
}

/**
 * Relay bindings pointing at an integration or an agent that is gone.
 *
 * A ghost binding looks live in the cockpit and does nothing in practice:
 * messages arrive at a chat connection whose other end no longer exists.
 *
 * @param input - The bindings plus the ids that currently exist.
 * @returns A `pass` when every binding resolves, otherwise a `warn`.
 */
export function checkRelayBindingGhosts(input: RelayBindingGhostInput): CheckResult {
  const missingAdapter = input.bindings.filter((b) => !input.knownAdapterIds.has(b.adapterId));
  const missingAgent = input.bindings.filter((b) => !input.registeredAgentIds.has(b.agentId));
  const total = new Set([...missingAdapter, ...missingAgent]).size;

  if (total === 0) {
    return {
      label: 'Chat connections point at real agents',
      status: 'pass',
      detail: `${input.bindings.length} ${plural(input.bindings.length, 'connection', 'connections')} checked`,
    };
  }

  const parts: string[] = [];
  if (missingAdapter.length > 0) {
    parts.push(
      `${missingAdapter.length} ${plural(missingAdapter.length, 'points', 'point')} at a chat integration that no longer exists`
    );
  }
  if (missingAgent.length > 0) {
    parts.push(
      `${missingAgent.length} ${plural(missingAgent.length, 'points', 'point')} at an agent DorkOS does not know about`
    );
  }
  return {
    label: `${total} chat ${plural(total, 'connection is', 'connections are')} pointing at nothing`,
    status: 'warn',
    detail: `${capitalize(parts.join('; '))}. Messages sent through them go nowhere.`,
    fix: 'Delete the stale connections in Settings → Integrations, or re-add what they point at.',
  };
}

/** Singular/plural helper, matching the doctor renderer's. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Uppercase the first character of a sentence assembled from clauses. */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

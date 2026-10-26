/**
 * The durable record of which state of each agent's own folder settings a
 * person let run, and which they turned down (DOR-3068).
 *
 * ## What an entry is
 *
 * `<agentId>@folder-config-<digest>`, where the digest covers the agent's home
 * and the three part digests (`folder-config-pin.ts`). Keyed by agent id, so a
 * new agent registered at an old folder starts unpinned. The part digests
 * behind each agent's yes are kept beside it (`harness.approvedFolderConfigParts`)
 * so a card can say which part changed; they count only while they still
 * digest to a stored yes for this agent and home.
 *
 * ## Pinned once, on first use
 *
 * An agent with no record at all is pinned to what its folder holds the first
 * time it launches after this shipped: that is what its person was already
 * running. After that, a change never approves itself. A no keeps the agent's
 * earlier yes, so the agent stays pinned and is never pinned on first use again.
 *
 * ## Where the record lives
 *
 * `harness.approvedFolderConfig`, `harness.approvedFolderConfigParts` and
 * `harness.refusedFolderConfig` in `~/.dork/config.json`, all `operator-only`
 * (`config-write-policy.ts`): an agent that could write the yes would approve
 * its own hooks. The residual is the one `hook-consent.ts` states: with login
 * off, a caller that omits its agent header is treated as the operator
 * (DOR-505).
 *
 * @module services/runtimes/claude-code/folder-settings/folder-config-consent
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { logger } from '../../../../lib/logger.js';
import { configManager } from '../../../core/config-manager.js';
import { logConfigWrite } from '../../../core/operator/config-write.js';
import {
  FOLDER_CONFIG_PARTS,
  readFolderConfigParts,
  type FolderConfigDigests,
  type FolderConfigPart,
} from './folder-config-pin.js';

/** One agent's folder settings, as a person is asked about them. */
export interface FolderConfigRequest {
  /** The registered agent's id. */
  agentId: string;
  /** The agent's display name, for the card. */
  agentName: string;
  /** The registered agent home the settings were read from. */
  home: string;
  /** The part digests of the state the card asks about. */
  digests: FolderConfigDigests;
  /** The parts that differ from the agent's last yes, in card order. */
  changed: readonly FolderConfigPart[];
}

/** The agent, its home and a state of its settings. */
type FolderConfigState = Pick<FolderConfigRequest, 'agentId' | 'home' | 'digests'>;

/** What sits between the agent id and the digest in a stored entry. */
export const FOLDER_CONFIG_ENTRY_MARKER = '@folder-config-';

/**
 * The stored form of one decision about one state of one agent's settings.
 *
 * @param state - The agent, its home and the part digests.
 */
export function folderConfigEntry(state: FolderConfigState): string {
  const parts = Object.fromEntries(FOLDER_CONFIG_PARTS.map((p) => [p, state.digests[p]]));
  const digest = createHash('sha256')
    .update(JSON.stringify({ home: path.resolve(state.home), parts }))
    .digest('hex');
  return `${state.agentId}${FOLDER_CONFIG_ENTRY_MARKER}${digest}`;
}

/** Whether a stored entry is about this agent. */
function isAgentEntry(agentId: string): (stored: string) => boolean {
  return (stored) => stored.startsWith(`${agentId}${FOLDER_CONFIG_ENTRY_MARKER}`);
}

/** The three stored leaves. */
interface Decisions {
  approved: string[];
  refused: string[];
  parts: Record<string, FolderConfigDigests>;
}

/** The three leaves as stored now; a missing section reads as nothing decided. */
function storedDecisions(): Decisions {
  const harness = (configManager.get('harness') ?? {}) as {
    approvedFolderConfig?: string[];
    refusedFolderConfig?: string[];
    approvedFolderConfigParts?: Record<string, FolderConfigDigests>;
  };
  return {
    approved: [...(harness.approvedFolderConfig ?? [])],
    refused: [...(harness.refusedFolderConfig ?? [])],
    parts: { ...(harness.approvedFolderConfigParts ?? {}) },
  };
}

/** Write the leaves back, and say nothing when nothing changed. */
function writeDecisions(reason: string, next: Decisions): void {
  const harness = configManager.get('harness');
  const current = storedDecisions();
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  configManager.set('harness', {
    ...harness,
    approvedFolderConfig: next.approved,
    refusedFolderConfig: next.refused,
    approvedFolderConfigParts: next.parts,
  });
  logConfigWrite(reason, 'harness', harness, configManager.get('harness'));
}

/**
 * Whether DorkOS holds any record for this agent. An agent with none is pinned
 * on first use; one with any never is.
 *
 * @param agentId - The registered agent's id.
 */
export function hasFolderConfigRecord(agentId: string): boolean {
  const { approved, parts } = storedDecisions();
  return parts[agentId] !== undefined || approved.some(isAgentEntry(agentId));
}

/**
 * Whether a person approved exactly this state for this agent.
 *
 * @param state - The agent, its home and the part digests.
 */
export function isFolderConfigApproved(state: FolderConfigState): boolean {
  return storedDecisions().approved.includes(folderConfigEntry(state));
}

/**
 * Whether a person turned down exactly this state for this agent.
 *
 * @param state - The agent, its home and the part digests.
 */
export function isFolderConfigRefused(state: FolderConfigState): boolean {
  return storedDecisions().refused.includes(folderConfigEntry(state));
}

/**
 * The part digests behind the agent's current yes, only while they still
 * digest to a stored yes for this agent at this home.
 *
 * @param agentId - The registered agent's id.
 * @param home - The agent's home now.
 */
export function lastApprovedParts(agentId: string, home: string): FolderConfigDigests | undefined {
  const { approved, parts } = storedDecisions();
  const previous = parts[agentId];
  if (!previous) return undefined;
  return approved.includes(folderConfigEntry({ agentId, home, digests: previous }))
    ? { ...previous }
    : undefined;
}

/**
 * Record a yes: it replaces the agent's earlier yes, and clears a matching no.
 *
 * @param state - The state that was allowed.
 * @param reason - The config-write log line.
 */
export function recordFolderConfigApproval(
  state: FolderConfigState,
  reason = "allowing an agent's folder settings"
): void {
  const entry = folderConfigEntry(state);
  const { approved, refused, parts } = storedDecisions();
  writeDecisions(reason, {
    approved: [...approved.filter((stored) => !isAgentEntry(state.agentId)(stored)), entry],
    refused: refused.filter((stored) => stored !== entry),
    parts: { ...parts, [state.agentId]: { ...state.digests } },
  });
}

/**
 * Record a no. The agent's earlier yes stays: what it ran before is still what
 * a person approved, and the agent must not look unpinned.
 *
 * @param state - The state that was turned down.
 */
export function recordFolderConfigRefusal(state: FolderConfigState): void {
  const entry = folderConfigEntry(state);
  const current = storedDecisions();
  writeDecisions("turning down an agent's folder settings", {
    ...current,
    refused: current.refused.includes(entry) ? current.refused : [...current.refused, entry],
  });
}

/**
 * Move one part of an agent's yes from `before` to `after`, when a PERSON just
 * made that change through DorkOS. Only when the agent's yes had exactly
 * `before` for that part: a part the agent already changed on its own stays
 * unapproved, so the card still asks about it. The other parts keep their
 * approved digests.
 *
 * @param agentId - The registered agent's id.
 * @param home - The agent's home.
 * @param part - The part the person changed.
 * @param before - That part's digest just before their change.
 * @param after - Its digest just after.
 * @param reason - The config-write log line.
 * @returns Whether the yes moved.
 */
export function repinFolderConfigPart(
  agentId: string,
  home: string,
  part: FolderConfigPart,
  before: string,
  after: string,
  reason: string
): boolean {
  const approved = lastApprovedParts(agentId, home);
  if (!approved || approved[part] !== before) return false;
  if (before === after) return true;
  recordFolderConfigApproval({ agentId, home, digests: { ...approved, [part]: after } }, reason);
  return true;
}

/**
 * Run a write a PERSON asked for through DorkOS, then move the agent's yes for
 * `part` to what it wrote ({@link repinFolderConfigPart}). Never fails the
 * write: a pin that could not move only means the next turn asks.
 *
 * Call it only where the caller is known to be a person. A write an agent can
 * make for itself must leave the yes alone, so the card asks.
 *
 * @param target - The agent and its home.
 * @param part - The part the write changes.
 * @param reason - The config-write log line.
 * @param write - The write itself.
 */
export async function withPersonRepin<T>(
  target: { agentId: string; home: string },
  part: FolderConfigPart,
  reason: string,
  write: () => Promise<T>
): Promise<T> {
  const before = safeRead(target.home, part);
  const result = await write();
  const after = safeRead(target.home, part);
  if (before !== undefined && after !== undefined) {
    try {
      repinFolderConfigPart(target.agentId, target.home, part, before, after, reason);
    } catch (err) {
      logger.warn('[FolderConfig] Could not move the pin after a person changed it', {
        agentId: target.agentId,
        part,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

/**
 * Move the yes for `part` of every agent pinned at `home`, around a write
 * DorkOS makes there on a person's behalf (the hook projection after a person
 * approved a package's hooks). The digest before is read before the write, so
 * anything an agent changed first stays unapproved.
 *
 * @param home - The folder written to.
 * @param part - The part the write changes.
 * @param reason - The config-write log line.
 * @param write - The write itself.
 */
export function withPersonRepinAtHome<T>(
  home: string,
  part: FolderConfigPart,
  reason: string,
  write: () => T
): T {
  let agents: string[] = [];
  try {
    agents = Object.keys(storedDecisions().parts).filter(
      (agentId) => lastApprovedParts(agentId, home) !== undefined
    );
  } catch {
    // No config to read (the CLI, a test): nothing is pinned here to move.
  }
  if (agents.length === 0) return write();
  const before = safeRead(home, part);
  const result = write();
  const after = safeRead(home, part);
  if (before !== undefined && after !== undefined) {
    for (const agentId of agents) {
      try {
        repinFolderConfigPart(agentId, home, part, before, after, reason);
      } catch (err) {
        logger.warn('[FolderConfig] Could not move the pin after a projection', {
          agentId,
          part,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}

/** One part's digest, or `undefined` when it can't be vouched for. */
function safeRead(home: string, part: FolderConfigPart): string | undefined {
  try {
    const read = readFolderConfigParts(home);
    return read.unverifiable.includes(part) ? undefined : read.digests[part];
  } catch {
    return undefined;
  }
}

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
 * The home counts too, by its real path: an agent that rewrites the `id` in
 * its own agent file is registered again under the new id, and a home that
 * already holds a yes for ANY agent id is never pinned on first use. Its old
 * yes is what the new id is compared against, and `id` is one of the pinned
 * fields, so the change raises a card.
 *
 * ## Where the record lives
 *
 * `harness.approvedFolderConfig`, `harness.approvedFolderConfigParts` and
 * `harness.refusedFolderConfig` in `~/.dork/config.json`, all `operator-only`
 * (`config-write-policy.ts`): an agent that could write the yes would approve
 * its own hooks. The residual is the one `hook-consent.ts` states: with login
 * off, a caller that omits its agent header is treated as the operator
 * (DOR-505). The space side writes them
 * (`core/approvals/computer-asks/folder-decisions.ts`), from a card's answer or
 * a decision this side reports through the asks port (a pin on first use, a
 * person's own edit moving the pin); this module only reads.
 *
 * @module services/runtimes/claude-code/folder-settings/folder-config-consent
 */
import type { FolderConfigRequest } from '@dorkos/shared/computer-asks';
import { FOLDER_CONFIG_ENTRY_MARKER, folderConfigEntry } from '@dorkos/shared/consent-entries';
import { logger } from '../../../../lib/logger.js';
import { configManager } from '../../../core/config-manager.js';
import { runtimeAsks } from '../../computer-asks.js';
import {
  inertApartFromRuntime,
  readFolderConfigParts,
  type FolderConfigDigests,
  type FolderConfigPart,
} from './folder-config-pin.js';

// The stored form of a decision is the space side's too: it writes these lists
// (`core/approvals/computer-asks/folder-decisions.ts`), this module reads them.
export type { FolderConfigRequest };
export { FOLDER_CONFIG_ENTRY_MARKER, folderConfigEntry };

/** The agent, its home and a state of its settings. */
type FolderConfigState = Pick<FolderConfigRequest, 'agentId' | 'home' | 'digests'>;

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

/**
 * Whether DorkOS holds any record for this agent, or a yes for any agent at
 * its home. Only an agent with neither is pinned on first use.
 *
 * @param agentId - The registered agent's id.
 * @param home - The agent's home.
 */
export function hasFolderConfigRecord(agentId: string, home: string): boolean {
  const { approved, parts } = storedDecisions();
  return (
    parts[agentId] !== undefined ||
    approved.some(isAgentEntry(agentId)) ||
    approvedPartsAtHome(home) !== undefined
  );
}

/**
 * The part digests behind a yes held for ANY agent id at this home (by real
 * path), so an agent that changed its own id is compared against what its home
 * last ran rather than treated as new.
 *
 * @param home - The agent's home.
 */
export function approvedPartsAtHome(home: string): FolderConfigDigests | undefined {
  const { approved, parts } = storedDecisions();
  for (const [agentId, digests] of Object.entries(parts)) {
    if (approved.includes(folderConfigEntry({ agentId, home, digests }))) return { ...digests };
  }
  return undefined;
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
 * Run a write a PERSON asked for through DorkOS, then have the space side move
 * the agent's yes for `part` to what it wrote (a `folder_config_repinned`
 * decision: only when the yes had exactly the digest from before the write, so
 * a part the agent changed on its own stays unapproved). Never fails the write:
 * a pin that could not move only means the next turn asks.
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
      repin(target.agentId, target.home, part, before, after, reason);
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
        repin(agentId, home, part, before, after, reason);
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

/** Report a person's edit of one part, for the space side to move the pin. */
function repin(
  agentId: string,
  home: string,
  part: FolderConfigPart,
  before: string,
  after: string,
  reason: string
): void {
  runtimeAsks().record({
    kind: 'folder_config_repinned',
    agentId,
    home,
    part,
    before,
    after,
    reason,
  });
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

/**
 * The account an agent file names, unless its agent-file part is held back
 * (changed since a person's yes, or unreadable): then none, exactly as the
 * launch decides (DOR-3068). For the places that predict a launch's account
 * before it runs. An agent with no record keeps it only when nothing in its
 * home runs (which an account alone already contradicts).
 *
 * @param manifest - The agent file as read, or `null`.
 * @param home - The agent's home, if any.
 */
export function accountUnlessHeld(
  manifest: { id?: string; account?: string } | null,
  home: string | null | undefined
): string | undefined {
  const account = manifest?.account;
  if (!account || !home || !manifest?.id) return account;
  try {
    // No record: held unless nothing in the home runs, as the launch decides.
    if (!hasFolderConfigRecord(manifest.id, home)) {
      return readFolderConfigParts(home).inert ? account : undefined;
    }
    const now = readFolderConfigParts(home);
    const approved = lastApprovedParts(manifest.id, home) ?? approvedPartsAtHome(home);
    if (!approved || now.unverifiable.includes('manifest')) return undefined;
    return approved.manifest === now.digests.manifest ? account : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The runtime an agent file names, unless its agent-file part is held back
 * (changed since a person's yes, or unreadable): then none, so the session
 * falls back to the default runtime (DOR-3068 M3). Without this, an agent
 * could write `runtime: "codex"` and a server into its own agent file, and the
 * next session would start that server on a runtime the pin never reads.
 *
 * @param manifest - The agent file as read, or `null`.
 * @param home - The agent's home, if any.
 */
export function runtimeUnlessHeld(
  manifest: { id?: string; runtime?: string } | null,
  home: string | null | undefined
): string | undefined {
  const runtime = manifest?.runtime;
  if (!runtime || !home || !manifest?.id) return runtime;
  try {
    if (!hasFolderConfigRecord(manifest.id, home)) {
      return readFolderConfigParts(home).inert ? runtime : undefined;
    }
    const now = readFolderConfigParts(home);
    const approved = lastApprovedParts(manifest.id, home) ?? approvedPartsAtHome(home);
    if (!approved || now.unverifiable.includes('manifest')) return undefined;
    return approved.manifest === now.digests.manifest ? runtime : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Pin an agent a PERSON just created to what DorkOS wrote for it, so the
 * runtime they picked is the one it runs on (DOR-3459). Without this, a new
 * agent on Codex or OpenCode has no record, its runtime alone makes its home
 * "not inert", and its first chat silently falls back to the default runtime.
 *
 * Only for a home with no record yet, where nothing runs or widens anything
 * apart from the runtime. Call it only where the caller is known to be a
 * person: an agent creating an agent leaves the runtime held, so a card asks.
 *
 * @param agentId - The new agent's id.
 * @param home - The new agent's home.
 * @returns Whether the agent was pinned.
 */
export function pinPersonCreatedAgent(agentId: string, home: string): boolean {
  try {
    if (hasFolderConfigRecord(agentId, home)) return false;
    const now = readFolderConfigParts(home);
    if (!now.inert && !inertApartFromRuntime(now)) return false;
    runtimeAsks().record({
      kind: 'folder_config_approved',
      agentId,
      home,
      digests: now.digests,
      reason: 'pinning an agent a person created',
    });
    return true;
  } catch (err) {
    logger.warn('[FolderConfig] Could not pin an agent a person created', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Whether DorkOS has pinned the agents that already existed (`harness.folderConfigPinned`). */
export function folderConfigsPinned(): boolean {
  return (
    (configManager.get('harness') as { folderConfigPinned?: boolean } | undefined)
      ?.folderConfigPinned === true
  );
}

/** Whether any agent's folder settings were ever pinned or decided. */
export function hasAnyFolderConfigRecord(): boolean {
  const { approved, refused, parts } = storedDecisions();
  return approved.length > 0 || refused.length > 0 || Object.keys(parts).length > 0;
}

/**
 * An agent that leaves your team leaves every channel with it (DOR-2095).
 *
 * The Slack model: membership is live state, history is archive. Unregistering
 * an agent takes it off every channel roster in one transaction, its direct
 * messages keep it and draw it as retired, and every message it ever wrote keeps
 * its name and face. Two ways in, one write:
 *
 * - **The cascade** ({@link registerRoomUnregisterCascade}) rides
 *   `MeshCore.onUnregister`, which every removal path shares — the DELETE routes,
 *   the MCP tool and the reconciler's 24-hour orphan sweep.
 * - **The repair sweep** ({@link sweepDepartedAgentSeats}) runs once per boot and
 *   takes out the seats unregisters left behind before the cascade existed.
 *
 * Both end in `RoomService.dropDepartedAgents`, which asks the liveness question
 * itself at write time — so neither can take a seat from an agent that is
 * registered, however it came to be named.
 *
 * @module server/services/rooms/manage/departed-agents
 */
import { realpathSync } from 'node:fs';
import { readManifest } from '@dorkos/shared/manifest';
import type { Logger } from '@dorkos/shared/logger';
import type { AuthorRecord } from '../author-registry.js';
import type { ChannelSeat } from './departed-seat-store.js';
import type { DepartedAgentsDrop } from './room-departures.js';

/** The slice of the room service departures need. */
export interface DepartedAgentRooms {
  dropDepartedAgentAt(agentPath: string, manifestId: string): DepartedAgentsDrop;
  restoreReturningAgentAt(agentPath: string): ChannelSeat[];
  restoreAllReturningAgents(): ChannelSeat[];
  dropDepartedAgents(authorIds: readonly string[]): DepartedAgentsDrop;
  listDepartedChannelAgents(): AuthorRecord[];
}

/** The two Mesh lifecycle signals departures listen to. */
export interface MeshLifecycleSignals {
  onUnregister(callback: (agentId: string, projectPath: string) => void): void;
  onAgentsChanged(
    callback: (change: { kind: string; agentId: string; projectPath?: string }) => void
  ): void;
}

/**
 * Take an unregistered agent off every channel roster the moment Mesh drops it.
 *
 * The callback fires after the registry row is gone, so the author rows at the
 * directory fail the liveness check and lose their channel seats, in one
 * transaction. Synchronous, like the database under it: by the time the
 * unregister call returns, no roster names the agent.
 *
 * **What registering the same agent again means.** Every seat taken is kept in
 * a tombstone, and the moment Mesh registers an agent at the directory whose
 * manifest id matches the one that left, those seats come back — its channels,
 * its per-room settings, its read position and its fallback seat, wherever the
 * room is still open and nobody has taken the fallback seat since. Its direct
 * messages read as active again on their own, because the author row answers
 * for the directory again. That is the reconciler's case — a folder unreachable
 * for more than 24 hours, back with the same manifest — and a re-scan of a
 * folder whose manifest survived. A person's own unregister usually deletes the
 * manifest, so what is registered there next has a new id: a different agent,
 * which inherits nothing (ADR 260801-003051).
 *
 * @param mesh - Where registrations and unregisters are announced.
 * @param rooms - The room service.
 * @param logger - Where a cascade that moved something says so.
 */
export function registerRoomUnregisterCascade(
  mesh: MeshLifecycleSignals,
  rooms: Pick<DepartedAgentRooms, 'dropDepartedAgentAt' | 'restoreReturningAgentAt'>,
  logger: Pick<Logger, 'info'>
): void {
  mesh.onAgentsChanged((change) => {
    // `updated` as well as `registered`: an agent that relocates back to the
    // directory it left arrives as an update to its existing row.
    if (change.kind === 'removed' || !change.projectPath) return;
    const restored = rooms.restoreReturningAgentAt(change.projectPath);
    if (restored.length === 0) return;
    logger.info('[rooms] a returning agent got its channels back', {
      event: 'rooms.agent_returned',
      agentId: change.agentId,
      seatsRestored: restored.length,
      roomIds: [...new Set(restored.map((seat) => seat.roomId))],
    });
  });
  mesh.onUnregister((agentId, projectPath) => {
    const { authorIds, removed } = rooms.dropDepartedAgentAt(projectPath, agentId);
    if (removed.length === 0) return;
    logger.info('[rooms] an unregistered agent left its channels', {
      event: 'rooms.agent_departed',
      agentId,
      authorIds,
      seatsRemoved: removed.length,
      roomIds: [...new Set(removed.map((seat) => seat.roomId))],
    });
  });
}

/** What the sweep reads off the disk to tell a gone agent from one on its way back. */
export interface DepartedAgentEvidence {
  /**
   * Whether this directory is on the Mesh denial list — unregistered on
   * purpose while its manifest stayed, because git tracks it (DOR-1019).
   */
  isDenied(agentPath: string): boolean;
  /** The id in the manifest at this directory, or `null` when none can be read. */
  manifestIdAt(agentPath: string): Promise<string | null>;
}

/** What one sweep did. */
export interface DepartedSweepResult {
  /** Channel seats taken from agents that are gone. */
  removed: number;
  /** Unregistered agents left seated because their manifest says they are coming back. */
  pending: number;
  /** Seats given back to agents that returned while nothing was listening. */
  restored: number;
}

/**
 * Take the channel seats of every agent that is no longer on your team — the
 * ghosts left by unregisters that happened before the cascade existed.
 * Idempotent: a second run finds nothing to do, so it runs on every boot.
 *
 * **"No longer on your team", precisely.** A seated agent author is departed
 * when BOTH hold:
 *
 * 1. **The registry has no live occupant for it** (`isLiveAuthor`): no
 *    `agents` row at its directory, or one for a different agent. The registry
 *    is the authority on who is registered, and it is deliberately patient — an
 *    `unreachable` agent (a laptop asleep, a drive unmounted) keeps its row for
 *    the reconciler's 24-hour grace period, so it is live and never reaches this
 *    list. Past that grace the reconciler unregisters it through the same
 *    cascade as a person would, so the sweep's answer agrees with the cascade's.
 * 2. **Nothing on disk says it is about to be registered again.** A readable
 *    manifest at the directory, naming this same agent, on a directory nobody
 *    denied, is a registration the next reconcile completes (ADR-0043 rebuilds
 *    the registry from exactly these files). That agent keeps its seats. A
 *    denied directory is the one exception: its manifest stayed because git
 *    tracks it, and the denial is what says it is not coming back.
 *
 * A directory that cannot be read at all counts as gone, not pending: an agent
 * whose drive is merely unmounted is still in the registry (rule 1), so one that
 * is not has already been unregistered. Even then nothing is lost for good — the
 * seat goes to a tombstone and comes back if the same agent does.
 *
 * It first gives back any waiting seat whose agent is live again, so a return
 * that happened while nothing was listening (a registration before this process
 * wired its hooks) is not left waiting for a registration that already came.
 *
 * @param deps - The room service, the disk evidence, and a logger.
 */
export async function sweepDepartedAgentSeats(deps: {
  rooms: Pick<
    DepartedAgentRooms,
    'dropDepartedAgents' | 'listDepartedChannelAgents' | 'restoreAllReturningAgents'
  >;
  evidence: DepartedAgentEvidence;
  logger: Pick<Logger, 'info'>;
}): Promise<DepartedSweepResult> {
  const restored = deps.rooms.restoreAllReturningAgents().length;
  const departed: string[] = [];
  let pending = 0;
  for (const author of deps.rooms.listDepartedChannelAgents()) {
    if (await isComingBack(author, deps.evidence)) {
      pending += 1;
      continue;
    }
    departed.push(author.id);
  }
  // Liveness is asked again inside, at write time — an agent registered while
  // the disk reads above were in flight keeps every seat.
  const { authorIds, removed } = deps.rooms.dropDepartedAgents(departed);
  if (removed.length > 0 || pending > 0 || restored > 0) {
    deps.logger.info('[rooms] repaired channel rosters holding agents no longer on your team', {
      event: 'rooms.departed_sweep',
      authorIds,
      seatsRemoved: removed.length,
      seatsRestored: restored,
      pending,
    });
  }
  return { removed: removed.length, pending, restored };
}

/**
 * Whether the disk says this unregistered agent is on its way back — rule 2 of
 * {@link sweepDepartedAgentSeats}.
 *
 * @param author - A seated agent author the registry has no live occupant for.
 * @param evidence - The disk reads.
 */
async function isComingBack(
  author: AuthorRecord,
  evidence: DepartedAgentEvidence
): Promise<boolean> {
  if (evidence.isDenied(author.naturalKey)) return false;
  const manifestId = await evidence.manifestIdAt(author.naturalKey);
  if (manifestId === null) return false;
  // A legacy row carries no stamp, so any manifest at its directory could be it.
  return author.mintedForManifestId === null || author.mintedForManifestId === manifestId;
}

/**
 * The shipped {@link DepartedAgentEvidence}: the Mesh denial list, and the
 * manifest on disk.
 *
 * The denial list stores canonical paths (it resolves symlinks on the way in),
 * so a directory is matched both as written and as resolved.
 *
 * @param listDenied - The Mesh denial list.
 */
export function diskEvidence(
  listDenied: () => ReadonlyArray<{ path: string }>
): DepartedAgentEvidence {
  let denied: Set<string> | null = null;
  return {
    isDenied(agentPath) {
      denied ??= new Set(listDenied().map((record) => record.path));
      return denied.has(agentPath) || denied.has(canonical(agentPath));
    },
    async manifestIdAt(agentPath) {
      const manifest = await readManifest(agentPath, { warn: () => {} });
      return manifest?.id ?? null;
    },
  };
}

/** A path with its symlinks resolved, or the path as given when it cannot be. */
function canonical(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

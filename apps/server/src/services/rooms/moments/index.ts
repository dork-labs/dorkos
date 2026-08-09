/**
 * Moments — the milestones #team marks, wired to this install (team-room-home
 * spec D5.1).
 *
 * The post type and its write path are `RoomService.postMoment` (task 4.1). What
 * lives here is the noticing: detectors that run on event paths that already
 * exist, and the reads that make every one of them a statement about a real
 * record.
 *
 * @module server/services/rooms/moments
 */
import type { Db } from '@dorkos/db';
import { TEAM_ROOM_WELL_KNOWN } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import type { AuthorRegistry } from '../author-registry.js';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import { MomentDetectors, type MomentRoom } from './moment-detectors.js';
import { createMomentFacts } from './moment-facts.js';

// The barrel carries only what leaves this module: the factory the server's
// bootstrap calls, and the two halves it composes — so a test can replace one of
// them without rebuilding the other beside it. The detector class and the fact
// reader are imported from their own files by the code that needs them, so this
// file does not accrue a re-export per symbol.

/**
 * The room half of the detectors' world, over the rooms subsystem.
 *
 * Separated from {@link createMomentDetectors} so a test can pair the REAL room
 * (real service, real store, real database — the only way a claim about durable
 * markers means anything) with a fact reader it can watch.
 *
 * @param deps.service - The wired room service; moments go through its
 *   `postMoment`, which is the same guarded write path everything else uses.
 * @param deps.store - The room store, for the two reads that make the moment log
 *   its own durable marker.
 * @param deps.authors - The author registry, for the identity the feed draws
 *   beside a moment about an agent.
 */
export function createMomentRoom(deps: {
  service: RoomService;
  store: RoomStore;
  authors: AuthorRegistry;
}): MomentRoom {
  return {
    teamRoomId: () => deps.store.findByWellKnown(TEAM_ROOM_WELL_KNOWN)?.id ?? null,
    hasMarked: (roomId, key) => deps.store.hasMoment(roomId, key),
    lastMarkedAt: (roomId, scan) => deps.store.latestMomentAt(roomId, scan),
    mark: (roomId, candidate) => {
      deps.service.postMoment(roomId, candidate);
    },
    agentAuthorId: (agent) => {
      try {
        return deps.authors.resolveAgent(agent.path, agent.displayName).id;
      } catch (err) {
        // A moment the feed draws with the system's face is still a true
        // moment; one that failed to post because an identity would not resolve
        // is a milestone nobody sees.
        logger.warn('[Rooms] could not resolve the agent a moment is about', {
          agentPath: agent.path,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    },
  };
}

/**
 * Wire the moment detectors to the rooms subsystem and the database.
 *
 * @param deps.service - The wired room service.
 * @param deps.store - The room store.
 * @param deps.authors - The author registry.
 * @param deps.db - The consolidated DB handle, for the records detectors read.
 */
export function createMomentDetectors(deps: {
  service: RoomService;
  store: RoomStore;
  authors: AuthorRegistry;
  db: Db;
}): MomentDetectors {
  return new MomentDetectors({
    room: createMomentRoom(deps),
    facts: createMomentFacts(deps.db),
  });
}

/**
 * Run the "nothing is running" watch (DOR-3675) on a timer, over the server's real reads: chat
 * activity and recent lanes from the open-work reader (DOR-3674), every agent's open promises,
 * and the room from `heartbeats.idleAlertRoomId` (a setting only a person changes), else the
 * team room.
 *
 * @module services/heartbeats/idle-watch/start-idle-alert
 */
import { TEAM_ROOM_WELL_KNOWN } from '@dorkos/shared/room-schemas';
import { logError, logger } from '../../../lib/logger.js';
import { configManager } from '../../core/config-manager.js';
import type { RoomService } from '../../rooms/room-service.js';
import type { TodoPromiseService } from '../../todos/index.js';
import { createIdleAlertWatch, IDLE_ALERT_CHECK_MS } from './idle-alert.js';

/** What the watch is started with. */
export interface StartIdleAlertDeps {
  /** Whether heartbeats are on. */
  enabled: () => boolean;
  /** Chat activity across this computer, from the open-work reader. */
  computerActivity: () => 'running' | number | undefined;
  /** How many chats a `session_start` opened in the last three days. */
  recentLaneCount: (at: Date) => number;
  /** Every agent's promises. */
  todoPromises: Pick<TodoPromiseService, 'list'>;
  /** Where the notice goes. */
  rooms: Pick<RoomService, 'postNotice' | 'findWellKnownRoom'>;
}

/**
 * Build the watch's timer. It runs only while started: heartbeats-wiring starts it when
 * heartbeats turn on and stops it when they turn off, like the outbox.
 *
 * @param deps - Its reads and the room seam.
 * @returns Start and stop for its timer; both are safe to repeat.
 */
export function createIdleAlert(deps: StartIdleAlertDeps): { start(): void; stop(): void } {
  const watch = createIdleAlertWatch({
    enabled: deps.enabled,
    chatActivity: deps.computerActivity,
    openWork: async () => ({
      lanes: deps.recentLaneCount(new Date()),
      promises: deps.todoPromises.list({ state: 'open' }).length,
    }),
    targetRoom: () => {
      const chosen = configManager.get('heartbeats').idleAlertRoomId ?? null;
      if (chosen !== null) return chosen;
      const team = deps.rooms.findWellKnownRoom(TEAM_ROOM_WELL_KNOWN);
      return team && !team.archived ? team.id : null;
    },
    postNotice: (roomId, text) => {
      try {
        deps.rooms.postNotice(roomId, { text });
      } catch (err) {
        // A room archived or removed since it was chosen: say nothing, and say so in the log.
        logger.warn('[heartbeats] could not post the idle notice', { roomId, ...logError(err) });
      }
    },
    now: Date.now,
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start() {
      if (timer !== undefined) return;
      timer = setInterval(() => {
        void watch.check().catch((err) => {
          logger.warn('[heartbeats] the idle check failed', logError(err));
        });
      }, IDLE_ALERT_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
  };
}

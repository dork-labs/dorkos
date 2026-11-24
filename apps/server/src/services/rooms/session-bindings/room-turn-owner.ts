import { runtimeRegistry } from '../../core/runtime-registry.js';
import {
  SessionBirthWriteError,
  type SessionBirthWriteContext,
} from '../../core/runtime-seam/session-birth-write.js';
import { logger } from '../../../lib/logger.js';
import type { RoomTurnRequest } from '../room-turn-port.js';
import type { RoomSeatBirth } from './room-seat-birth.js';

type RoomTurnOwner = Pick<RoomTurnRequest, 'room' | 'authorId' | 'agentPath' | 'externalAuthor'>;

/** Bind the runtime before its room turn, requiring transfer of a known pending seat birth. */
export async function recordRoomTurnOwner(
  request: RoomTurnOwner,
  sessionId: string,
  runtimeType: string,
  pending?: RoomSeatBirth
): Promise<boolean> {
  const source: [SessionBirthWriteContext?] = pending
    ? [
        {
          kind: 'room-seat',
          roomId: request.room.id,
          authorId: request.authorId,
          agentPath: request.agentPath,
          ...pending,
        },
      ]
    : [];
  try {
    return await runtimeRegistry.persistSessionRuntime(
      sessionId,
      runtimeType,
      { kind: 'room', externalAuthor: request.externalAuthor },
      request.agentPath,
      ...source
    );
  } catch (error) {
    logger.warn('[rooms] could not record which runtime owns this session', {
      sessionId,
      roomId: request.room.id,
      runtimeType,
      error: error instanceof Error ? error.message : String(error),
    });
    // An admitted reservation has to reach its first write before native execution.
    if (pending)
      throw error instanceof SessionBirthWriteError ? error : new SessionBirthWriteError('write');
    return false;
  }
}

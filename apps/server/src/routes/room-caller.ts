/**
 * Resolves who a room request is, for both the REST routes and the SSE handler.
 *
 * It lives in its own module rather than in `rooms.ts` because `rooms.ts`
 * imports the SSE handler, so the handler cannot import back from it without a
 * cycle — and the handler needs the caller for exactly the same reason the REST
 * routes do: a room is membership-scoped, and the stream is a read.
 *
 * @module routes/room-caller
 */
import type { Response } from 'express';
import { getRoomService, type AuthorRecord } from '../services/rooms/index.js';
import { getRequestAgentIdentity } from '../middleware/agent-identity.js';

/**
 * Who this request is.
 *
 * An agent presenting a valid identity token acts as itself, minted on its
 * `agentPath`; every other caller is the single local human author v1 mints.
 *
 * Author identity is never read from the request body. A client that could name
 * its own author could post as anyone in the room — and, since every room read
 * is scoped to the caller's membership, could read any room by naming a member
 * of it.
 *
 * @param res - The response holding the resolved agent identity, if any.
 */
export function resolveCaller(res: Response): AuthorRecord {
  const service = getRoomService();
  const identity = getRequestAgentIdentity(res);
  if (identity) {
    return service.authorRegistry.resolveAgent(identity.agentPath, identity.displayName);
  }
  return service.authorRegistry.localHuman();
}

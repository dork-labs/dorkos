import type { Request, Response } from 'express';
import { InstallationFileWrites } from '../writes/installation-file-writes.js';
import {
  agents,
  authors,
  sessionMetadata,
  roomSessions,
  roomSessionRetirements,
  roomMembers,
  and,
  eq,
  isNull,
  type Db,
} from '@dorkos/db';
import type { RoomStore } from '../../../rooms/room-store.js';
import type { RoomSessionPlacePort } from '../../../workspace/room-session-place.js';
import {
  resolveRoomTurnPlace,
  sessionStandsInRoomCopy,
} from '../../../rooms/repo/room-turn-place.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { DocChannelNotFoundError } from '../authorization.js';
import { readOriginalHttpRequestCustody } from '../http-composition.js';
import {
  type OriginalHttpFileOwner,
  type OriginalHttpRoomSessionPlacement,
} from './http-composition-contracts.js';
import { requireOriginalHttpRoomWorktreeOwner } from './http-file-request-lifetime.js';
import {
  requireOriginalRoomFileBinding,
  roomCallerOf,
  captureDocHttpRoomFileWriteCaller,
  checkDocHttpRoomFileWriteCurrent,
} from './http-room-file-request-lifetime.js';

/** Native binding DATA from the captured owning Db; never a public ledger callback. */
export function originalHttpSessionFacts(
  httpCustodyOwner: object,
  binding: OriginalHttpFileOwner,
  sessionId: string
) {
  readOriginalHttpRequestCustody(httpCustodyOwner);
  let canonical = sessionId;
  const seen = new Set<string>();
  let rows: (typeof roomSessions.$inferSelect)[] = [];
  for (let hop = 0; hop < 16; hop++) {
    if (seen.has(canonical)) throw new DocChannelNotFoundError();
    seen.add(canonical);
    rows = binding.db
      .select()
      .from(roomSessions)
      .where(eq(roomSessions.sessionId, canonical))
      .limit(2)
      .all();
    if (rows.length !== 0) break;
    const next = binding.db
      .select()
      .from(roomSessionRetirements)
      .where(eq(roomSessionRetirements.retiredSessionId, canonical))
      .get();
    if (!next) return undefined;
    canonical = next.canonicalSessionId;
  }
  if (rows.length !== 1) throw new DocChannelNotFoundError();
  const row = rows[0]!;
  const author = binding.db
    .select()
    .from(authors)
    .where(and(eq(authors.id, row.authorId), eq(authors.kind, 'agent'), isNull(authors.retiredAt)))
    .get();
  const agent =
    author &&
    binding.db
      .select()
      .from(agents)
      .where(and(eq(agents.projectPath, author.naturalKey), eq(agents.status, 'active')))
      .get();
  const metadata = binding.db
    .select()
    .from(sessionMetadata)
    .where(eq(sessionMetadata.sessionId, canonical))
    .get();
  const member = binding.db
    .select()
    .from(roomMembers)
    .where(and(eq(roomMembers.roomId, row.roomId), eq(roomMembers.authorId, row.authorId)))
    .get();
  if (
    !author ||
    !agent ||
    !metadata ||
    !member ||
    author.mintedForManifestId !== agent.id ||
    metadata.agentPath !== agent.projectPath ||
    metadata.runtime !== agent.runtime
  )
    throw new DocChannelNotFoundError();
  return Object.freeze({
    roomId: row.roomId,
    targetAuthorId: author.id,
    targetAgentId: agent.id,
    targetAgentPath: agent.projectPath,
    targetRuntime: agent.runtime,
    targetSessionId: canonical,
    displayName: author.displayName,
  });
}

/** Only the exact request and owning construction can keep this fresh placement current. */
export function readOriginalHttpRoomSessionPlacement(
  httpCustodyOwner: object,
  token: object,
  db: Db,
  store: RoomStore
) {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = facet.originalHttpRoomSessionPlacements.get(token);
  if (!current) return undefined;
  if (!current.active || current.binding.db !== db || current.binding.roomStore !== store)
    throw new DocChannelNotFoundError();
  const caller = roomCallerOf(
    httpCustodyOwner,
    current.owner,
    current.facts.roomId,
    current.caller
  );
  if (caller.req.aborted || caller.res.writableEnded || caller.res.destroyed)
    throw new DocChannelNotFoundError();
  const facts = originalHttpSessionFacts(httpCustodyOwner, current.binding, current.sessionId);
  if (!facts || JSON.stringify(facts) !== JSON.stringify(current.facts))
    throw new DocChannelNotFoundError();
  const manager = current.binding.worktrees;
  if (!manager) throw new DocChannelNotFoundError();
  requireOriginalHttpRoomWorktreeOwner(
    httpCustodyOwner,
    current.owner,
    manager,
    db,
    current.binding.rooms
  );
  return facts;
}

/** Original trigger placements have no HTTP credentials; HTTP placements repeat actual verification. */
export async function checkOriginalHttpRoomSessionPlacement(
  httpCustodyOwner: object,
  token: object
): Promise<void> {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = facet.originalHttpRoomSessionPlacements.get(token);
  if (!current) return;
  readOriginalHttpRoomSessionPlacement(
    httpCustodyOwner,
    token,
    current.binding.db,
    current.binding.roomStore
  );
  await checkDocHttpRoomFileWriteCurrent(
    httpCustodyOwner,
    current.owner,
    current.facts.roomId,
    current.caller
  );
  readOriginalHttpRoomSessionPlacement(
    httpCustodyOwner,
    token,
    current.binding.db,
    current.binding.roomStore
  );
}

/** Capture a fresh interactive request; a session id alone never issues placement permission. */
export async function captureOriginalHttpRoomSessionPlacement(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  req: Request,
  res: Response,
  sessionId: string
): Promise<Readonly<{ place: RoomSessionPlacePort; retire(): void }>> {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const binding = facet.originalHttpFileOwners.get(owner);
  if (!binding) throw new DocChannelNotFoundError();
  requireOriginalRoomFileBinding(httpCustodyOwner, owner, binding);
  const facts = originalHttpSessionFacts(httpCustodyOwner, binding, sessionId);
  if (!facts) {
    return Object.freeze({
      place: {
        roomFor: () => null,
        placeTurn: async () => {
          throw new DocChannelNotFoundError();
        },
      },
      retire() {},
    });
  }
  if (binding.closed || !binding.worktrees || !binding.editor) throw new DocChannelNotFoundError();
  const manager = binding.worktrees;
  const caller = await captureDocHttpRoomFileWriteCaller(
    httpCustodyOwner,
    owner,
    req,
    res,
    facts.roomId,
    binding.editor
  );
  const token = Object.freeze({});
  const current: OriginalHttpRoomSessionPlacement = {
    owner,
    binding,
    caller,
    sessionId,
    facts,
    active: true,
  };
  facet.originalHttpRoomSessionPlacements.set(token, current);
  const retire = () => {
    current.active = false;
    facet.originalHttpRoomSessionPlacements.delete(token);
    retireDocHttpRoomFileWriteCaller(httpCustodyOwner, owner, caller);
  };
  try {
    await checkOriginalHttpRoomSessionPlacement(httpCustodyOwner, token);
    return Object.freeze({
      place: {
        roomFor(id: string) {
          // DATA lookup only. The awaited placement below must surface admission loss,
          // rather than let the generic optional Room lookup hide it as an ordinary chat.
          if (id !== sessionId) return null;
          return {
            roomId: facts.roomId,
            agentPath: facts.targetAgentPath,
            agentName: facts.displayName,
          };
        },
        async placeTurn(roomId: string, agentPath: string, agentName: string, id?: string) {
          await checkOriginalHttpRoomSessionPlacement(httpCustodyOwner, token);
          const live = readOriginalHttpRoomSessionPlacement(
            httpCustodyOwner,
            token,
            binding.db,
            binding.roomStore
          );
          if (!live) throw new DocChannelNotFoundError();
          if (
            id !== sessionId ||
            roomId !== live.roomId ||
            agentPath !== live.targetAgentPath ||
            agentName !== live.displayName
          )
            throw new DocChannelNotFoundError();
          // Preserve the original narrow no-project fallback. Authentication or
          // native-currentness failures remain refusals, never ordinary chat.
          const placed = await resolveRoomTurnPlace(manager, roomId, agentPath, agentName, token);
          await checkOriginalHttpRoomSessionPlacement(httpCustodyOwner, token);
          if (placed.worktree !== null) {
            const runtime = await runtimeRegistry.resolveForSession(sessionId).catch(() => null);
            await checkOriginalHttpRoomSessionPlacement(httpCustodyOwner, token);
            if (runtime?.type === 'opencode') {
              const inCopy = await sessionStandsInRoomCopy(runtime, sessionId, {
                agentPath,
                worktree: placed.worktree,
              });
              await checkOriginalHttpRoomSessionPlacement(httpCustodyOwner, token);
              if (inCopy) {
                return {
                  cwd: placed.worktree,
                  additionalDirectories: [],
                  worktree: placed.worktree,
                  standsInCopy: true,
                };
              }
            }
          }
          return placed;
        },
      },
      retire,
    });
  } catch (cause) {
    retire();
    throw cause;
  }
}

/** Retire the exact captured Room file write caller. */
export function retireDocHttpRoomFileWriteCaller(
  httpCustodyOwner: object,
  owner: InstallationFileWrites,
  handle: object
): undefined {
  const facet = readOriginalHttpRequestCustody(httpCustodyOwner);
  const current = facet.originalHttpRoomFileCallers.get(handle);
  if (!current || current.owner !== owner) throw new DocChannelNotFoundError();
  current.active = false;
  facet.originalHttpRoomFileCallers.delete(handle);
  return undefined;
}

/**
 * The first-party place a proactive agent message lands when no external chat
 * integration can carry it (DOR-1209, and point 3 of DOR-793).
 *
 * `resolveNotifyTarget` answers one question — which bound Slack/Telegram chat
 * may this agent initiate a message on — and on a stock install the honest
 * answer is "none": nobody has connected an integration yet. Until now that
 * made `relay_notify_user` a silent no-op, so an agent that finished a long job
 * announced it into the void while DorkOS's own direct messages sat unused.
 *
 * This module is the other half of the answer. The message goes into the **1:1**
 * DM between the agent and the operator — a normal post, written by the agent,
 * through {@link RoomService.post}, with the room resolved (or opened once)
 * through {@link RoomService.createRoom}'s DM branch, which is idempotent on
 * the exact member set. So the notification lands in that one conversation
 * rather than in a room per notification.
 *
 * "The 1:1" is meant literally: the member set is exactly this agent and the
 * operator, so a GROUP DM that happens to contain the same agent is a different
 * room and does not absorb notifications. Whether it ever should is parked as
 * Q6 in `specs/proactive-agent-dms/01-ideation.md`.
 *
 * ## Three things this deliberately does NOT do
 *
 * **It is not a notice.** A notice is the room speaking for itself about a turn
 * that could not run (`notices/notice-log.ts`). This is the agent saying something,
 * so it is written under the agent's own author id and reads like every other
 * message it sends.
 *
 * **It does not reset a reply budget.** The post carries no `trigger`, so
 * `deriveCascade` stamps it — like any other un-provenanced agent post — at the
 * cascade ceiling. The entry is durable and readable; anything it happened to
 * address would be refused by the depth rule rather than silently spending a
 * turn. That is exactly the property a notification wants: it informs the
 * person, and it cannot start a conversation between agents. (An agent that IS
 * mid-turn inherits that turn's cascade through `activeTurnFor`, which bounds it
 * under the same budget the turn is already spending — also correct.) In a 1:1
 * DM the point is close to moot: the only other member is a person, and people
 * are never dispatched to.
 *
 * **It never throws.** Every failure — an agent the mesh cannot place, a mesh
 * read that throws under a concurrent write, a room that refuses — is caught,
 * logged loudly and reported as a structured outcome. A notification is the
 * least important thing an agent is doing when it calls this, and it must never
 * be able to fail the call that reached it.
 *
 * ## One thing it does that is a decision, not an accident
 *
 * **An ARCHIVED DM is un-archived and reused.** `createRoom`'s DM branch
 * un-archives whatever it matched, so a conversation the person tidied away
 * comes back when that agent next has something to say. It is worth naming
 * because the alternative reading is defensible — archiving is a person's
 * signal, and reviving it uninvited overrides one. It stays because a message
 * that reaches nobody is the worse failure of the two (the same posture
 * `.claude/rules/room-conduct.md` takes on silence), and because the honest fix
 * is consent rather than a second hidden room: whether quiet hours or a
 * declined delivery should suppress the un-archive is Q9 in
 * `specs/proactive-agent-dms/01-ideation.md`, for the phase that adds them.
 *
 * @module services/relay/notify-dm
 */
import type { CreateRoomRequest } from '@dorkos/shared/room-schemas';
import { createTaggedLogger } from '../../lib/logger.js';

/**
 * The rooms surface this writes through — the two public verbs of
 * `RoomService`, narrowed to what a notification needs.
 *
 * Narrow on purpose: this module may open a DM and post into it, and nothing
 * else. Handing it the whole service would put archiving, roster changes and
 * the notice log one autocomplete away from a code path whose entire job is to
 * say one sentence.
 */
export interface NotifyDmRooms {
  createRoom(request: CreateRoomRequest, creatorAuthorId: string): { id: string };
  post(roomId: string, input: { authorId: string; text: string }): { id: string };
}

/** The author-registry surface — resolving the sending agent's own identity. */
export interface NotifyDmAuthors {
  resolveAgent(agentPath: string, displayName: string): { id: string };
}

/**
 * The mesh surface — placing a relay agent id on disk, which is what an author
 * row keys on (ADR 260726-170126: identity is the directory, never the ULID).
 */
export interface NotifyDmMesh {
  getProjectPath(agentId: string): string | undefined;
  get(agentId: string): { name: string; displayName?: string } | undefined;
}

/** Structured logger surface (a consola instance satisfies this). */
export interface NotifyDmLogger {
  warn: (...args: unknown[]) => void;
}

/** Dependencies for {@link deliverNotifyDm}. */
export interface NotifyDmDeps {
  rooms: NotifyDmRooms;
  authors: NotifyDmAuthors;
  mesh: NotifyDmMesh;
  /**
   * The install owner's author id, resolved per call rather than captured — an
   * install becomes owned partway through its life (the enable-login flow), so
   * a value read once at boot would keep naming the unbound `'local'` author
   * forever. Same reasoning as `resolveOperatorAuthorId` in the server's own
   * bootstrap, which is what gets passed here.
   */
  operatorAuthorId: () => string;
  logger?: NotifyDmLogger;
}

/**
 * Where the message went, or why it could not go anywhere.
 *
 * `AGENT_NOT_RESOLVABLE` and `DM_UNAVAILABLE` are both non-delivery, and they
 * are kept apart because they mean different things to whoever reads the log: a
 * sender the mesh cannot place is an identity problem, and a room that refused
 * the write is a rooms problem.
 */
export type NotifyDmOutcome =
  | { ok: true; roomId: string; entryId: string }
  | { ok: false; reason: 'AGENT_NOT_RESOLVABLE' }
  | { ok: false; reason: 'DM_UNAVAILABLE'; error: string };

/**
 * Put a proactive agent message in the agent's direct message with the
 * operator, opening that conversation once if it does not exist yet.
 *
 * @param input.agentId - The mesh id of the agent doing the notifying, as the
 *   server resolved it — never a value the model supplied.
 * @param input.message - What the agent wants the person to read.
 * @param deps - Rooms, authors, mesh and the owner's author id.
 * @returns Where it landed, or a structured reason it did not. Never throws.
 */
export function deliverNotifyDm(
  input: { agentId: string; message: string },
  deps: NotifyDmDeps
): NotifyDmOutcome {
  const log = deps.logger ?? createTaggedLogger('NotifyDM');
  // **Everything is inside this try, the mesh reads included.** They read the
  // `agents` table, so `SQLITE_BUSY` under a concurrent write is a throw — and
  // outside the try it would leave `relay_notify_user` throwing instead of
  // answering, which is worse than the silence this whole module replaces. The
  // contract is "never throws", and a contract that holds only for the calls
  // somebody remembered to wrap is not one.
  let agentPath: string | undefined;
  try {
    agentPath = deps.mesh.getProjectPath(input.agentId);
    const manifest = deps.mesh.get(input.agentId);
    if (!agentPath || !manifest) {
      // Loud rather than debug: an agent that reached this tool IS registered,
      // so a mesh that cannot place it is a real inconsistency, and the symptom
      // the person sees — a notification that never arrives — says nothing
      // about it.
      log.warn(
        '[Relay] a proactive message had nowhere to go: the mesh could not place its sender',
        {
          agentId: input.agentId,
          hasPath: Boolean(agentPath),
          hasManifest: Boolean(manifest),
        }
      );
      return { ok: false, reason: 'AGENT_NOT_RESOLVABLE' };
    }

    const displayName = manifest.displayName ?? manifest.name;
    const author = deps.authors.resolveAgent(agentPath, displayName);
    // Idempotent on the member set: the DM the cockpit already opened for these
    // two is returned (and un-archived) rather than a second one beside it, so
    // notifications collect in the conversation the person knows about.
    //
    // The agent creates it, and that is legal without the operator asking
    // because `requireSeedingAllowed` only engages when a roster holds an agent
    // OTHER than its creator — this one holds the sender and the person it is
    // speaking to, and nobody else. That was true before DOR-1208 widened the
    // rule (an agent may now seat another agent in a room the owner is also in)
    // and is true after it, for the same reason rather than by the new
    // allowance: there is no second agent here to weigh.
    const room = deps.rooms.createRoom(
      { kind: 'dm', title: displayName, members: [deps.operatorAuthorId()], agentPaths: [] },
      author.id
    );
    const entry = deps.rooms.post(room.id, { authorId: author.id, text: input.message });
    return { ok: true, roomId: room.id, entryId: entry.id };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn('[Relay] a proactive message could not be delivered to a direct message', {
      agentId: input.agentId,
      // Undefined when the mesh read itself threw — which is information, not a
      // gap: it says the failure was before this sender was ever placed.
      agentPath,
      error,
    });
    return { ok: false, reason: 'DM_UNAVAILABLE', error };
  }
}

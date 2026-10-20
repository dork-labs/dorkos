/**
 * Who a room capability is acting for, as a room author (moved out of
 * `room-capabilities.ts`, which re-exports it).
 *
 * @module services/rooms/service/room-caller-author
 */
import type { CapabilityHandlerContext } from '../../core/capabilities/index.js';
import { readOwnerAccount } from '../../core/auth/index.js';
import { configManager } from '../../core/config-manager.js';
import type { AuthorRecord } from '../author-registry.js';
import { resolveOperatorAuthor } from '../operator-author.js';
import { RoomError } from '../room-errors.js';
import type { RoomService } from '../room-service.js';

/**
 * Who is calling, as a room author — the same answers `resolveCaller`
 * (`routes/room-caller.ts`) gives the HTTP room routes, asked in the same order.
 *
 * 1. **An agent that presented a VALID identity token** acts as itself. This is
 *    the case every one of these tools is for, and the id is resolved from the
 *    token's `agentPath`, never from a tool argument: an author a caller could
 *    name is an author a caller could impersonate, and every room read is scoped
 *    to the caller's membership, so naming a member would also be a way to read
 *    their rooms.
 * 2. **A caller whose agent token did NOT verify is refused.** A revoked or
 *    expired agent is still an agent, so it must never fall through into the
 *    branches below.
 * 3. **A signed-in person** acts as THEMSELVES — the owner when it is the owner,
 *    and their own author when it is anybody else.
 * 4. **A chat with no agent identity is refused** (DOR-2863). The in-session
 *    server names the calling chat, and a chat speaks for its agent, never for
 *    the person, so the rung below is not open to it.
 * 5. **Nobody the surface could name** is the person at the keyboard, and ONLY
 *    when login is off. With login off there is genuinely nothing left to tell a
 *    local program from the operator (the documented DOR-505 residual, which this
 *    domain cannot close). With login ON, an unattributable caller is refused.
 *
 * **Branch 5's guard is the reason this function exists at all.** It used to
 * resolve every non-agent caller to the install owner unconditionally, which with
 * login on made "authenticated as somebody" mean "acting as the owner": an
 * invited person's API key would read the owner's direct messages and post under
 * the owner's name. The fix is not a narrower fallback but a REFUSAL — falling
 * back to the owner because we could not name the caller is precisely the
 * inference that was wrong, and a login-on install has no honest default.
 *
 * **Branch 2 is the same lesson, learned again on the other axis (DOR-1361).**
 * `context.identity` answers "WHICH agent", and an unverifiable token used to
 * leave it empty — so a revoked agent reached branch 5 and, on the login-OFF
 * default, acted as the operator: `post_to_room` wrote under the person's name
 * and `read_room_history` handed back their rooms. `agentIdentityPresented` is
 * the wider fact the two HTTP surfaces now state, and it is what makes this
 * function agree with `resolveCaller` rather than merely resemble it.
 *
 * **Branch 2 now has TWO ways in, and the second is newer than this text
 * (DOR-486).** A revoked or expired token no longer leaves `context.identity`
 * empty — it fills it with an identity marked `inactive`, because the capability
 * gate has to tell a shut-off agent from a stranger (an unidentified caller gets
 * the widest tier ceiling, so erasing a revoked agent WIDENED it). Presence
 * therefore stopped meaning "verified", and this branch tests the mark as well
 * as the wider fact. Measured with real tokens before the test landed: a revoked
 * token read room history `200`, and an expired one posted `200`.
 *
 * **Exported, and the export is the point** (DOR-2055). The sidebar-section
 * capabilities have to resolve a room reference as the CALLER, and a second
 * copy of this ladder is the copy that gets it wrong — so `index.ts` wires their
 * lookup through this function rather than restating any part of it.
 *
 * @param rooms - The rooms service, for its author registry.
 * @param context - What the registry resolved about this call.
 * @returns The author these verbs act as.
 * @throws {RoomError} `AGENT_IDENTITY_UNVERIFIED` when the caller presented an
 *   agent token this machine could not verify, and `UNIDENTIFIED_CALLER` when
 *   login is on and the surface named neither an agent nor a person.
 */
export function callerAuthor(rooms: RoomService, context: CapabilityHandlerContext): AuthorRecord {
  const registry = rooms.authorRegistry;
  // `!context.identity.inactive` is what keeps branch 2 doing its job through a
  // change one domain over (DOR-486). Resolution used to answer `undefined` for a
  // revoked or expired token, so those callers fell into branch 2 by omission; it
  // now NAMES them, because the capability gate has to tell a shut-off agent from
  // a stranger to stop revocation widening a tier ceiling. Without this test that
  // change would have undone DOR-1361 outright — a revoked token reading room
  // history, an expired one posting — which is the whole defect this function was
  // written to close, arriving through the front door.
  if (context.identity && !context.identity.inactive) {
    return registry.resolveAgent(context.identity.agentPath, context.identity.displayName);
  }
  if (context.identity?.inactive || context.agentIdentityPresented) {
    throw new RoomError(
      'AGENT_IDENTITY_UNVERIFIED',
      'That agent identity could not be verified. Its token may have been revoked, or it may have expired.'
    );
  }

  // **A call from inside a chat is that chat's agent, or nobody (DOR-2863).**
  // The in-session server names the calling chat, and a chat is never the
  // person: what it posts is the model's words, not theirs. One with no agent
  // identity (a chat whose folder belongs to no agent, started by nobody) used
  // to fall through to the last rung and write as the person, which let any
  // chat forge the person's approval in a room's record.
  if (context.sessionId !== undefined) {
    throw new RoomError(
      'UNIDENTIFIED_CALLER',
      'This chat has no agent of its own, so it cannot act in rooms. Start it from an agent.'
    );
  }

  const owner = readOwnerAccount();
  if (context.userId !== undefined) {
    // The owner reaches their author through `bindOwner`, which is what rebinds
    // the unbound `'local'` sentinel onto their account the first time they ask
    // for anything — so turning login on does not strand the rooms they already
    // had. Everybody else gets their own author and nobody else's.
    return context.userId === owner?.id
      ? registry.bindOwner(owner.id)
      : registry.human(context.userId);
  }

  if (loginIsOn()) {
    throw new RoomError(
      'UNIDENTIFIED_CALLER',
      'This DorkOS requires a login, and this call named nobody. Present an agent token or sign in.'
    );
  }
  return resolveOperatorAuthor(registry);
}

/**
 * Whether this install requires a login.
 *
 * Read per call rather than captured, for the reason every other live read in
 * this domain is: an install becomes owned partway through its life, and a value
 * captured at boot would leave the branch above believing forever that anybody
 * may act as the operator.
 *
 * **`=== true`, matching every other reader of this flag** (`mcp-auth.ts`,
 * `room-caller.ts`): an absent `auth` block is the default posture and means
 * login is OFF. Spelling it `!== false` would make a fresh install refuse every
 * call, which is the opposite mistake and just as wrong.
 *
 * **A THROW degrades to ON**, though, and that asymmetry is deliberate: an
 * unreadable config is not evidence that anybody may act as the operator, and
 * the only safe direction to fail here is the one that refuses.
 */
function loginIsOn(): boolean {
  try {
    return configManager.get('auth')?.enabled === true;
  } catch {
    return true;
  }
}

/**
 * Who made a room tool call, as the server verified it (DOR-3107): the session
 * the in-session server vouched for, never an argument, which decides the
 * level the post's turns are held to; and whether a verified agent token stood
 * behind the call (Codex and OpenCode over the external server have one but no
 * session), so its post reads as an own agent's rather than a stranger's.
 *
 * @param context - The capability call's verified context.
 */
export function toolCallerOf(context: { sessionId?: string; identity?: unknown }): {
  callerSessionId?: string;
  callerAgentVerified?: boolean;
} {
  return {
    ...(context.sessionId !== undefined ? { callerSessionId: context.sessionId } : {}),
    ...(context.identity !== undefined ? { callerAgentVerified: true } : {}),
  };
}

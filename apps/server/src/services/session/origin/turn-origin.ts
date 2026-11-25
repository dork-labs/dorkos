/**
 * What kind of thing is starting a session, and how much power its first row
 * is born with.
 *
 * The session-origin overlays beside this file answer a different question:
 * which room or task a listed session belongs to, for the label the app shows.
 *
 * ## Why this exists
 *
 * `RuntimeRegistry.persistSessionRuntime` is the one write that can seed a new
 * session's permission mode, and it used to take that decision as two OPTIONAL
 * arguments — an `interactive` flag and a mode the caller had resolved itself.
 * Optional is the problem: a surface that forgot to say anything about power
 * was indistinguishable from one that had nothing to say, and the answer for a
 * brand-new turn-starting surface was therefore whatever the default happened
 * to be rather than a decision somebody made. Three of the seven call sites
 * passed nothing at all.
 *
 * So the argument is REQUIRED and it is a union, {@link TurnOrigin} (declared in
 * `@dorkos/shared/turn-port`, re-exported here). A new surface cannot reach
 * the seeding write without naming itself, {@link permissionSeedForOrigin}
 * switches exhaustively over the names, and the `never` at the bottom of that
 * switch means adding a member breaks the build until somebody decides what
 * power it starts with (DOR-2105).
 *
 * ## The decision lives here, not at the call site
 *
 * Each member carries only facts its caller knows, and only facts the mapping
 * below actually reads. Turning those facts into a power level is this
 * module's single job, so the answer for "an unattended surface follows the
 * operator's configured stop" is written down once instead of being
 * re-derived, differently, at each call site (which is how a room agent came
 * to stop and ask in the one place nobody is there to answer, DOR-1917).
 *
 * A member is a bare discriminant unless a field changes the answer.
 * `externalAuthor` is the only such field today. Ids that nothing reads are
 * not carried "for later": a required argument nobody uses is a required
 * argument callers guess at.
 *
 * @module services/session/origin/turn-origin
 */
import type { TurnOrigin } from '@dorkos/shared/turn-port';

/**
 * What is starting this session. The union and its per-member docs live in
 * `@dorkos/shared/turn-port`, because the turn port carries an origin as data
 * (spec `turns-survive-restarts` §3.2); it is re-exported here so every
 * caller keeps importing it from this path.
 *
 * Temporary. A space-side file importing it from here imports turn code, so
 * each such import counts against the turn port ratchet's baseline (T5,
 * spec §3.4) and moves to `@dorkos/shared/turn-port` as its caller moves.
 */
export type { TurnOrigin };

/**
 * How much power a new session row gets, and WHEN, given what is starting it.
 *
 * - `'configured-stop'` — resolve the operator's configured trust stop against
 *   the runtime being bound and seed the mode it lands on, whether this call
 *   inserts the row or claims an unbound one somebody's earlier settings
 *   change left behind.
 * - `'configured-stop-on-insert'` — the same stop, but only on a row this call
 *   INSERTS. A row that already exists belongs to a conversation somebody has
 *   already touched, and this origin leaves it alone.
 * - `'none'` — seed nothing at all. The column stays NULL, which means "the
 *   runtime decides" everywhere else in this table.
 *
 * ## Why two "configured stop" values rather than one
 *
 * They differ on one case, and it is a real one: a row with no runtime yet,
 * created by a settings change made before the first message (DOR-812's
 * pre-launch picker, which E3 made the normal way a session starts).
 *
 * For a PERSON that row is their own, from the same sitting, and the stop they
 * configured is the default for the session they are about to start — so the
 * claim seeds it, and always has.
 *
 * For a ROOM that row is evidence the conversation already exists. ADR
 * 260908-170643 promises that "a room conversation that already has settings
 * is untouched", and the room runner used to hold that promise itself by
 * asking whether the session had a row before resolving anything. Moving the
 * decision here without moving that condition would have quietly widened it
 * (DOR-2105 review). So the condition moved too, and it is expressed as the
 * thing it actually is: seed a row nobody has started, never one that exists.
 *
 * Neither value can RAISE a session above what somebody chose: the seed only
 * ever fills a column holding NULL, or one holding a mode the runtime being
 * bound does not declare and therefore cannot run (`claimedPermissionMode`),
 * and the stop it reads is one the operator set through the consent-gated
 * config route.
 */
export type OriginPermissionSeed = 'configured-stop' | 'configured-stop-on-insert' | 'none';

/**
 * The single mapping from a turn origin to the power its session row is born
 * with.
 *
 * Exhaustive by construction: the `never` binding at the bottom fails to
 * compile the moment {@link TurnOrigin} grows a member this switch does not
 * name, so a new turn-starting surface cannot ship without somebody deciding
 * what it starts at.
 *
 * @param origin - What is starting the session.
 * @returns The seeding policy for this origin's permission mode.
 */
export function permissionSeedForOrigin(origin: TurnOrigin): OriginPermissionSeed {
  switch (origin.kind) {
    // A person is holding the stream open, so a stop they configured is one
    // they can answer. This is the path the trust dial was built for, and the
    // one that may also claim a row their own settings change created.
    case 'interactive':
      return 'configured-stop';
    // The owner on the web, with the chat's stream open through the relay. A
    // new chat is born at the operator's configured stop, as one started here
    // is, so the chat is the same chat when its owner comes back to this
    // computer.
    case 'session-relay':
      return 'configured-stop';
    // Nobody is watching a room turn either, and that is the reason it follows
    // the operator's level rather than the reason it may not (ADR
    // 260822-235802 as amended by 260908-170643, DOR-1917). On a NEW row only
    // — see the type's own doc for why a room and a person differ there.
    // A message from off this machine is the exception, and it belongs to the
    // binding it was bridged from.
    case 'room':
      return origin.externalAuthor ? 'none' : 'configured-stop-on-insert';
    // Work an extension started in a brand-new chat in the person's project.
    // The id was minted for this start a moment earlier, so there is no row a
    // person's earlier settings change could have made, and "on insert" is
    // the honest name for it: the operator's configured stop, the same default
    // a new chat of their own gets (spec `full-power-defaults`).
    case 'extension-start':
      return 'configured-stop-on-insert';
    // An agent's beat, in a chat minted for its day (spec `heartbeats` §7.2):
    // the operator's configured stop on a chat nobody started, as a room turn
    // by a local author gets. On insert only, so a beat chat a person already
    // changed the settings of keeps what they chose.
    case 'heartbeat':
      return 'configured-stop-on-insert';
    // A chat another chat's message opens (spec `spin-off-chats`). The
    // dispatcher holds every message-started turn to its sender's level, so
    // the operator's stop here is a ceiling's partner, never a grant on its
    // own: the turn runs at the stricter of the two. On insert only, so an
    // existing chat a person set keeps what they chose. A person who later
    // types into it gets the same stop a chat of their own starts at.
    case 'chat-message':
      return 'configured-stop-on-insert';
    // Everything below seeds nothing, for two different reasons.
    //
    // A schedule's power is already decided and already stored, on the schedule
    // row; the session row has never carried it and making it do so is its own
    // change (DOR-2100).
    //
    // A binding, an agent DM and a connector event each carry a grant somebody
    // set on the thing that triggered them, and an absent grant there is not
    // consent (DOR-604). Seeding the operator's level onto one of these would
    // make a stranger's message strictly more powerful than the grant it
    // arrived under.
    //
    // An agent launching a session does not hand it the operator's trust stop;
    // whatever power it gets is the tool's clamped mode, set on its own.
    //
    // A carry-over's row already holds the source session's model, effort and
    // mode, copied before the send; the origin must not add the operator's stop
    // on top of what the session already had.
    //
    // A resume after an account's reset goes to a session that is already
    // bound: its row is its power, and the origin must not add to it. So does
    // DorkOS carrying on in a bound chat (a verdict, a finished sign-in, work a
    // restart cut short): some of those chats are an agent's or a room's,
    // seeded nothing, and the carry-on must not seed the operator's stop there.
    //
    // An extension's message to an agent is app data. No extension turns the
    // operator's stop into a grant of its own, so the chat it opens is born
    // with nothing seeded, like a connector event's.
    //
    // The harness is not a surface anybody ships to.
    case 'extension-message':
    case 'schedule':
    case 'relay-binding':
    case 'agent-dm':
    case 'outside-sender':
    case 'connector-event':
    case 'agent-launch':
    case 'account-handoff':
    case 'account-resume':
    case 'resume':
    case 'test-harness':
      return 'none';
    default: {
      const unhandled: never = origin;
      throw new Error(`unhandled turn origin: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** The subject prefix the server stamps on a message one of our agents sends. */
const AGENT_SENDER_PREFIX = 'relay.agent.';

/**
 * The sender prefixes a chat binding's own adapters stamp: a person on Telegram
 * or Slack (`relay.human.<platform>.<adapter>...`), or a webhook
 * (`relay.webhook.<adapter>`).
 */
const BINDING_SENDER_PREFIXES = ['relay.human.', 'relay.webhook.'] as const;

/**
 * Who may read a session's transcript, decided by what started it (spec
 * `audit-trail` §3.4). The visibility half of the rule {@link
 * permissionSeedForOrigin} is the power half of, and exhaustive the same way:
 * a new origin does not compile until somebody decides who can read it.
 *
 * - `participants`: a person's own conversation with an agent, in the app or
 *   from a chat app. The person may be thinking aloud; only they (and, until
 *   spaces have more than one person, the owner) read it. The ACTIONS the
 *   agent takes there are still recorded for everyone in the audit log.
 * - `space`: an agent's own work: a room reply, a scheduled run, a beat, a message
 *   from another agent, another chat or an outside sender, something an
 *   extension or a connected app started. Every member, person or agent, may
 *   read it.
 *
 * @param kind - What started the session, as stored (`session_metadata.launch_origin`).
 * @returns Who may read it.
 */
export function sessionVisibilityForOrigin(kind: TurnOrigin['kind']): 'space' | 'participants' {
  switch (kind) {
    case 'interactive':
    case 'session-relay':
    case 'relay-binding':
      return 'participants';
    case 'room':
    case 'schedule':
    case 'heartbeat':
    case 'agent-dm':
    case 'outside-sender':
    case 'connector-event':
    case 'agent-launch':
    case 'extension-start':
    case 'extension-message':
    case 'chat-message':
      return 'space';
    // These never name a session first (they act on one already bound), and
    // the harness is not a real surface: if one ever does, the cautious answer
    // is the private one.
    case 'account-handoff':
    case 'account-resume':
    case 'resume':
    case 'test-harness':
      return 'participants';
    default: {
      const unhandled: never = kind;
      throw new Error(`unhandled turn origin: ${String(unhandled)}`);
    }
  }
}

/**
 * The origin of a message posted to `POST /api/sessions/:id/messages`: a
 * person at the app (`interactive`), or an agent calling the API with its
 * identity (`agent-launch`), whose new chat is its own work rather than a
 * person's private one, and which seeds no operator stop.
 *
 * @param agentCaller - Whether the request presented an agent identity.
 */
export function httpTurnOrigin(agentCaller: boolean): TurnOrigin {
  return agentCaller ? { kind: 'agent-launch' } : { kind: 'interactive' };
}

/**
 * The origin of a conversation a relay message addressed to an agent started,
 * from the sender the server stamped on it: `agent-dm` for one of our agents,
 * `relay-binding` for a chat binding's own adapter (a person on Telegram or
 * Slack, a webhook), `outside-sender` for anybody else (the A2A gateway, an
 * external MCP client).
 *
 * The binding case matters even though the binding's session creator already
 * wrote `relay-binding` first: that write is best-effort, and if it failed this
 * one is the first, and a person's chat from Telegram must not become readable
 * by every agent because of it (spec `audit-trail` §3.4). Both origins seed no
 * permission mode, so the power answer is the same either way.
 *
 * @param from - The envelope's server-stamped sender.
 */
export function relayTurnOrigin(from: string): TurnOrigin {
  if (from.startsWith(AGENT_SENDER_PREFIX)) return { kind: 'agent-dm' };
  if (BINDING_SENDER_PREFIXES.some((prefix) => from.startsWith(prefix))) {
    return { kind: 'relay-binding' };
  }
  return { kind: 'outside-sender' };
}

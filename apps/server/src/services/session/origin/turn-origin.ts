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
 * So the argument is REQUIRED and it is this union. A new surface cannot reach
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

/**
 * What is starting this session, as the thing that knows describes itself.
 *
 * One member per turn-starting surface in the server. None of them names a
 * permission mode: mapping a surface onto a power level is
 * {@link permissionSeedForOrigin}'s job.
 */
export type TurnOrigin =
  /**
   * A person is here, watching. `POST /api/sessions/:id/messages` is the only
   * caller: a message posted there came from somebody holding that session's
   * event stream open, so a stop they configured is a stop they can answer.
   */
  | { readonly kind: 'interactive' }
  /**
   * A room turn — unattended, because a room triggers a turn into the dark.
   *
   * `externalAuthor` says whether the message that triggered it came from
   * somebody off this machine (a bridged Telegram or Slack chat). A bridged
   * chat is a projection of a relay binding into a room, and a binding carries
   * its own grant precisely because nobody picked a level for strangers
   * (DOR-604), so that is the one fact which changes a room's answer.
   */
  | { readonly kind: 'room'; readonly externalAuthor: boolean }
  /**
   * A scheduled task's run, whether the timer fired it or a person pressed
   * "Run now".
   *
   * Seeded with no mode: a run's power comes off
   * `pulse_schedules.permission_mode`, decided once at CREATE, and it reaches
   * the runtime through `ensureSession`/`sendMessage` rather than through this
   * row. Whether it should also reach the row is DOR-2100, which will add
   * whatever it needs to read here.
   */
  | { readonly kind: 'schedule' }
  /**
   * A chat binding created a session for an inbound message — Telegram, Slack,
   * a webhook. The binding carries the grant a person set on it, and an absent
   * grant there is NOT consent (DOR-604), so nothing about the operator's own
   * level may be seeded onto the row.
   */
  | { readonly kind: 'relay-binding' }
  /**
   * One agent addressed another directly over the relay (`relay_send` to a
   * mesh endpoint). Nobody created a session for it and nobody is watching it;
   * like a binding, it carries its own grant and seeds no operator stop.
   */
  | { readonly kind: 'agent-dm' }
  /**
   * A connector event woke an agent up (`services/connectors/events/`). Same
   * rule as a binding: the subscription a person approved is the grant, so the
   * row seeds no operator stop.
   */
  | { readonly kind: 'connector-event' }
  /**
   * An agent started this session through the `session_start` tool. Nobody
   * chose a trust stop for it: the operator's stop is a promise about a person
   * who can answer, and the agent that asked for the session is not that
   * person. Its power comes only from the tool's own clamped `permissionMode`,
   * so the row seeds no operator stop.
   */
  | { readonly kind: 'agent-launch' }
  /**
   * The in-process end-to-end harness, reachable only on a server started with
   * `DORKOS_TEST_RUNTIME`. It drives a runtime tool against a session it binds
   * itself.
   *
   * It is a named member rather than a borrowed one so no production surface's
   * power decision has to describe a test. Exactly one production file uses
   * it, and `__tests__/turn-origin-call-sites.test.ts` is what keeps that
   * true — a unit test that just needs a session bound names the surface it is
   * standing in for instead.
   */
  | { readonly kind: 'test-harness' };

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
    // Nobody is watching a room turn either, and that is the reason it follows
    // the operator's level rather than the reason it may not (ADR
    // 260822-235802 as amended by 260908-170643, DOR-1917). On a NEW row only
    // — see the type's own doc for why a room and a person differ there.
    // A message from off this machine is the exception, and it belongs to the
    // binding it was bridged from.
    case 'room':
      return origin.externalAuthor ? 'none' : 'configured-stop-on-insert';
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
    // The harness is not a surface anybody ships to.
    case 'schedule':
    case 'relay-binding':
    case 'agent-dm':
    case 'connector-event':
    case 'agent-launch':
    case 'test-harness':
      return 'none';
    default: {
      const unhandled: never = origin;
      throw new Error(`unhandled turn origin: ${JSON.stringify(unhandled)}`);
    }
  }
}

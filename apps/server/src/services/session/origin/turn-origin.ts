/**
 * What kind of thing is starting a session, and how much power its first row
 * is born with.
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
 * Each member carries FACTS its caller knows — which room, which task, who
 * wrote the message — and nothing about permissions. Turning those facts into
 * a power level is this module's single job, so the answer for "an unattended
 * surface follows the operator's configured stop" is written down once instead
 * of being re-derived, differently, at each call site (which is how a room
 * agent came to stop and ask in the one place nobody is there to answer,
 * DOR-1917).
 *
 * **Not the session-origin OVERLAYS beside it.** `room-origin-overlay.ts` and
 * its siblings in this directory answer a read-side question: which room or
 * task a listed session belongs to, for the label the app shows. This answers
 * a write-side one, asked once when the session is born, about how much the
 * agent may do without asking. They share the word and nothing else.
 *
 * @module services/session/origin/turn-origin
 */

/**
 * What is starting this session, as the thing that knows describes itself.
 *
 * One member per turn-starting surface in the server. Fields are what that
 * surface actually holds at the moment it binds a session — never a value it
 * would have to invent — and none of them names a permission mode: mapping a
 * surface onto a power level is {@link permissionSeedForOrigin}'s job.
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
   * `roomId` is the room it is answering in. `externalAuthor` says whether the
   * message that triggered it came from somebody off this machine (a bridged
   * Telegram or Slack chat): a bridged chat is a projection of a relay binding
   * into a room, and a binding carries its own grant precisely because nobody
   * picked a level for strangers (DOR-604) — so that is the one fact which
   * changes a room's answer.
   */
  | { readonly kind: 'room'; readonly roomId: string; readonly externalAuthor: boolean }
  /**
   * A scheduled task's run, whether the timer fired it or a person pressed
   * "Run now".
   *
   * The row it binds is seeded with no mode today: a run's power comes off
   * `pulse_schedules.permission_mode`, decided once at CREATE, and it reaches
   * the runtime through `ensureSession`/`sendMessage` rather than through this
   * row. `taskId` is carried anyway because that stored mode is exactly what a
   * later change would map here (DOR-2100, deliberately not implemented in
   * DOR-2105). `runId` names this particular run.
   */
  | { readonly kind: 'schedule'; readonly taskId: string; readonly runId: string }
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
   * rule as a binding: the subscription is the grant, so the row seeds no
   * operator stop. `agentId` is the registered agent the event is notifying.
   */
  | { readonly kind: 'connector-event'; readonly agentId: string }
  /**
   * The in-process end-to-end harness, reachable only on a server started with
   * `DORKOS_TEST_RUNTIME`. It drives a runtime tool against a session it binds
   * itself, and it is named rather than borrowed so no production surface's
   * power decision has to describe it.
   */
  | { readonly kind: 'test-harness' };

/**
 * How much power a new session row gets, given what is starting it.
 *
 * - `'configured-stop'` — resolve the operator's configured trust stop against
 *   the runtime being bound and seed the mode it lands on. Nothing configured,
 *   or a runtime that declares no mode at that stop, still seeds nothing; this
 *   asks the question, it does not force an answer.
 * - `'none'` — seed nothing about power. The column stays NULL, which means
 *   "the runtime decides" everywhere else in this table.
 *
 * Neither value can RAISE a session above what somebody chose: the seed only
 * ever fills a column still holding NULL (`claimedPermissionMode`'s `coalesce`,
 * one layer down), and the stop it reads is one the operator set through the
 * consent-gated config route.
 */
export type OriginPermissionSeed = 'configured-stop' | 'none';

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
    // they can answer. This is the path the trust dial was built for.
    case 'interactive':
      return 'configured-stop';
    // Nobody is watching a room turn either, and that is the reason it follows
    // the operator's level rather than the reason it may not: a person who set
    // every new conversation to full autonomy was getting a room agent that
    // stopped to ask (ADR 260822-235802 as amended by 260908-170643, DOR-1917).
    // A message from off this machine is the exception, and it belongs to the
    // binding it was bridged from.
    case 'room':
      return origin.externalAuthor ? 'none' : 'configured-stop';
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
    // The harness is not a surface anybody ships to.
    case 'schedule':
    case 'relay-binding':
    case 'agent-dm':
    case 'connector-event':
    case 'test-harness':
      return 'none';
    default: {
      const unhandled: never = origin;
      throw new Error(`unhandled turn origin: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * How many proactive notes one agent may send the operator in an hour
 * (DOR-1265).
 *
 * ## Why a bound exists at all
 *
 * `relay_notify_user` is the one verb an agent has that reaches a PERSON without
 * being asked to. Where a note can land is decided entirely by the operator,
 * beforehand, and it is worth being exact about it because the ceiling below is
 * the only thing bounding how OFTEN:
 *
 * - **The operator's own DorkOS DM** — the 1:1 that agent shares with them, used
 *   when no external chat can carry the note (`relay/notify-dm.ts`, DOR-1209).
 * - **Anything inside a binding the operator switched "Agent can start
 *   conversations" on for** — `canInitiate`, per binding, defaults FALSE
 *   (`relay-adapter-schemas.ts`), so a fresh connection sends nothing until a
 *   person turns it on. How WIDE that is, is also the operator's choice, and the
 *   default is wide: a binding with no chat filter — the cockpit's default for a
 *   new binding, "Any chat (wildcard)" — covers **every chat that has messaged
 *   that adapter, claimed or not** (`initiate-consent.ts`: sender scoping does
 *   not narrow it, "because that is the scope the person chose when they left the
 *   chat filter empty"). A binding that names a chat may still name a group or a
 *   conversation with somebody else. The calling agent picks none of this: the
 *   tool's `channel` argument only selects among bindings that already exist and
 *   already consented, and can neither create one nor bypass `canInitiate`.
 *
 * So the ceiling below is not protecting one person's inbox in the abstract. It
 * is bounding how often an agent may speak first anywhere in that scope.
 *
 * Everything else an agent does in a room is bounded by something: a reply
 * spends a turn and turns are counted twice over (`rooms/turn-budget.ts`), a
 * reaction spends an hourly allowance ({@link ReactionBudget}). A note spent
 * nothing. The relay's own per-sender rate limit is not this bound either: its
 * generous 2000-per-minute override keys on the `agent:` prefix, while a
 * proactive note publishes under `relay.agent.*` and so takes the default 100
 * per 60s (`packages/relay/src/rate-limiter.ts`) — a limit for protecting a
 * message bus, not a person — and it never sees the DM fallback at all, which
 * does not go through the bus.
 *
 * That mattered more once the note stopped asking. DOR-1265 put
 * `relay_notify_user` on the identity-scoped auto-allow list, because a card
 * raised for it during a room turn is a card nobody is watching — so the last
 * thing standing between a looping agent and a person's evening was the model's
 * own judgment. This is `I2` from `.claude/rules/room-conduct.md` applied to
 * that verb: the bound is a MECHANISM, not a line in a prompt. "Do not be
 * spammy" is not a rule an agent can follow.
 *
 * ## The grain, and why it is this one
 *
 * Per AGENT per rolling hour, and nothing finer. A reaction is counted per
 * `(room, agent)` because rooms are many and cheap to make; the second axis here
 * would be the destination chat, and counting per chat would make a WILDCARD
 * binding — the default — the cheapest way to spend more, since each new chat
 * would carry a fresh allowance. Counting the sender is the axis an agent cannot
 * widen: ten notes an hour is ten notes an hour whether they all go to one
 * person or to ten chats, and one misconfigured agent spends only its own.
 *
 * **People are never counted.** This bounds the tool, and only an agent calls it.
 *
 * ## What a note costs, and when
 *
 * The reservation is taken immediately before the message is handed to a
 * transport, so a call refused for any OTHER reason — no binding, a named
 * channel that does not exist, an owner who never switched initiating on — costs
 * nothing. Whether a FAILED delivery costs anything depends on which transport,
 * and the split is deliberate ({@link tryDm} states it in full): the local,
 * synchronous DM write is given back when it did not land, because "did it land"
 * has an exact answer there and an agent the mesh cannot place would otherwise
 * burn a person's whole hour on notes nobody received. An external publish is
 * not refunded: it leaves this machine, so a throw is not proof it failed to
 * arrive.
 *
 * ## In memory, and honest about it
 *
 * {@link ReactionBudget} recovers its window from the reaction rows themselves,
 * so a restart cannot clear it. Nothing equivalent exists here: a note delivered
 * to Telegram leaves no durable local row, and a note delivered to the DM is a
 * room entry indistinguishable from anything else that agent said in it. So the
 * window is process memory, and a restart forgets the hour. That is a real
 * residual, and the honest way to close it is a durable record of proactive
 * deliveries — which is the delivery service `specs/proactive-agent-dms` calls
 * for, not a table bolted to a rate limiter.
 *
 * ## The number is ours and unsourced
 *
 * Like every threshold in this domain (`meta/agent-etiquette.md` §9): nobody
 * publishes a figure for how many unprompted messages a person will read from a
 * machine before muting it. It is a constant rather than a setting for the same
 * reason the reaction ceiling is — there is no honest guidance to hand somebody
 * tuning it, and dogfooding evidence is what should buy a setting.
 *
 * @module services/relay/notify-budget
 */

/** One hour, the window the ceiling is denominated in. */
const WINDOW_MS = 60 * 60_000;

/**
 * How many proactive notes one agent may send in an hour.
 *
 * Ten is enough for a working day's worth of real news — a finished job, a
 * blocker, a question — and far too few to sustain a stream. See the module
 * TSDoc: it is ours, and unsourced.
 */
const AGENT_NOTES_PER_HOUR = 10;

/**
 * How many agents to keep windows for before dropping the least recently
 * touched.
 *
 * **A weaker trade than {@link ReactionBudget}'s, and worth saying so.** An
 * evicted reaction pair re-hydrates from the durable reaction rows, so eviction
 * there costs almost nothing. There is nothing to re-read here (see "In memory"
 * below), so an evicted agent comes back with a full hour. Reaching it takes
 * more than 512 DIFFERENT agents each sending a note inside the same hour, on
 * one install, which is far past the point where the ceiling is what the
 * operator has a problem with.
 */
const TRACKED_AGENTS = 512;

/**
 * A rolling count of one agent's proactive notes, held in memory.
 *
 * Insertion-ordered `Map`, so the least recently touched agent is always the
 * first key — which makes eviction one `keys().next()`.
 */
export class NotifyBudget {
  private readonly now: () => number;
  private readonly windowMs: number;
  private readonly limit: () => number;
  private readonly spent = new Map<string, number[]>();

  /**
   * Build a budget. Nothing is read or allocated until the first note.
   *
   * @param opts.limit - The ceiling, read per call so a future setting takes
   *   effect on the next note rather than the next restart.
   * @param opts.now - Clock, injectable so a test can roll the window without
   *   sleeping for an hour.
   * @param opts.windowMs - Window length; defaults to one hour.
   */
  constructor(opts: { limit?: () => number; now?: () => number; windowMs?: number } = {}) {
    this.limit = opts.limit ?? (() => AGENT_NOTES_PER_HOUR);
    this.now = opts.now ?? (() => Date.now());
    this.windowMs = opts.windowMs ?? WINDOW_MS;
  }

  /**
   * Claim one note for an agent, reserving on success.
   *
   * Reserving inside the check is what stops two notes decided in the same tick
   * from both spending the last unit. A refusal spends nothing, so an agent that
   * keeps asking does not push its own window out.
   *
   * @param agentId - The agent sending, as the server resolved it — never a
   *   value the model supplied.
   * @returns `true` when the note may be sent.
   */
  tryReserve(agentId: string): boolean {
    const at = this.now();
    const floor = at - this.windowMs;
    const window = (this.spent.get(agentId) ?? []).filter((t) => t > floor);

    if (window.length >= this.limit()) {
      this.store(agentId, window);
      return false;
    }
    window.push(at);
    this.store(agentId, window);
    return true;
  }

  /**
   * Give back the note a {@link tryReserve} took, for a delivery that provably
   * did not happen.
   *
   * **Only correct with nothing awaited in between.** It drops the most recent
   * timestamp, which is this call's own only because JavaScript ran no other
   * call between the reservation and the failure it is reacting to. The one
   * caller obeys that — `deliverNotifyDm` is synchronous — and a future caller
   * that awaits anything before refunding would be handing back somebody else's
   * note.
   *
   * Refunding nothing is a no-op rather than an error: an agent whose window
   * emptied under it has nothing to give back, and a bound is not a place to
   * throw.
   *
   * @param agentId - The agent whose reservation is being released.
   */
  refund(agentId: string): void {
    const window = this.spent.get(agentId);
    if (!window || window.length === 0) return;
    window.pop();
    this.store(agentId, window);
  }

  /**
   * Write an agent's pruned window back, re-inserting it as most recently used.
   *
   * @param agentId - The agent.
   * @param window - Its timestamps, already pruned to the window.
   */
  private store(agentId: string, window: number[]): void {
    this.spent.delete(agentId);
    this.spent.set(agentId, window);
    if (this.spent.size > TRACKED_AGENTS) {
      const oldest = this.spent.keys().next().value;
      if (oldest !== undefined) this.spent.delete(oldest);
    }
  }
}

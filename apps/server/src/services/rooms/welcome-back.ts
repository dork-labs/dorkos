/**
 * Welcome-back — the news your agents may bring when you come back after being
 * away (spec `team-room-home` D5.2).
 *
 * **The iron rule is news, not noise**, and every bound below is code rather
 * than a sentence in a prompt. Coming back to three useful lines is a welcome;
 * coming back to twelve is a reason to turn the feature off, so the cap is
 * enforced by {@link planWelcomeBack} slicing the list — never by asking an
 * agent to be brief.
 *
 * **What "away" measures, exactly.** The time since the last thing this person
 * demonstrably did on this machine: a read cursor that moved (they read
 * something new, in a room, a chat or the inbox) or a message they wrote in a
 * room. {@link WelcomeBackGreeter.personSeen} is called from the read-state
 * write path, so the signal is a REQUEST the person's own client made, never a
 * tab that happens to be open — a laptop left on a desk goes away, and a person
 * typing in another window does not. Three limits come with that and are worth
 * knowing before trusting the number:
 *
 * 1. **Reading something you have already read is invisible.** A cursor only
 *    moves forward, so re-opening a thread with nothing new in it writes
 *    nothing durable. The in-memory ledger still records the visit, so this
 *    only matters across a restart.
 * 2. **Work outside the cockpit is invisible.** Somebody who spent the morning
 *    in the `claude` CLI reads as away, because nothing they did wrote read
 *    state here.
 * 3. **The durable half is a floor, not the truth.** Across a restart the
 *    ledger is re-seeded from the database ({@link lastPersonSignalAt}), which
 *    can only ever be older than the real last interaction — so a restart can
 *    make an absence look LONGER than it was, never shorter. Erring long is the
 *    safe direction: the failure it buys is one extra greeting, and the
 *    alternative failure is a greeting that never comes.
 *
 * **Cost discipline.** The status lines here are derived from session state and
 * cost nothing: no agent is woken to say what it did, and above all none is
 * woken to say it is still working. Exactly one thing in this module can spend a
 * model turn, it is a switch of its own, and that switch names its cost where a
 * person can read it.
 *
 * **The offer, and why asking is the honest way to find out.** A greeting is
 * worth more when it ends in a decision you can make ("Want me to open the
 * PR?"). This install has no signal that says an agent HAS such a next step —
 * so the choice is to guess, or to ask. Guessing was rejected; asking costs a
 * turn, so it is a switch of its own (`welcomeBack.offersEnabled`, ON by
 * default since DOR-1121, and stating that cost beside itself in Settings).
 * While it is on, the bound is code and not a sentence in a
 * prompt: the ONLY candidates are the agents {@link planWelcomeBack} already
 * chose to greet with — after the `maxPosts` cap, and never an agent with no
 * news — and each one is asked at most once per return. An agent that answers
 * with nothing posts nothing; a turn that fails or is refused is silence, not an
 * apology; a turn that outruns the room's wait is late rather than lost, and
 * posts when it lands. The status lines are posted first and are never withheld
 * waiting for an offer, so the worst an offer can do is not arrive.
 *
 * @module server/services/rooms/welcome-back
 */
import { eq, max, readCursors, roomEntries, type Db } from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../lib/logger.js';
import { MENTION_PATTERN } from './mentions.js';

/** The `welcomeBack` block of user config, as this module reads it. */
export type WelcomeBackSettings = UserConfig['welcomeBack'];

/**
 * What one agent did while the person was away.
 *
 * **Derived from session state, and only from what was actually read.** Every
 * field is a fact off a session listing — how many of this agent's sessions
 * moved in the window, when the last of them moved, what the newest one is
 * called. Nothing here is projected, rounded up, or inferred from a runtime
 * that failed to answer: an agent whose sessions could not be read has no entry
 * at all rather than an entry claiming zero.
 */
export interface AgentAbsenceWork {
  /** The agent's author id in the room it would post into. */
  authorId: string;
  /** The agent's directory — its identity and its working directory. */
  agentPath: string;
  /** How many of its sessions moved while the person was away. Never rounded. */
  sessions: number;
  /** When the last of them moved, ISO-8601. */
  lastActiveAt: string;
  /**
   * The title of the session that moved last, or `null` when none was
   * readable. `null` is honest rather than missing — the line simply says less
   * (see {@link welcomeBackLine}).
   */
  latestTitle: string | null;
}

/**
 * Where the greeter learns what happened while the person was away.
 *
 * A port, because the answer comes from SESSION state and sessions are
 * runtime-owned (ADR-0310) — this domain must not learn to read a transcript.
 * The production implementation is `welcome-back-work.ts`; a test supplies its
 * own and can therefore prove that a disabled feature never asks at all.
 *
 * **Implementations must wake nobody.** Everything an implementation reads is
 * state a session already left behind; running a turn to find out what an agent
 * did would be the speculative spend this whole module exists to avoid.
 */
export interface WelcomeBackWorkSource {
  /**
   * What each agent in this room did since `since`.
   *
   * @param input.roomId - The room whose agent members are the candidates.
   * @param input.since - ISO-8601 instant the person was last seen.
   * @returns One entry per agent that did something, in any order. An agent
   *   with nothing to report is omitted rather than reported with `sessions: 0`.
   */
  since(input: { roomId: string; since: string }): Promise<AgentAbsenceWork[]>;
}

/**
 * Where a greeting learns whether an agent has a next step worth your decision.
 *
 * A port, and a deliberately small one: it runs ONE turn for ONE agent and hands
 * back what it said. The production implementation is `RoomService.askAside`,
 * which puts the turn through the room's own machinery — the `(room, agent)`
 * session, both busy ceilings, the automatic-turn budget and the working
 * indicator. A test supplies its own and can therefore prove the thing that
 * matters most here: that a disabled feature never reaches a runtime at all.
 *
 * **Implementations must never throw and must never post.** Every kind of
 * silence — a busy agent, an exhausted budget, a failed turn, an agent with
 * nothing to offer — is `null`. An answer that outran the room's wait is NOT
 * silence: it is late, so it resolves late and gets posted then, which is the
 * rule every other slow turn in this domain follows. The greeter posts what
 * comes back, through the same guarded path it posts the status lines through.
 */
export interface WelcomeBackOfferSource {
  /**
   * Ask one agent for its next step.
   *
   * @param input.roomId - The room the answer will be posted into.
   * @param input.authorId - The agent being asked.
   * @param input.aboutEntryId - The status line that agent just posted, which is
   *   what the turn is framed around.
   * @param input.prompt - The question, as the model will see it.
   * @returns What it said, or `null` for silence of any kind.
   */
  ask(input: {
    roomId: string;
    authorId: string;
    aboutEntryId: string;
    prompt: string;
  }): Promise<string | null>;
}

/** One line one agent will post. */
export interface WelcomeBackPost {
  /** The agent posting it — the author the room will attribute the line to. */
  authorId: string;
  /** The line, already derived from real state. */
  text: string;
}

/** How long an absence was, and when it started. */
export interface PersonReturn {
  /** The person who came back. */
  userId: string;
  /** How long they had been gone, in milliseconds. */
  awayMs: number;
  /** When they were last seen, ISO-8601 — the window the news is read from. */
  awaySince: string;
}

/**
 * The most of a session title one line will quote.
 *
 * Sixty characters, the same budget the room's late-answer prefix gives a
 * quoted question, and for the same reason: it has to sit inside a sentence
 * somebody reads at a glance.
 */
const TITLE_LIMIT = 60;

/**
 * One session title, short enough to sit inside a sentence, unable to address
 * anybody, and unable to end the block it is quoted in.
 *
 * **A session title is a LABEL somebody else's model wrote**, and both places it
 * lands are lines DorkOS wrote around it: a status line inside the room's
 * untrusted fence, and the offer prompt, which is not fenced at all. So it goes
 * through `sanitizeIdentity` first — the one sanitizer this domain has for that
 * job (`.claude/rules/room-conduct.md`), which drops every angle bracket and
 * every control character, NEL included. Writing a second one here is exactly
 * the mistake that rule names: the second copy is the one that misses NEL, and
 * the two escapes below only ever handled `@` and `"`.
 *
 * **The `@` sigils go too, and that is not cosmetic.** This line is written into
 * a real post whose mentions are resolved at write time — so a session called
 * "@ana's refactor" would address Ana with a message she was never part of.
 * Quote marks are dropped for the reason the room's late-answer excerpt drops
 * them: the title lands inside a quoted clause.
 *
 * @param title - The title as the runtime reported it.
 * @returns The safe, short form. Empty when nothing survives sanitizing, which
 *   the callers read as "no title" — see {@link welcomeBackLine}.
 */
function quoteTitle(title: string): string {
  // Capped by `TITLE_LIMIT` below rather than by the identity default, so the
  // sanitizer is asked only for safety and this file keeps its own length rule.
  const safe = sanitizeIdentity(title, Number.MAX_SAFE_INTEGER) ?? '';
  const flat = safe.replace(/"/g, '').replace(MENTION_PATTERN, '$1').trim();
  return flat.length <= TITLE_LIMIT ? flat : `${flat.slice(0, TITLE_LIMIT).trimEnd()}…`;
}

/**
 * How long a stretch of time was, in words a person reads at a glance.
 *
 * Deliberately coarse and deliberately rounded DOWN through the unit it lands
 * in: "3 hours" for anything between three and four. A greeting that rounded up
 * would tell somebody their agent worked more recently than it did, which is the
 * one direction this must not be wrong in.
 *
 * @param ms - The span, in milliseconds. Negative collapses to the smallest
 *   answer, which is what a clock that stepped backwards deserves.
 */
function describeSpan(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'less than a minute';
  if (minutes === 1) return 'a minute';
  if (minutes < 60) return `${minutes} minutes`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'an hour';
  if (hours < 24) return `${hours} hours`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'a day' : `${days} days`;
}

/**
 * How long ago something happened, from {@link describeSpan}.
 *
 * @param ms - How long ago, in milliseconds. Negative reads as "just now".
 */
function describeAgo(ms: number): string {
  const span = describeSpan(ms);
  return span === 'less than a minute' ? 'just now' : `${span} ago`;
}

/**
 * The one line an agent posts, built from what it actually did.
 *
 * **Generated from real state, never templated optimism.** There is no branch
 * here that says an agent is nearly finished, or that it is still working, or
 * that anything went well — those are claims this module cannot check. It says
 * how much moved and when, and stops.
 *
 * @param work - What this agent did while the person was away.
 * @param now - Epoch ms to measure "ago" against, injected so the copy is
 *   deterministic in a test.
 */
export function welcomeBackLine(work: AgentAbsenceWork, now: number): string {
  const ago = describeAgo(now - Date.parse(work.lastActiveAt));
  const title = work.latestTitle === null ? null : quoteTitle(work.latestTitle);
  if (work.sessions === 1) {
    return title
      ? `Worked on "${title}" while you were away. Last change ${ago}.`
      : `Worked on one session while you were away. Last change ${ago}.`;
  }
  return title
    ? `Worked on ${work.sessions} sessions while you were away. The most recent was "${title}", last changed ${ago}.`
    : `Worked on ${work.sessions} sessions while you were away. Last change ${ago}.`;
}

/**
 * The question one agent is asked when offers are on.
 *
 * **It states facts and asks for one line.** Every number in it is one this
 * module already had, off the same session listing the status line was built
 * from — nothing here is inferred, and nothing invites the agent to summarize
 * its work again, because it has just posted that summary and the room can see
 * it. The instruction is the whole of the conduct: exactly one next step, or
 * nothing at all. Silence is a first-class answer and is named as one, because
 * an agent that thinks it owes a reply will write one.
 *
 * A prompt is not a bound and is not treated as one: what stops this costing
 * more than one turn per agent is the loop in {@link WelcomeBackGreeter.greet},
 * and what stops the answer starting a conversation is the cascade ceiling the
 * post is stamped with. This only decides what is asked.
 *
 * @param work - What this agent did while the person was away.
 * @param ret - The absence that just ended.
 * @param now - Epoch ms, so the copy is deterministic in a test.
 */
export function welcomeBackOfferPrompt(
  work: AgentAbsenceWork,
  ret: PersonReturn,
  now: number
): string {
  const away = describeSpan(ret.awayMs);
  const ago = describeAgo(now - Date.parse(work.lastActiveAt));
  // Empty is "no title", not an empty pair of quotes: a title can arrive as
  // `null` from the listing, and it can also SANITIZE to nothing (a title made
  // entirely of angle brackets). Both say the same thing, so both read the same.
  const title = work.latestTitle === null ? '' : quoteTitle(work.latestTitle);
  const moved =
    work.sessions === 1
      ? `one of your sessions moved${title === '' ? '' : `, on "${title}"`}, last changed ${ago}`
      : `${work.sessions} of your sessions moved${title === '' ? '' : `; the most recent was "${title}"`}, last changed ${ago}`;
  return [
    `The person you work with has just come back after being away for ${away}. While they were away, ${moved}.`,
    'You have already posted that summary to the team channel, so do not repeat it and do not describe your work again.',
    'If you have exactly one genuine next step that needs the person’s decision, state it in one short line. If you do not, output nothing.',
  ].join('\n\n');
}

/**
 * Order candidates by usefulness, and only then by recency.
 *
 * "Usefulness" here is how much of this person's work actually moved: an agent
 * that ran four sessions has more to tell them than one that touched a single
 * session a minute ago. Recency breaks the tie, and the author id breaks that,
 * so two installs holding the same rows produce the same greeting rather than
 * whichever order the listing happened to arrive in.
 *
 * @param work - The candidates, in any order.
 * @returns A new array, most useful first.
 */
function rankAbsenceWork(work: readonly AgentAbsenceWork[]): AgentAbsenceWork[] {
  return [...work].sort((a, b) => {
    if (a.sessions !== b.sessions) return b.sessions - a.sessions;
    const recency = Date.parse(b.lastActiveAt) - Date.parse(a.lastActiveAt);
    if (recency !== 0) return recency;
    return a.authorId.localeCompare(b.authorId);
  });
}

/**
 * Decide what gets posted for one return — the whole gate, as a pure function.
 *
 * **This is where the caps are.** `enabled`, the absence threshold and
 * `maxPosts` are all applied here, on data, so the bound cannot be talked out
 * of: an agent has no way to ask for a second line, and a hundred qualifying
 * agents produce `maxPosts` posts. `maxPosts: 0` is a legitimate setting and
 * produces silence with the feature still on.
 *
 * @param input.settings - The live `welcomeBack` block.
 * @param input.awayMs - How long the person was gone.
 * @param input.work - What each agent did in that window.
 * @param input.now - Epoch ms, for the copy's "ago".
 * @returns The posts to write, in the order to write them. Empty is the
 *   ordinary answer.
 */
export function planWelcomeBack(input: {
  settings: WelcomeBackSettings;
  awayMs: number;
  work: readonly AgentAbsenceWork[];
  now: number;
}): WelcomeBackPost[] {
  const { settings } = input;
  if (!settings.enabled) return [];
  if (input.awayMs < settings.absenceThresholdMinutes * 60_000) return [];
  // A real status delta, and nothing else, is a reason to speak. An agent that
  // did nothing new says nothing — which is most agents, most mornings.
  const withNews = input.work.filter((work) => work.sessions > 0);
  return rankAbsenceWork(withNews)
    .slice(0, Math.max(0, settings.maxPosts))
    .map((work) => ({ authorId: work.authorId, text: welcomeBackLine(work, input.now) }));
}

/**
 * The last durable trace this person left on this machine, or `null` when they
 * have left none.
 *
 * Two facts, whichever is newer: a read cursor that moved (they read something
 * new — a room, a chat, the inbox) and the last message they wrote in a room.
 * Both are written by the person's own client on the request path, so both
 * measure a real interaction rather than an open tab.
 *
 * `null` means "this install has never seen this person do anything", which is
 * not an absence: somebody who has never been here has not come back, and
 * {@link AbsenceLedger.see} answers accordingly.
 *
 * @param db - The consolidated DB handle.
 * @param userId - The person's AUTHOR id (`authors.id`), which is what
 *   `read_cursors.user_id` stores — never the Better Auth account id.
 */
export function lastPersonSignalAt(db: Db, userId: string): string | null {
  const read =
    db
      .select({ at: max(readCursors.updatedAt) })
      .from(readCursors)
      .where(eq(readCursors.userId, userId))
      .get()?.at ?? null;
  const said =
    db
      .select({ at: max(roomEntries.createdAt) })
      .from(roomEntries)
      .where(eq(roomEntries.authorId, userId))
      .get()?.at ?? null;
  if (read === null) return said;
  if (said === null) return read;
  return Date.parse(read) >= Date.parse(said) ? read : said;
}

/**
 * When each person was last seen, and how long they had been gone.
 *
 * In memory, seeded from the database the first time it is asked about
 * somebody. The split is deliberate: the durable half is what survives a
 * restart mid-absence (a server that came up an hour ago must not believe
 * everybody has been here all along), and the in-memory half is what makes two
 * returns a minute apart ONE return — the second one measures a minute, not the
 * morning.
 *
 * Bounded by the number of people on this install, which is one on almost every
 * one of them.
 */
export class AbsenceLedger {
  private readonly lastSeen = new Map<string, number>();

  /**
   * Binds the ledger to its durable seed.
   *
   * @param durable - The last durable trace of a person, e.g.
   *   {@link lastPersonSignalAt} bound to the database.
   */
  constructor(private readonly durable: (userId: string) => string | null) {}

  /**
   * Record that this person is here now, and answer how long they had been
   * away.
   *
   * **Call it BEFORE the write that records this visit**, whatever that write
   * is — the durable seed is read here, so a cursor already advanced to now
   * would make every first return after a restart measure zero.
   *
   * @param userId - The person's author id.
   * @param nowMs - Epoch ms of this visit.
   * @returns The absence that just ended, or `null` when there is nothing to
   *   measure: a person this install has never seen, or a clock that stepped
   *   backwards.
   */
  see(userId: string, nowMs: number): { awayMs: number; awaySince: string } | null {
    const remembered = this.lastSeen.get(userId);
    const seed = remembered ?? this.seedFor(userId);
    this.lastSeen.set(userId, nowMs);
    if (seed === null) return null;
    const awayMs = nowMs - seed;
    if (awayMs <= 0) return null;
    return { awayMs, awaySince: new Date(seed).toISOString() };
  }

  /** The durable seed as epoch ms, or `null` when there is none to read. */
  private seedFor(userId: string): number | null {
    const at = this.durable(userId);
    if (at === null) return null;
    const parsed = Date.parse(at);
    return Number.isNaN(parsed) ? null : parsed;
  }
}

/** Everything the greeter needs, and nothing about how any of it is stored. */
export interface WelcomeBackDeps {
  /**
   * The live `welcomeBack` block. Read per return, never captured: turning the
   * feature off in Settings has to bind the very next return, not the next
   * server start.
   */
  settings(): WelcomeBackSettings;
  /** The room the news goes into (#team), or `null` on an install without one. */
  teamRoomId(): string | null;
  /** What each agent did while the person was away. */
  work: WelcomeBackWorkSource;
  /**
   * Post one line as one agent — the NORMAL guarded post path, so the
   * membership check, the cascade stamp and the turn budget bind these exactly
   * as they bind anything else that agent says.
   *
   * @returns The id of the entry that was written, which is what an offer turn
   *   is framed around.
   */
  post(roomId: string, input: { authorId: string; text: string }): string;
  /**
   * How an agent is asked whether it has a next step, when
   * `welcomeBack.offersEnabled` says it may be.
   *
   * Optional, and absent means no offers ever — the honest answer for a surface
   * with no room turn machinery behind it (the embedded transport, a test that
   * wired only what it needed). A greeting still happens; the extra does not.
   */
  offers?: WelcomeBackOfferSource;
  /** The person's last durable trace, e.g. {@link lastPersonSignalAt}. */
  lastSeenAt(userId: string): string | null;
  /** Epoch ms. Injected so a test owns the clock. */
  now?(): number;
}

/**
 * Greets a person coming back to #team, once, with at most `maxPosts` lines.
 *
 * **The status lines wake nobody.** They are composed from session state and
 * written through the ordinary post path, so a welcome-back post is an
 * agent-authored entry with no trigger behind it — which the shipped cascade
 * stamp puts AT the ceiling (`deriveCascade`), and the fallback seat stands
 * down for. Both mechanisms already ship and both are load-bearing here: they
 * are why three agents posting good morning cannot become three agents
 * answering each other.
 *
 * **The offers do wake one agent apiece, and only when switched on.** They ride
 * the same two mechanisms — an offer is posted un-provenanced exactly like a
 * status line — so what changes is the spend, never the quiet.
 */
export class WelcomeBackGreeter {
  private readonly ledger: AbsenceLedger;

  /**
   * Binds the greeter to its room, its config and its news source.
   *
   * @param deps - See {@link WelcomeBackDeps}.
   */
  constructor(private readonly deps: WelcomeBackDeps) {
    this.ledger = new AbsenceLedger(deps.lastSeenAt);
  }

  /**
   * Tell the greeter this person is here — the single entry point.
   *
   * Returns immediately: deciding costs one indexed read, and the posting that
   * may follow rides its own promise so a person's request never waits on a
   * session listing. Never throws into the caller for the same reason a room
   * notice never does — a greeting that failed must not fail the request that
   * revealed it.
   *
   * **Call it before the write that records the visit** (see
   * {@link AbsenceLedger.see}).
   *
   * @param userId - The person's author id, as `resolveCaller` reports it.
   */
  personSeen(userId: string): void {
    // The gate that costs nothing, first: `enabled: false` means no posts AND
    // no work done to decide there was nothing to post, so this returns before
    // the ledger is even consulted.
    if (!this.deps.settings().enabled) return;
    const away = this.ledger.see(userId, this.now());
    if (!away) return;
    void this.greet({ userId, ...away });
  }

  /**
   * Write the news for one return.
   *
   * Separate from {@link WelcomeBackGreeter.personSeen} so the async half is
   * nameable in a test, and so the synchronous half — the part that must run
   * before the caller's own write — is unmistakably synchronous.
   *
   * @param ret - The absence that just ended.
   * @returns The posts that were written, for tests and for callers that want
   *   to wait.
   */
  async greet(ret: PersonReturn): Promise<WelcomeBackPost[]> {
    const settings = this.deps.settings();
    // Re-read rather than trusting the value `personSeen` saw: the two are
    // separated by an await, and a person turning the feature off in that
    // window means it is off.
    if (!settings.enabled || settings.maxPosts === 0) return [];
    const roomId = this.deps.teamRoomId();
    if (roomId === null) return [];

    let work: AgentAbsenceWork[];
    try {
      work = await this.deps.work.since({ roomId, since: ret.awaySince });
    } catch (err) {
      // A listing that could not be read is not news. Saying nothing is the
      // right failure: the alternative is a greeting that describes a morning
      // this install cannot actually vouch for.
      logger.warn('[rooms] welcome-back could not read what happened while you were away', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    const posts = planWelcomeBack({ settings, awayMs: ret.awayMs, work, now: this.now() });
    const byAuthor = new Map(work.map((entry) => [entry.authorId, entry]));
    const written: WelcomeBackPost[] = [];
    // The agents that actually got a line into the room, paired with the entry
    // that line became. This — after the threshold, after the delta filter,
    // after `maxPosts` — is the entire candidate set for an offer. There is no
    // path from "in this room" to "asked a question"; only from "had news worth
    // a line" to it.
    const greeted: Array<{ post: WelcomeBackPost; entryId: string; work: AgentAbsenceWork }> = [];
    for (const post of posts) {
      try {
        const entryId = this.deps.post(roomId, post);
        written.push(post);
        const theirs = byAuthor.get(post.authorId);
        if (theirs) greeted.push({ post, entryId, work: theirs });
      } catch (err) {
        // One agent that cannot post (it left the room between the listing and
        // here) costs its own line and nobody else's.
        logger.warn('[rooms] a welcome-back line could not be posted', {
          roomId,
          authorId: post.authorId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return [...written, ...(await this.offer({ settings, roomId, ret, greeted }))];
  }

  /**
   * Ask the agents that just spoke whether any of them has a next step, and post
   * the ones that do.
   *
   * **Additive, never a replacement.** It runs after every status line is on the
   * log, so a person who came back has already been told what happened whatever
   * this produces — including nothing, which is the ordinary outcome and the
   * one it must be cheap to reach.
   *
   * **One turn per candidate, and the candidates are already capped.** Each
   * agent is asked once; the loop is the bound, so no prompt has to ask an agent
   * to restrain itself. They run concurrently because they are different agents
   * in different working directories, and because a person should not wait on
   * the slowest of them to hear from the fastest.
   *
   * @param opts.greeted - The agents that got a line in, and the entries those
   *   lines became.
   * @returns The offers that were posted, in the order they landed.
   */
  private async offer(opts: {
    settings: WelcomeBackSettings;
    roomId: string;
    ret: PersonReturn;
    greeted: ReadonlyArray<{ post: WelcomeBackPost; entryId: string; work: AgentAbsenceWork }>;
  }): Promise<WelcomeBackPost[]> {
    const { offers } = this.deps;
    // Read from the settings this return already resolved, so the switch is
    // answered once per greeting rather than once per agent — and checked
    // BEFORE anything else, so `offersEnabled: false` reaches no runtime, mints
    // no prompt, and asks nothing.
    if (!opts.settings.offersEnabled || offers === undefined) return [];
    const offered = await Promise.all(
      opts.greeted.map((candidate) => this.offerOne({ ...opts, candidate, offers }))
    );
    return offered.filter((post): post is WelcomeBackPost => post !== null);
  }

  /**
   * One agent's offer: ask, and post whatever comes back if anything does.
   *
   * Every failure is this agent's alone — a throw out of the seam, or a post the
   * room refuses — because the whole point of a welcome is that it survives one
   * agent having a bad morning.
   *
   * @param opts.candidate - The agent, its news, and the line it just posted.
   * @returns The offer that was posted, or `null` for silence.
   */
  private async offerOne(opts: {
    roomId: string;
    ret: PersonReturn;
    offers: WelcomeBackOfferSource;
    candidate: { post: WelcomeBackPost; entryId: string; work: AgentAbsenceWork };
  }): Promise<WelcomeBackPost | null> {
    const { roomId, candidate } = opts;
    try {
      const said = await opts.offers.ask({
        roomId,
        authorId: candidate.post.authorId,
        aboutEntryId: candidate.entryId,
        prompt: welcomeBackOfferPrompt(candidate.work, opts.ret, this.now()),
      });
      const text = said?.trim();
      // An agent with no next step says nothing, and nothing is what the room
      // gets. This is the outcome the feature is TUNED for, not a failure of it.
      if (text === undefined || text === '') return null;
      const post = { authorId: candidate.post.authorId, text };
      // The same guarded path the status line took, and un-provenanced for the
      // same reason: `deriveCascade` stamps it at the ceiling, so an offer
      // cannot start a conversation and the fallback seat stands down for it.
      this.deps.post(roomId, post);
      return post;
    } catch (err) {
      // Covers both halves: a seam that threw, and a POST the room refused
      // after the offer turn had already released its claim (the agent left the
      // room in between). The second is the one release in this feature that can
      // land with nothing durable beside it, so this line is the whole record of
      // it — deliberately, and written down in `.claude/rules/room-conduct.md`
      // rather than left for somebody to re-derive.
      logger.warn('[rooms] a welcome-back offer was not made', {
        roomId,
        authorId: candidate.post.authorId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Epoch ms, from the injected clock or the real one. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

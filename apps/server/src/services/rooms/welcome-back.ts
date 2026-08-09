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
 * **Cost discipline.** The lines here are derived from session state and cost
 * nothing: no agent is woken to say what it did, and above all none is woken to
 * say it is still working. Spending a model turn is reserved for an agent with
 * a genuine next-step offer to make ("Want me to open the PR?"), and this
 * install has no honest signal that says an agent HAS one without asking it —
 * asking would be the speculative turn the rule forbids. So v1 spends zero
 * turns, structurally: nothing in this module can reach a runtime. The seam a
 * later phase needs is {@link WelcomeBackWorkSource}, which is where a real
 * "this agent is parked on you" signal would arrive.
 *
 * @module server/services/rooms/welcome-back
 */
import { eq, max, readCursors, roomEntries, type Db } from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
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
 * One session title, short enough to sit inside a sentence and unable to
 * address anybody.
 *
 * **The `@` sigils go, and that is not cosmetic.** A session title is text a
 * model wrote, and this line is written into a real post whose mentions are
 * resolved at write time — so a session called "@ana's refactor" would address
 * Ana with a message she was never part of. Whitespace is flattened and quote
 * marks are dropped for the same reason the room's late-answer excerpt drops
 * them: the title lands inside a quoted clause, and a newline in it would break
 * the line it is quoted on.
 *
 * @param title - The title as the runtime reported it.
 */
function quoteTitle(title: string): string {
  const flat = title.replace(/\s+/g, ' ').replace(/"/g, '').replace(MENTION_PATTERN, '$1').trim();
  return flat.length <= TITLE_LIMIT ? flat : `${flat.slice(0, TITLE_LIMIT).trimEnd()}…`;
}

/**
 * How long ago something happened, in words a person reads at a glance.
 *
 * Deliberately coarse and deliberately rounded DOWN through the unit it lands
 * in: "3 hours ago" for anything between three and four. A greeting that
 * rounded up would tell somebody their agent worked more recently than it did,
 * which is the one direction this line must not be wrong in.
 *
 * @param ms - How long ago, in milliseconds. Negative reads as "just now",
 *   which is what a clock that stepped backwards deserves.
 */
function describeAgo(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes === 1) return 'a minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours === 1) return 'an hour ago';
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'a day ago' : `${days} days ago`;
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
   */
  post(roomId: string, input: { authorId: string; text: string }): void;
  /** The person's last durable trace, e.g. {@link lastPersonSignalAt}. */
  lastSeenAt(userId: string): string | null;
  /** Epoch ms. Injected so a test owns the clock. */
  now?(): number;
}

/**
 * Greets a person coming back to #team, once, with at most `maxPosts` lines.
 *
 * **Nothing here wakes an agent.** The lines are composed from session state
 * and written through the ordinary post path, so a welcome-back post is an
 * agent-authored entry with no trigger behind it — which the shipped cascade
 * stamp puts AT the ceiling (`deriveCascade`), and the fallback seat stands
 * down for. Both mechanisms already ship and both are load-bearing here: they
 * are why three agents posting good morning cannot become three agents
 * answering each other.
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
    const written: WelcomeBackPost[] = [];
    for (const post of posts) {
      try {
        this.deps.post(roomId, post);
        written.push(post);
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
    return written;
  }

  /** Epoch ms, from the injected clock or the real one. */
  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }
}

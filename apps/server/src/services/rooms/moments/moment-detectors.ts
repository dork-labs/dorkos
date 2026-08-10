/**
 * The detectors that decide WHEN #team marks a milestone (team-room-home spec
 * D5.1, task 4.2). The post type they mint is task 4.1's; this file is only
 * about noticing.
 *
 * **Three rules bind every detector here, and they are the whole design.**
 *
 * 1. **Real data only.** A detector reads a record this install actually keeps —
 *    the agent registry, the activity log — and prints what it says. Nothing is
 *    invented, rounded, projected, or encouraged. Where no record exists, there
 *    is no detector — see the three this ruled out, below.
 * 2. **Fires once, durably.** The marker is the moment itself. A moment that
 *    landed is a row in `room_entries` carrying `body.moment`, so "has this
 *    already been marked?" is a question about the log, answered by
 *    `RoomStore.hasMoment` — which means a restart, a second process, or a
 *    detector evaluated twice cannot re-post one. **No in-memory state decides
 *    whether a moment may be posted**, and adding some would silently break
 *    that. The one field this class does keep ({@link MomentDetectors.streakReadFor})
 *    only decides whether a READ is worth repeating; losing it costs one query.
 * 3. **No timer.** Every detector runs on an event path that already exists: the
 *    agent-created seam, and activity ingest. Nothing here schedules anything —
 *    a quiet install is quiet, which is the correct behaviour and not a gap.
 *
 * **One moment per pass, at most one an hour, and never more than one in a
 * hundred entries.** `meta/agent-etiquette.md` names over-participation as the
 * failure mode people complain about, and a feature that marks milestones is
 * exactly where a burst comes from: install an agent pack and five agents are
 * created in ten seconds. So a pass posts the FIRST candidate that qualifies and
 * stops, and a pass inside {@link MOMENT_QUIET_PERIOD_MS} of the room's last
 * moment posts nothing at all. That hour is measured over the newest
 * {@link QUIET_SCAN_ENTRIES} entries only, which makes the rule the pair of them
 * together: a moment needs both an hour and a hundred entries of daylight behind
 * it, and a room busy enough to move a hundred entries within the hour is one
 * where the older moment has long scrolled away. Suppressed candidates are
 * **dropped, not queued**: a milestone that arrives an hour after the thing it
 * marks is not news, and a queue would turn one busy minute into an hour of
 * trickle.
 *
 * **Three milestones spec D5.1 lists are deliberately NOT detected here**, each
 * for the same reason — rule 1 leaves nothing to read:
 *
 * - **First PR shipped.** Nothing in this install keeps a record of a pull
 *   request: no table, no activity event, no runtime signal. Watching a git
 *   remote to invent one would be a detector reading the world instead of this
 *   install's own log.
 * - **100th session / 1000th message.** Session storage is runtime-owned (there
 *   is no unified transcript store, ADR-0310), so a session count is an
 *   aggregate that degrades per runtime — a number that might be wrong is worse
 *   than no moment. Room messages have a count but no ingest seam a detector can
 *   ride without putting a query on every post.
 * - **"Busiest day yet".** The activity log is pruned on a retention window (30
 *   days by default), so "yet" would silently mean "since whatever we still
 *   have". The weekly volume mark below counts a window that fits inside every
 *   retention setting, which is why it is the one that ships.
 *
 * None of the three is stubbed and none is a TODO: the moment kinds exist in
 * `RoomMomentKindSchema` already, so each is a small addition here on the day a
 * record appears to read.
 *
 * @module server/services/rooms/moments/moment-detectors
 */
import type { ActivityItem } from '@dorkos/shared/activity-schemas';
import type { RoomMoment, RoomMomentKind } from '@dorkos/shared/room-schemas';
import { logger } from '../../../lib/logger.js';
import {
  anniversaryText,
  firstAgentText,
  firstConnectionText,
  firstOvernightRunText,
  firstScheduleText,
  joinedTeamText,
  weeklyStreakText,
} from './moment-copy.js';

/**
 * How long the room stays quiet after marking something, in milliseconds.
 *
 * An hour, and the number matters less than the shape: it makes a burst of
 * qualifying events produce ONE post. Raising it makes the room quieter and
 * loses milestones; lowering it lets a busy afternoon fill the feed with them.
 */
const MOMENT_QUIET_PERIOD_MS = 60 * 60 * 1000;

/**
 * How many of the room's newest entries the quiet check reads.
 *
 * Bounded on purpose: "when did this room last mark something?" over the whole
 * log is a scan that gets slower with every message, and this runs on every
 * activity event. Bounded it costs **0.026ms**, flat, however long the room gets.
 *
 * It is worth being precise about what this bound did NOT fix, because the
 * comment here used to take the credit. The cost that actually mattered on this
 * path was {@link MomentFacts.dailyActivity} — an unbounded aggregate over the
 * activity log, measured at **5.64ms per event at 60k rows and rising linearly**,
 * paid on every event in the steady state. What fixed that was asking the
 * question once a day rather than once an event ({@link MomentDetectors.streakReadFor}),
 * plus checking the durable marker before running it at all.
 */
const QUIET_SCAN_ENTRIES = 100;

/** Hour (inclusive) the night starts, on the server's own clock. */
const OVERNIGHT_FROM_HOUR = 22;

/** Hour (exclusive) the night ends. */
const OVERNIGHT_TO_HOUR = 6;

/** How many consecutive days of activity make the weekly volume mark. */
const STREAK_DAYS = 7;

/**
 * How long after an anniversary it may still be marked, in milliseconds.
 *
 * Two days. Without it, the first activity event on an install that has been
 * running for a year would announce "it's been a week since Nova joined your
 * team" — true once, stale now, and read as a bug. An anniversary nobody was
 * around to notice is one this install lets go.
 */
const ANNIVERSARY_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * The activity categories that count as "something happened here".
 *
 * `config` and `system` are deliberately out. `system.started` fires on every
 * boot and `config.*` fires when you change a setting; counting either would
 * mean a person who restarts the dev server daily has "something running here
 * every day this week", which is precisely the invented number this feature must
 * never post.
 */
export const VOLUME_MARK_CATEGORIES = ['tasks', 'relay', 'agent'] as const;

/** The activity event a schedule's creation writes. */
const SCHEDULE_CREATED = 'tasks.task_created';

/** The activity event a finished, successful scheduled run writes. */
const RUN_SUCCEEDED = 'tasks.run_success';

/** The activity event that records an agent being wired to an outside service. */
const CONNECTION_CREATED = 'config.binding_created';

/** One registered agent, as a detector needs to see it. */
export interface RegisteredAgent {
  /** The agent's directory — the identity rooms key on. */
  path: string;
  /** The agent's name (manifest `name`). */
  name: string;
  /** What a person calls it. */
  displayName: string;
  /** When this install registered it, from the registry row. */
  registeredAt: string;
}

/** How much happened on one local day. */
export interface DayActivity {
  /** The local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** How many qualifying events landed that day. Counted, never estimated. */
  count: number;
  /** When the newest of them happened — a real record time. */
  lastOccurredAt: string;
}

/**
 * The records detectors read. One port, so the detectors stay pure functions of
 * "what is true" and every SQL query lives in `moment-facts.ts`.
 */
export interface MomentFacts {
  /**
   * Every agent this install has registered that is not a system agent, oldest
   * first. DorkBot is excluded at the source: it is created for you on first
   * boot, so "DorkBot joined your team" is not news about your team.
   */
  registeredAgents(): readonly RegisteredAgent[];
  /**
   * How much qualifying activity landed on each of the last `days` local days,
   * oldest first. Days with nothing are omitted, which is what makes a gap in a
   * streak visible.
   *
   * @param opts.days - How many days back to read, including today.
   * @param opts.now - The instant "today" is measured from.
   */
  dailyActivity(opts: { days: number; now: Date }): readonly DayActivity[];
}

/** What identifies a moment for the purpose of "has this already landed?". */
export interface MomentKey {
  /** The moment kind. Alone, this means "once ever, per install". */
  kind: RoomMomentKind;
  /** The record it is about, when the same kind may fire for several. */
  ref?: string;
  /** When it happened, when the same record has several occasions. */
  observedAt?: string;
}

/** A moment a detector wants to post, before anything decides whether it may. */
interface MomentCandidate {
  /** What a person reads. */
  text: string;
  /** What it marks and what it was read from. */
  moment: RoomMoment;
  /** Whose face the feed draws, when the moment is about somebody. */
  subjectAuthorId?: string;
}

/**
 * The room half of a detector's world: where moments go, and what is already
 * there.
 */
export interface MomentRoom {
  /** #team's id, or `null` when this install has not opened it. */
  teamRoomId(): string | null;
  /**
   * Has a moment matching this key already landed in the room? The durable
   * idempotency the whole feature rests on.
   *
   * @param roomId - The room to look in.
   * @param key - What identifies the moment.
   */
  hasMarked(roomId: string, key: MomentKey): boolean;
  /**
   * When the room last marked anything, reading no further back than
   * {@link QUIET_SCAN_ENTRIES} entries.
   *
   * @param roomId - The room to look in.
   * @param scan - How many of the newest entries to read.
   */
  lastMarkedAt(roomId: string, scan: number): string | null;
  /**
   * Post it, through `RoomService.postMoment` — the same write path, the same
   * refusals, no new surface.
   *
   * @param roomId - The room to post in.
   * @param candidate - The moment and its words.
   */
  mark(roomId: string, candidate: MomentCandidate): void;
  /**
   * The author id the feed should draw beside a moment about this agent, or
   * `null` when it cannot be resolved.
   *
   * @param agent - The agent the moment is about.
   */
  agentAuthorId(agent: { path: string; displayName: string }): string | null;
}

/**
 * How an agent arrived on this install's roster.
 *
 * - `'created'` — a person brought a new agent into being (the New Agent flow,
 *   the `create_agent` tool, a marketplace agent install). Its workspace is
 *   scaffolded here and did not exist a moment ago.
 * - `'registered'` — DorkOS took a directory that was already on disk onto its
 *   records: mesh registration by path, the `mesh_register` tool, or a
 *   discovery scan adopting a `.dork/agent.json` it walked past.
 */
export type AgentArrival = 'created' | 'registered';

/** The just-created or just-registered agent, as the agent-created seam reports it. */
export interface CreatedAgent {
  /** Manifest `name`. */
  name: string;
  /** What a person calls it, when it has one. */
  displayName?: string;
  /** Its directory. */
  path: string;
  /**
   * How this agent reached the roster. `'created'` is a new agent workspace
   * coming into being; `'registered'` is DorkOS taking a directory that was
   * already on disk onto its records. Only the first is a moment — see
   * {@link MomentDetectors.agentCreated}.
   */
  origin: AgentArrival;
}

/** What a pass knows before any detector runs. */
interface PassContext {
  roomId: string;
  now: Date;
  /**
   * Has this already been marked? Curried over the room so a detector reads as
   * the question it is asking.
   */
  marked(key: MomentKey): boolean;
}

/**
 * The moment detectors, wired to one install.
 *
 * Both entry points are **fire-and-forget and never throw**: they are called
 * from paths that must not fail because a milestone could not be marked — an
 * agent's creation, an activity event's ingest. A detector that throws logs and
 * the caller carries on.
 */
export class MomentDetectors {
  private readonly room: MomentRoom;
  private readonly facts: MomentFacts;
  private readonly now: () => Date;

  /**
   * The local day {@link MomentDetectors.weeklyStreak} last counted, and the one
   * piece of state this class carries between events.
   *
   * **It decides whether to repeat a READ, never whether to post.** Rule 2 above
   * stands: what may be posted is decided by the durable marker in the room's own
   * log, so losing this field — a restart, a second process — costs exactly one
   * extra aggregate and can neither suppress a moment nor duplicate one.
   *
   * It exists because the week's counts are a question with one answer per day,
   * and it was being asked on every activity event: 5.64ms at 60k activity rows,
   * growing with the log, in the steady state of an install that is doing well.
   * The day is only remembered once the read has SEEN today (the newest bucket is
   * today's), because until today's first qualifying event lands, today's answer
   * can still change — remembering it earlier would swallow a streak for a whole
   * week.
   */
  private streakReadFor: string | null = null;

  /**
   * Wire the detectors to one install.
   *
   * @param deps.room - Where moments go and what is already there.
   * @param deps.facts - The records detectors read.
   * @param deps.now - The clock, injectable so a test can stand at a date
   *   instead of waiting for one.
   */
  constructor(deps: { room: MomentRoom; facts: MomentFacts; now?: () => Date }) {
    this.room = deps.room;
    this.facts = deps.facts;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * An agent was created or registered — the canonical moment ("tangerines
   * joined your team"), and on an install's first real agent, a warmer version
   * of it.
   *
   * Exactly one of the two ever posts for a given agent. They are not two
   * milestones about the same event; the first-agent line simply says more.
   *
   * **Being alone in the registry is not the same as being the first**, and the
   * difference is a real install's history: delete your only agent, create
   * another, and the registry is back to one row. Reading only the count made
   * that agent "your first agent" a second time — and, worse, silently swallowed
   * its "joined your team" line, because the first-agent branch had already been
   * marked and the joined branch was never reached. So the durable marker is part
   * of the question: an install that has already had its first agent falls
   * through to the ordinary line, forever.
   *
   * **Only an agent a person CREATED is a moment.** The same seam also fires
   * when DorkOS merely takes an existing directory onto its records — mesh
   * registration by path, or a discovery scan adopting a manifest it walked
   * past (DOR-1042). Those need the #team seat, which the seam still gives
   * them, but they are not events a person caused: a scan that adopts twelve
   * directories would otherwise spend the hour-long quiet period announcing
   * whichever one the walk reached first, which is the over-participation the
   * quiet period exists to prevent.
   *
   * @param agent - The agent the seam reports.
   */
  agentCreated(agent: CreatedAgent): void {
    if (agent.origin !== 'created') return;
    this.pass((ctx) => {
      // The registry is what makes this real rather than reported: an agent that
      // is not in it (a system agent like DorkBot, or one whose sync did not
      // land) is not one this install can say joined your team.
      const registered = this.facts.registeredAgents();
      const joined = registered.find((candidate) => candidate.path === agent.path);
      if (!joined) return null;
      const first = registered.length === 1 && !ctx.marked({ kind: 'first_agent' });
      const kind: RoomMomentKind = first ? 'first_agent' : 'joined_team';
      if (!first && ctx.marked({ kind, ref: joined.path })) return null;
      const displayName = agent.displayName ?? joined.displayName;
      return {
        text: first ? firstAgentText(displayName) : joinedTeamText(displayName),
        moment: {
          kind,
          source: { kind: 'agent', ref: joined.path, observedAt: joined.registeredAt },
          mintedByAgentRef: null,
        },
        // The one field that makes the feed draw the agent's own face beside a
        // line the system wrote. Refused on the agent path for spoof reasons
        // (`RoomService.postMoment`); this is the case it exists for.
        subjectAuthorId: this.room.agentAuthorId({ path: joined.path, displayName }) ?? undefined,
      };
    });
  }

  /**
   * Something landed in the activity log — the one existing path that sees
   * schedules, runs and connections happen.
   *
   * Every detector below reads either the event itself or the log it just joined.
   * The first that qualifies posts; the rest wait for another day, literally.
   *
   * @param event - The event that was just written.
   */
  activityObserved(event: ActivityItem): void {
    this.pass(
      (ctx) => this.firstSchedule(ctx, event),
      (ctx) => this.firstConnection(ctx, event),
      (ctx) => this.firstOvernightRun(ctx, event),
      (ctx) => this.anniversary(ctx),
      (ctx) => this.weeklyStreak(ctx)
    );
  }

  /**
   * Run detectors in order and post the first that qualifies — or nothing,
   * which is the usual answer.
   *
   * @param detectors - The candidates to consider, in priority order.
   */
  private pass(...detectors: Array<(ctx: PassContext) => MomentCandidate | null>): void {
    try {
      const roomId = this.room.teamRoomId();
      if (!roomId) return;
      const now = this.now();
      const last = this.room.lastMarkedAt(roomId, QUIET_SCAN_ENTRIES);
      if (last && now.getTime() - Date.parse(last) < MOMENT_QUIET_PERIOD_MS) return;
      const ctx: PassContext = {
        roomId,
        now,
        marked: (key) => this.room.hasMarked(roomId, key),
      };
      for (const detector of detectors) {
        const candidate = detector(ctx);
        if (!candidate) continue;
        this.room.mark(roomId, candidate);
        return;
      }
    } catch (err) {
      logger.warn('[Rooms] a moment detector failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * The first schedule this install ever made.
   *
   * @param ctx - The pass.
   * @param event - The activity event being observed.
   */
  private firstSchedule(ctx: PassContext, event: ActivityItem): MomentCandidate | null {
    if (event.eventType !== SCHEDULE_CREATED || !event.resourceId) return null;
    if (ctx.marked({ kind: 'first_schedule' })) return null;
    return {
      text: firstScheduleText(event.resourceLabel ?? event.resourceId),
      moment: {
        kind: 'first_schedule',
        source: { kind: 'schedule', ref: event.resourceId, observedAt: event.occurredAt },
        mintedByAgentRef: null,
      },
    };
  }

  /**
   * The first time an agent was wired up to something outside DorkOS.
   *
   * The line says nothing about WHICH service, and that is deliberate: the
   * event's label is a composed string (`agent → adapter`), and taking a
   * sentence apart to build another one is how a moment starts printing
   * something that was never in the record.
   *
   * @param ctx - The pass.
   * @param event - The activity event being observed.
   */
  private firstConnection(ctx: PassContext, event: ActivityItem): MomentCandidate | null {
    if (event.eventType !== CONNECTION_CREATED || !event.resourceId) return null;
    if (ctx.marked({ kind: 'first_connection' })) return null;
    return {
      text: firstConnectionText(),
      moment: {
        kind: 'first_connection',
        source: { kind: 'connection', ref: event.resourceId, observedAt: event.occurredAt },
        mintedByAgentRef: null,
      },
    };
  }

  /**
   * The first scheduled run that finished in the middle of the night.
   *
   * "Overnight" is read off the run's own timestamp on the server's clock — the
   * person's clock — and nothing else. It does not mean "while you were away";
   * whether you were away is welcome-back's question (D5.2), asked from a
   * different record.
   *
   * @param ctx - The pass.
   * @param event - The activity event being observed.
   */
  private firstOvernightRun(ctx: PassContext, event: ActivityItem): MomentCandidate | null {
    if (event.eventType !== RUN_SUCCEEDED || !event.resourceId) return null;
    const finished = new Date(event.occurredAt);
    if (Number.isNaN(finished.getTime())) return null;
    const hour = finished.getHours();
    if (hour < OVERNIGHT_FROM_HOUR && hour >= OVERNIGHT_TO_HOUR) return null;
    if (ctx.marked({ kind: 'first_overnight_run' })) return null;
    return {
      text: firstOvernightRunText(event.resourceLabel ?? event.resourceId, finished),
      moment: {
        kind: 'first_overnight_run',
        source: { kind: 'schedule', ref: event.resourceId, observedAt: event.occurredAt },
        mintedByAgentRef: null,
      },
    };
  }

  /**
   * A week or a month of working with one agent.
   *
   * Read off the registry row's own timestamp, so the anniversary is a fact
   * about a record rather than something this process remembered. The month is
   * a calendar month — the 3rd to the 3rd, because that is what a person means —
   * and where the target month is too short to have that date,
   * {@link monthAfter} clamps to its last day rather than spilling into the
   * month after.
   *
   * @param ctx - The pass.
   */
  private anniversary(ctx: PassContext): MomentCandidate | null {
    for (const agent of this.facts.registeredAgents()) {
      const joined = new Date(agent.registeredAt);
      if (Number.isNaN(joined.getTime())) continue;
      const month = monthAfter(joined);
      const week = new Date(joined.getTime() + 7 * 24 * 60 * 60 * 1000);
      for (const [span, at] of [
        ['month', month],
        ['week', week],
      ] as const) {
        const since = ctx.now.getTime() - at.getTime();
        if (since < 0 || since > ANNIVERSARY_GRACE_MS) continue;
        const observedAt = at.toISOString();
        if (ctx.marked({ kind: 'anniversary', ref: agent.path, observedAt })) continue;
        return {
          text: anniversaryText(agent.displayName, span),
          moment: {
            kind: 'anniversary',
            source: { kind: 'agent', ref: agent.path, observedAt },
            mintedByAgentRef: null,
          },
          subjectAuthorId:
            this.room.agentAuthorId({ path: agent.path, displayName: agent.displayName }) ??
            undefined,
        };
      }
    }
    return null;
  }

  /**
   * Seven days in a row with something happening on every one of them.
   *
   * The number in the line is the sum of the seven days, counted from the log.
   * Keyed on the calendar week, so a streak that keeps going says so once a week
   * rather than every day it survives.
   *
   * **The two cheap questions come first, and that ordering is the whole cost of
   * this detector.** The week's key depends only on the clock, so the durable
   * marker can be checked before anything is counted — a week already marked
   * costs one 0.026ms lookup instead of a 5.64ms aggregate. Then the day gate:
   * the counts have one answer per local day, so once a read has seen today,
   * every later event today is answered from the field rather than the log
   * ({@link MomentDetectors.streakReadFor}).
   *
   * @param ctx - The pass.
   */
  private weeklyStreak(ctx: PassContext): MomentCandidate | null {
    const ref = `activity:week-of-${weekStart(ctx.now)}`;
    if (ctx.marked({ kind: 'volume_mark', ref })) return null;
    const today = localDate(ctx.now);
    if (this.streakReadFor === today) return null;
    const days = this.facts.dailyActivity({ days: STREAK_DAYS, now: ctx.now });
    // Only once the read has seen today is today's answer settled; before that,
    // today's first qualifying event can still complete the week.
    if (days.at(-1)?.date === today) this.streakReadFor = today;
    if (days.length < STREAK_DAYS) return null;
    const count = days.reduce((total, day) => total + day.count, 0);
    return {
      text: weeklyStreakText(count),
      moment: {
        kind: 'volume_mark',
        source: {
          kind: 'activity',
          ref,
          // The newest real event in the window — the one that completed the
          // streak — rather than the instant this was written.
          observedAt: days[days.length - 1].lastOccurredAt,
        },
        mintedByAgentRef: null,
      },
    };
  }
}

/**
 * One calendar month after an instant, keeping the time of day.
 *
 * **`setMonth(+1)` alone is wrong at the end of a month**, and wrong in the way
 * that produces a sentence a person can catch: an agent registered on 31 January
 * has no 31 February, so JS rolls the overflow forward and the "one month"
 * anniversary lands on 3 March — five weeks later, announced as a month. Days
 * are clamped to the target month's last day instead, so 31 January gives 28
 * February (29 in a leap year), 31 March gives 30 April, and every date that
 * exists in both months is left exactly where it was.
 *
 * @param from - The instant to count a month from.
 */
function monthAfter(from: Date): Date {
  const at = new Date(from);
  const day = at.getDate();
  // To the 1st first: without it, the `setMonth` below is the very overflow this
  // function exists to prevent.
  at.setDate(1);
  at.setMonth(at.getMonth() + 1);
  // Day 0 of the FOLLOWING month is the last day of this one.
  const lastDay = new Date(at.getFullYear(), at.getMonth() + 1, 0).getDate();
  at.setDate(Math.min(day, lastDay));
  return at;
}

/**
 * The local date of the Monday that starts `at`'s week, `YYYY-MM-DD`.
 *
 * @param at - Any instant in the week.
 */
function weekStart(at: Date): string {
  const monday = new Date(at);
  // `getDay()` is 0 on Sunday, which belongs to the week that started six days
  // earlier, not the one starting tomorrow.
  const back = (monday.getDay() + 6) % 7;
  monday.setDate(monday.getDate() - back);
  return localDate(monday);
}

/**
 * A local calendar date as `YYYY-MM-DD`.
 *
 * Local rather than UTC because every day-shaped claim this file makes is about
 * the person's day: "every day this week" has to mean the days they lived
 * through, not the ones UTC did.
 *
 * @param at - The instant to take the date of.
 */
function localDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

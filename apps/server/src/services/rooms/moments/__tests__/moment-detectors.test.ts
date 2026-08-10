/**
 * The moment detectors — what makes #team mark a milestone, and everything that
 * must not (team-room-home spec D5.1, task 4.2).
 *
 * Driven through the REAL room service, the real store and a real database,
 * because two of the three claims under test are claims about persistence: that
 * a moment fires once EVER (proved by re-running a detector through a second
 * instance, which is what a restart is), and that every number in a moment comes
 * out of a table rather than out of the code. A fake store could only prove the
 * detectors agree with a fake.
 *
 * Each detector gets the same three questions: does it fire on the real event,
 * does it stay silent on the near-miss, and does it stay silent the second time.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { activityEvents, agents as agentsTable, type Db } from '@dorkos/db';
import type { ActivityCategory, ActivityItem } from '@dorkos/shared/activity-schemas';
import { TEAM_ROOM_WELL_KNOWN, type RoomEntry } from '@dorkos/shared/room-schemas';
import { ulid } from 'ulidx';
import type { AuthorRegistry } from '../../author-registry.js';
import type { RoomService } from '../../room-service.js';
import type { RoomStore } from '../../room-store.js';
import { agentLookupFor, createRoomHarness } from '../../__tests__/room-test-harness.js';
import { createMomentDetectors, createMomentRoom } from '../index.js';
import { MomentDetectors, type MomentFacts } from '../moment-detectors.js';
import { createMomentFacts } from '../moment-facts.js';

const TANGERINES = '/agents/tangerines';
const ANA = '/agents/ana';
const DORKBOT = '/agents/dorkbot';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('moment detectors', () => {
  let db: Db;
  let service: RoomService;
  let store: RoomStore;
  let authors: AuthorRegistry;
  let human: string;
  let roomId: string;
  let detectors: MomentDetectors;

  beforeEach(() => {
    ({ db, service, store, authors, human } = createRoomHarness({
      agents: agentLookupFor({}),
    }));
    // The real #team, opened the way boot opens it — so the detectors find it by
    // the same well-known key the shipped wiring finds it by.
    roomId = service.ensureSystemChannel(
      TEAM_ROOM_WELL_KNOWN,
      { slug: 'team', topic: 'You and every agent you run.' },
      human
    ).room.id;
    detectors = build();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A detectors instance over this install. A second one is what a restart is. */
  function build(): MomentDetectors {
    return createMomentDetectors({ service, store, authors, db });
  }

  /**
   * The same detectors with one half swapped: the REAL room every time, so
   * claims about durable markers still run against the real log, and whatever
   * clock or fact reader the test needs to watch.
   *
   * @param opts.facts - A fact reader to use instead of the live one.
   * @param opts.now - A clock to stand at.
   */
  function buildWith(opts: { facts?: MomentFacts; now?: () => Date } = {}): MomentDetectors {
    return new MomentDetectors({
      room: createMomentRoom({ service, store, authors }),
      facts: opts.facts ?? createMomentFacts(db),
      now: opts.now,
    });
  }

  /**
   * The live fact reader, with every `dailyActivity` call recorded.
   *
   * @param reads - Where to push a mark per aggregate read.
   */
  function factsWatching(reads: string[]): MomentFacts {
    const live = createMomentFacts(db);
    return {
      registeredAgents: () => live.registeredAgents(),
      dailyActivity: (opts) => {
        reads.push('dailyActivity');
        return live.dailyActivity(opts);
      },
    };
  }

  /**
   * Put an agent in the registry — the record every agent-shaped moment reads.
   *
   * @param path - The agent's directory.
   * @param opts.name - Its display name.
   * @param opts.registeredAt - When this install registered it.
   * @param opts.isSystem - Whether it is a system agent, like DorkBot.
   */
  function register(
    path: string,
    opts: { name: string; registeredAt?: Date; isSystem?: boolean; into?: Db } = {
      name: 'tangerines',
    }
  ): void {
    const at = (opts.registeredAt ?? new Date()).toISOString();
    (opts.into ?? db)
      .insert(agentsTable)
      .values({
        id: ulid(),
        name: opts.name,
        displayName: opts.name,
        runtime: 'claude-code',
        projectPath: path,
        isSystem: opts.isSystem ?? false,
        registeredAt: at,
        updatedAt: at,
      })
      .run();
  }

  /**
   * Write an activity event into the log this install keeps.
   *
   * @param event.eventType - The event's type.
   * @param event.category - Which subsystem it came from.
   * @param event.occurredAt - When it happened.
   */
  function record(event: {
    eventType: string;
    category: ActivityCategory;
    occurredAt: Date;
  }): void {
    db.insert(activityEvents)
      .values({
        id: ulid(),
        occurredAt: event.occurredAt.toISOString(),
        actorType: 'system',
        actorLabel: 'DorkOS',
        category: event.category,
        eventType: event.eventType,
        summary: event.eventType,
        createdAt: event.occurredAt.toISOString(),
      })
      .run();
  }

  /**
   * An activity event as an observer sees it.
   *
   * @param over - The fields this test cares about.
   */
  function event(over: Partial<ActivityItem> = {}): ActivityItem {
    return {
      id: ulid(),
      occurredAt: new Date().toISOString(),
      actorType: 'system',
      actorId: null,
      actorLabel: 'DorkOS',
      category: 'agent',
      eventType: 'agent.status_changed',
      resourceType: null,
      resourceId: null,
      resourceLabel: null,
      summary: 'something happened',
      linkPath: null,
      metadata: null,
      ...over,
    };
  }

  /** Every moment the room has marked, oldest first. */
  function moments(): RoomEntry[] {
    return service
      .listEntries(roomId, human, { limit: 500 })
      .filter((entry) => entry.body.moment !== undefined);
  }

  /** The words of the one moment the room marked. */
  function onlyMoment(): RoomEntry {
    const marked = moments();
    expect(marked).toHaveLength(1);
    return marked[0];
  }

  /**
   * Move the room past its quiet period WITHOUT moving the clock: the quiet
   * check reads only the newest hundred entries, so a room that has moved on
   * that far is no longer in a burst.
   *
   * Used to isolate the durable marker from the quiet period. A test that let
   * the quiet period do the silencing would pass just as happily with no marker
   * at all, which is the exact bug this feature cannot have.
   */
  function moveThePageOn(): void {
    for (let i = 0; i < 101; i += 1) {
      service.post(roomId, { authorId: human, text: `message ${i}` });
    }
  }

  describe('an agent joining', () => {
    it('marks the first agent as the first, and says whose face to draw', () => {
      register(TANGERINES, { name: 'tangerines' });

      detectors.agentCreated({ name: 'tangerines', path: TANGERINES, origin: 'created' });

      const marked = onlyMoment();
      expect(marked.body.text).toBe('tangerines joined your team. Your first agent.');
      expect(marked.body.moment).toEqual({
        kind: 'first_agent',
        source: {
          kind: 'agent',
          ref: TANGERINES,
          observedAt: expect.any(String) as unknown as string,
        },
        mintedByAgentRef: null,
      });
      // The moment is ABOUT the agent, written by the room — the same field a
      // notice uses, and what makes the feed draw tangerines rather than DorkOS.
      expect(marked.body.subjectAuthorId).toBe(authors.resolveAgent(TANGERINES, 'tangerines').id);
    });

    it('marks a later agent as joining, not as the first', () => {
      register(TANGERINES, { name: 'tangerines', registeredAt: new Date(Date.now() - DAY_MS) });
      register(ANA, { name: 'Ana' });

      detectors.agentCreated({ name: 'ana', displayName: 'Ana', path: ANA, origin: 'created' });

      const marked = onlyMoment();
      expect(marked.body.text).toBe('Ana joined your team.');
      expect(marked.body.moment?.kind).toBe('joined_team');
    });

    it('says nothing about a system agent — DorkBot was not your decision', () => {
      register(DORKBOT, { name: 'DorkBot', isSystem: true });

      detectors.agentCreated({ name: 'dorkbot', path: DORKBOT, origin: 'created' });

      expect(moments()).toEqual([]);
    });

    it('says nothing about an agent DorkOS was merely told to register', () => {
      // The line between the two origins is who did something. Creating an agent
      // is a person bringing a teammate into being; registering a directory that
      // was already on disk is DorkOS updating its own records. Announcing the
      // second is the system talking about its bookkeeping — and worse, a scan
      // that adopts twelve directories would spend the quiet hour celebrating
      // whichever one the walk happened to reach first (DOR-1042).
      register(TANGERINES, { name: 'tangerines' });

      detectors.agentCreated({ name: 'tangerines', path: TANGERINES, origin: 'registered' });

      expect(moments()).toEqual([]);
    });

    it('still marks an agent a person created', () => {
      register(ANA, { name: 'Ana' });

      detectors.agentCreated({ name: 'ana', displayName: 'Ana', path: ANA, origin: 'created' });

      expect(onlyMoment().body.text).toBe('Ana joined your team. Your first agent.');
    });

    it('says nothing about an agent the registry does not have', () => {
      // The near-miss that matters: the seam reported a creation, but nothing in
      // this install's own records says it happened. A moment is never written
      // from what a caller claimed.
      detectors.agentCreated({ name: 'ghost', path: '/agents/ghost', origin: 'created' });

      expect(moments()).toEqual([]);
    });

    it('does not mark the same agent twice, even after a restart', () => {
      register(TANGERINES, { name: 'tangerines', registeredAt: new Date(Date.now() - DAY_MS) });
      register(ANA, { name: 'Ana' });
      build().agentCreated({ name: 'ana', displayName: 'Ana', path: ANA, origin: 'created' });
      expect(moments()).toHaveLength(1);

      // A fresh process, over the same database, past the quiet period. The
      // marker it reads is the moment itself.
      moveThePageOn();
      build().agentCreated({ name: 'ana', displayName: 'Ana', path: ANA, origin: 'created' });

      expect(moments()).toHaveLength(1);
    });

    it('never calls a second agent your first, however empty the registry got', () => {
      register(TANGERINES, { name: 'tangerines' });
      detectors.agentCreated({ name: 'tangerines', path: TANGERINES, origin: 'created' });
      expect(onlyMoment().body.moment?.kind).toBe('first_agent');

      // You delete that agent and start again. The registry is back to one row,
      // and counting rows would call this one "your first agent" a second time —
      // and then swallow its welcome entirely, because the first-agent marker is
      // already there and the ordinary line was never reached.
      db.delete(agentsTable).run();
      register(ANA, { name: 'Ana' });
      moveThePageOn();
      build().agentCreated({ name: 'ana', displayName: 'Ana', path: ANA, origin: 'created' });

      const marked = moments();
      expect(marked.map((entry) => entry.body.moment?.kind)).toEqual([
        'first_agent',
        'joined_team',
      ]);
      expect(marked[1].body.text).toBe('Ana joined your team.');
    });

    it('answers a burst of creations with one line, not five', () => {
      for (const [index, path] of ['/a', '/b', '/c', '/d', '/e'].entries()) {
        register(path, { name: `agent-${index}` });
      }

      for (const [index, path] of ['/a', '/b', '/c', '/d', '/e'].entries()) {
        detectors.agentCreated({ name: `agent-${index}`, path, origin: 'created' });
      }

      // Four of them are dropped, not queued: a milestone that arrives an hour
      // after the thing it marks is not news.
      expect(moments()).toHaveLength(1);
    });
  });

  describe('the firsts that ride the activity log', () => {
    it('marks the first schedule, and not a schedule being paused', () => {
      detectors.activityObserved(
        event({ eventType: 'tasks.task_paused', category: 'tasks', resourceId: 'sched_1' })
      );
      expect(moments()).toEqual([]);

      detectors.activityObserved(
        event({
          eventType: 'tasks.task_created',
          category: 'tasks',
          resourceId: 'sched_1',
          resourceLabel: 'nightly digest',
        })
      );

      const marked = onlyMoment();
      expect(marked.body.text).toBe('Your first schedule is set up: nightly digest.');
      expect(marked.body.moment?.source).toEqual({
        kind: 'schedule',
        ref: 'sched_1',
        observedAt: expect.any(String) as unknown as string,
      });
    });

    it('marks the first connection', () => {
      detectors.activityObserved(
        event({
          eventType: 'config.binding_updated',
          category: 'config',
          resourceId: 'binding_1',
        })
      );
      expect(moments()).toEqual([]);

      detectors.activityObserved(
        event({ eventType: 'config.binding_created', category: 'config', resourceId: 'binding_1' })
      );

      expect(onlyMoment().body.text).toBe(
        'Your first connection is set up. You can reach an agent from outside DorkOS now.'
      );
    });

    it('marks the first run that finished overnight, and never one that finished at lunchtime', () => {
      const lunchtime = new Date();
      lunchtime.setHours(13, 5, 0, 0);
      detectors.activityObserved(
        event({
          eventType: 'tasks.run_success',
          category: 'tasks',
          resourceId: 'sched_1',
          resourceLabel: 'nightly digest',
          occurredAt: lunchtime.toISOString(),
        })
      );
      expect(moments()).toEqual([]);

      const smallHours = new Date();
      smallHours.setHours(3, 12, 0, 0);
      detectors.activityObserved(
        event({
          eventType: 'tasks.run_success',
          category: 'tasks',
          resourceId: 'sched_1',
          resourceLabel: 'nightly digest',
          occurredAt: smallHours.toISOString(),
        })
      );

      // The clock time is read off the run's own record, in the timezone the
      // person sleeps in.
      expect(onlyMoment().body.text).toBe(
        'nightly digest ran overnight and finished at 3:12 AM. Your first overnight run.'
      );
    });

    it('marks a first only once, however many times the event comes back', () => {
      const created = event({
        eventType: 'tasks.task_created',
        category: 'tasks',
        resourceId: 'sched_1',
        resourceLabel: 'nightly digest',
      });
      detectors.activityObserved(created);
      expect(moments()).toHaveLength(1);

      moveThePageOn();
      // A second schedule, a fresh process, and the quiet period long behind us.
      build().activityObserved(
        event({
          eventType: 'tasks.task_created',
          category: 'tasks',
          resourceId: 'sched_2',
          resourceLabel: 'weekly report',
        })
      );

      expect(moments()).toHaveLength(1);
    });
  });

  describe('anniversaries', () => {
    it('marks a week with an agent, on the day it comes round', () => {
      register(TANGERINES, {
        name: 'tangerines',
        registeredAt: new Date(Date.now() - 7 * DAY_MS),
      });

      detectors.activityObserved(event());

      const marked = onlyMoment();
      expect(marked.body.text).toBe("It's been a week since tangerines joined your team.");
      expect(marked.body.moment?.kind).toBe('anniversary');
    });

    it('marks a month with an agent', () => {
      const joined = new Date();
      joined.setMonth(joined.getMonth() - 1);
      register(TANGERINES, { name: 'tangerines', registeredAt: joined });

      detectors.activityObserved(event());

      expect(onlyMoment().body.text).toBe("It's been a month since tangerines joined your team.");
    });

    it('says nothing the day before, and nothing about one that passed months ago', () => {
      register(TANGERINES, { name: 'tangerines', registeredAt: new Date(Date.now() - 6 * DAY_MS) });
      detectors.activityObserved(event());
      expect(moments()).toEqual([]);

      // The install that has been running for a year must not greet its
      // history the first time anything happens.
      db.delete(agentsTable).run();
      register(ANA, { name: 'Ana', registeredAt: new Date(Date.now() - 200 * DAY_MS) });
      detectors.activityObserved(event());
      expect(moments()).toEqual([]);
    });

    it('lands a month after the 31st on the last day of a short month', () => {
      // 31 January. February has no 31st, and rolling the overflow forward puts
      // the "one month" mark on 3 March — five weeks, announced as a month.
      register(TANGERINES, { name: 'tangerines', registeredAt: new Date(2026, 0, 31, 9, 0, 0, 0) });

      buildWith({ now: () => new Date(2026, 1, 28, 10, 0, 0, 0) }).activityObserved(event());

      const marked = onlyMoment();
      expect(marked.body.text).toBe("It's been a month since tangerines joined your team.");
      // Clamped to 28 February, keeping the time of day it joined at.
      expect(marked.body.moment?.source.observedAt).toBe(
        new Date(2026, 1, 28, 9, 0, 0, 0).toISOString()
      );
    });

    it('says nothing on the 3rd of March, which is not a month after the 31st', () => {
      register(TANGERINES, { name: 'tangerines', registeredAt: new Date(2026, 0, 31, 9, 0, 0, 0) });

      buildWith({ now: () => new Date(2026, 2, 3, 10, 0, 0, 0) }).activityObserved(event());

      // The real anniversary passed on 28 February, three days ago — past the
      // grace, and gone. The date JS would have rolled to is not a second one.
      expect(moments()).toEqual([]);
    });

    it('marks each anniversary once, even after a restart', () => {
      register(TANGERINES, {
        name: 'tangerines',
        registeredAt: new Date(Date.now() - 7 * DAY_MS),
      });
      build().activityObserved(event());
      expect(moments()).toHaveLength(1);

      moveThePageOn();
      build().activityObserved(event());

      expect(moments()).toHaveLength(1);
    });
  });

  describe('the weekly volume mark', () => {
    /**
     * Put `perDay` qualifying events on each of the last `days` local days.
     *
     * @param days - How many days back to fill, including today.
     * @param perDay - How many events each of those days gets.
     */
    function fillDays(days: number, perDay: number): void {
      for (let back = 0; back < days; back += 1) {
        const day = new Date();
        day.setHours(12, 0, 0, 0);
        day.setDate(day.getDate() - back);
        for (let n = 0; n < perDay; n += 1) {
          record({ eventType: 'tasks.run_success', category: 'tasks', occurredAt: day });
        }
      }
    }

    it('counts the week exactly — the number in the line is the number in the log', () => {
      fillDays(7, 2);

      detectors.activityObserved(event());

      // Fourteen. Not "about a fortnight's worth", not rounded to ten.
      expect(onlyMoment().body.text).toBe(
        'Something ran here every day this week: 14 things in seven days.'
      );
    });

    it('says nothing when a day is missing from the week', () => {
      fillDays(6, 3);

      detectors.activityObserved(event());

      expect(moments()).toEqual([]);
    });

    it('does not count settings changes or server restarts as things that ran', () => {
      fillDays(6, 1);
      // The seventh day has activity — of the kind that happens because you
      // opened the app, not because your agents did anything.
      const seventh = new Date();
      seventh.setHours(12, 0, 0, 0);
      seventh.setDate(seventh.getDate() - 6);
      record({ eventType: 'system.started', category: 'system', occurredAt: seventh });
      record({ eventType: 'config.updated', category: 'config', occurredAt: seventh });

      detectors.activityObserved(event());

      expect(moments()).toEqual([]);
    });

    it('counts the week once a day, not once an event', () => {
      // Six days, today among them: no streak to mark, and the answer cannot
      // change again today. The aggregate is the expensive read on this path
      // (5.64ms at 60k activity rows, growing), and it rides EVERY event.
      fillDays(6, 3);
      const reads: string[] = [];
      const watched = buildWith({ facts: factsWatching(reads) });

      watched.activityObserved(event());
      watched.activityObserved(event());
      watched.activityObserved(event());

      expect(reads).toEqual(['dailyActivity']);
      expect(moments()).toEqual([]);
    });

    it('does not count a week it has already marked', () => {
      fillDays(7, 2);
      build().activityObserved(event());
      expect(moments()).toHaveLength(1);

      // A fresh process — so nothing is remembered — past the quiet period. The
      // week's key comes from the clock alone, so the durable marker answers
      // before anything is counted.
      moveThePageOn();
      const reads: string[] = [];
      buildWith({ facts: factsWatching(reads) }).activityObserved(event());

      expect(reads).toEqual([]);
      expect(moments()).toHaveLength(1);
    });

    it('marks the week once, however busy the rest of it gets', () => {
      fillDays(7, 2);
      build().activityObserved(event());
      expect(moments()).toHaveLength(1);

      moveThePageOn();
      build().activityObserved(event());

      expect(moments()).toHaveLength(1);
    });
  });

  describe('quiet', () => {
    it('marks nothing in the hour after it marked something', () => {
      register(TANGERINES, { name: 'tangerines' });
      detectors.agentCreated({ name: 'tangerines', path: TANGERINES, origin: 'created' });
      expect(moments()).toHaveLength(1);

      // A completely different milestone, minutes later. It is real, and it is
      // still not worth a second line in the same hour.
      detectors.activityObserved(
        event({
          eventType: 'tasks.task_created',
          category: 'tasks',
          resourceId: 'sched_1',
          resourceLabel: 'nightly digest',
        })
      );

      expect(moments()).toHaveLength(1);
    });

    it('marks nothing at all when this install has no team room', () => {
      // An install whose #team could not be opened is degraded, not broken: the
      // detector has nowhere to say it, so it says nothing and never invents a
      // room to say it in.
      const elsewhere = createRoomHarness({ agents: agentLookupFor({}) });
      register(TANGERINES, { name: 'tangerines', into: elsewhere.db });

      createMomentDetectors({
        service: elsewhere.service,
        store: elsewhere.store,
        authors: elsewhere.authors,
        db: elsewhere.db,
      }).agentCreated({ name: 'tangerines', path: TANGERINES, origin: 'created' });

      expect(elsewhere.store.listRooms()).toEqual([]);
    });
  });

  it('runs on real events and nothing else — no detector keeps a timer', () => {
    const interval = vi.spyOn(globalThis, 'setInterval');
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    // Everything a detector could possibly mark is true on this install: a
    // week-old agent, and a full week of activity behind it.
    register(TANGERINES, { name: 'tangerines', registeredAt: new Date(Date.now() - 7 * DAY_MS) });
    for (let back = 0; back < 7; back += 1) {
      const day = new Date();
      day.setHours(12, 0, 0, 0);
      day.setDate(day.getDate() - back);
      record({ eventType: 'tasks.run_success', category: 'tasks', occurredAt: day });
    }

    build();
    vi.useFakeTimers();
    vi.advanceTimersByTime(DAY_MS);

    // A day passes and the room says nothing, because nothing happened. The
    // detectors are woken by events or not at all.
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
    expect(moments()).toEqual([]);
  });
});

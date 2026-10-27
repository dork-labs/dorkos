import { describe, it, expect } from 'vitest';
import {
  NOTIFICATION_KINDS,
  NotificationDTOSchema,
  type NotificationKind,
} from '@dorkos/shared/notification-schemas';
import {
  notificationEntry,
  resolvePerKind,
  WIRED_NOTIFICATION_KINDS,
  type NotificationPayloads,
} from '../notification-registry.js';
import { parseExtensionApprovalSubjectId } from '@dorkos/shared/extension-approval-schemas';

/**
 * One payload per kind, so every entry can be exercised. Typed against the
 * registry's own payload map: a kind whose payload changes shape breaks this
 * file at compile time rather than silently going untested.
 */
const PAYLOADS: { [K in NotificationKind]: NotificationPayloads[K] } = {
  'ask.pending': {
    sessionId: 'sess-1',
    interactionId: 'int-1',
    agentId: 'agent-1',
    sessionLabel: 'acme',
    summary: 'Wants to run Bash',
  },
  'schedule.parked': {
    taskId: 'task-1',
    taskName: 'Nightly digest',
    agentId: 'agent-1',
    proposedBy: 'An agent',
  },
  'schedule.armed_by_agent': {
    taskId: 'task-1',
    taskName: 'Nightly digest',
    agentId: 'agent-1',
    armedBy: 'Ana',
    cadence: 'every day at 9:00 AM',
  },
  'approval.pending': {
    approvalId: '01J000000000000000000001',
    capabilityId: 'tasks_delete',
    capabilityTitle: 'Delete a scheduled task',
    agentId: 'agent-1',
    requestedBy: 'Ana',
  },
  'session.error': {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    since: '2026-08-20T09:00:00.000Z',
    sessionLabel: 'acme',
    detail: 'Ran out of turns',
  },
  'turn.completed': {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    sessionLabel: 'acme',
    completedAt: '2026-08-20T00:00:00.000Z',
  },
  'run.completed': {
    runId: 'run-1',
    taskId: 'task-1',
    taskName: 'Nightly digest',
    agentId: 'agent-1',
    status: 'completed',
    duration: '2m 14s',
    detail: 'All clear',
    channelMessage: '✅ Nightly digest — done in 2m 14s. All clear',
  },
  'dm.received': {
    roomId: 'room-1',
    entryId: 'entry-1',
    entrySeq: 12,
    agentId: 'agent-1',
    fromName: 'Ana',
    preview: 'the deploy is green',
  },
  'mention.received': {
    roomId: 'room-1',
    entryId: 'entry-1',
    entrySeq: 13,
    roomName: 'general',
    agentId: 'agent-1',
    fromName: 'Ana',
    preview: 'can you look at this',
  },
  'agent.note': {
    agentId: 'agent-1',
    agentName: 'Ana',
    message: 'The migration finished.',
    sessionId: 'sess-1',
  },
  'dead-letter.created': {
    deadLetterId: 'dl-1',
    agentId: 'agent-1',
    reason: 'no endpoint accepted it',
  },
  'agent.unreachable': { agentId: 'agent-1', agentName: 'Ana' },
  'signin.required': { runtime: 'claude-code', since: '2026-08-20T03:00:00.000Z' },
  'update.installed': { version: '0.61.0', previousVersion: '0.60.0' },
  'report.daily': {
    date: '2026-08-20',
    title: 'While you were away: 2 turns finished',
    summary: '2 turns finished. 1 run finished.',
  },
  'account.limited': {
    sessionId: 'sess-1',
    agentId: 'agent-1',
    sessionLabel: 'dorkos',
    accountId: 'work',
    accountLabel: 'Work',
    window: 'seven_day',
    resetsAt: '2026-08-24T20:00:00.000Z',
    since: '2026-08-20T03:12:00.000Z',
  },
  'account.reset': {
    sessionId: 'sess-1',
    accountId: 'work',
    accountLabel: 'Work',
    pausedCount: 3,
    resetsAt: '2026-08-24T20:00:00.000Z',
    resetConfirmedAt: '2026-08-24T20:01:00.000Z',
  },
  'credits.refused': {
    runtime: 'claude-code',
    sessionId: 'sess-1',
    message: "Couldn't reach DorkOS credits, so nothing was sent.",
  },
  'extension.approval': {
    id: 'flow',
    name: 'Flow',
    version: '1.2.0',
    path: '/home/me/.dork/plugins/flow/.dork/extensions/flow',
    plugin: 'flow',
    sourceLabel: 'flow plugin · dork-labs/marketplace',
    why: 'You installed the flow plugin. This adds a Flow tab. It runs as you.',
    runsInServer: true,
    adds: 'It adds a Flow tab',
    added: 'Flow tab added',
  },
  'extension.decision': {
    decisionId: '01J0000000000000000000000D',
    extensionId: 'flow',
    extensionName: 'Flow',
    key: 'ship:DOR-2387',
    title: 'Ship the new out-of-usage banner?',
    why: "It's built, tests pass, and the reviewer agent found nothing.",
    link: '/x/flow/p/dorkos',
    openProjects: 2,
  },
  'community.owner-replacement': {
    ref: 'remote_owner_a',
    communityLabel: 'Night shift',
    replacementId: '7f1c2a4e-0000-4000-8000-000000000001',
    phase: 'open',
    claimable: false,
    claimableAfter: '2026-10-04T10:00:00.000Z',
  },
  'community.teammate-limit': {
    ref: 'remote_owner_a',
    communityLabel: 'Night shift',
    limitUsd: 20,
    month: '2026-10',
  },
  'community.teammate-limits-reset': {},
  'heartbeat.credits-offer': {},
  'connector.destructive_pending': {
    holdId: 'hold-1',
    agentId: 'agent-1',
    agentName: 'Scout',
    sessionId: 'sess-1',
    actionName: 'Delete message',
    serviceName: 'Gmail',
  },
  'connector.destructive_executed': {
    holdId: 'hold-1',
    agentId: 'agent-1',
    agentName: 'Scout',
    sessionId: 'sess-1',
    actionName: 'Delete message',
    serviceName: 'Gmail',
    outcome: 'success',
  },
  'web.new_device': { deviceRef: 'ref-1', label: 'Safari on iPhone' },
};

/** The tier every kind is declared at, from the spec's own table. */
const EXPECTED_TIERS: Record<NotificationKind, string> = {
  'ask.pending': 'blocking',
  'schedule.parked': 'blocking',
  // Live already and nothing waits on the person: told, with Pause, never paged
  // (spec trusted-by-default-flip §5.4).
  'schedule.armed_by_agent': 'notable',
  'approval.pending': 'blocking',
  'session.error': 'blocking',
  'turn.completed': 'notable',
  'run.completed': 'quiet', // the fixture above is a SUCCESS; failures are notable
  'dm.received': 'notable',
  'mention.received': 'notable',
  'agent.note': 'notable',
  'dead-letter.created': 'quiet',
  'agent.unreachable': 'quiet',
  'signin.required': 'blocking',
  'update.installed': 'quiet',
  'report.daily': 'quiet',
  'account.limited': 'notable',
  'account.reset': 'notable',
  // Nothing was spent and nothing waits on it: told, never paged (ADR 261001-000811).
  'credits.refused': 'notable',
  // Waiting on a person, but nothing is stuck: it badges the bell and never
  // reaches a phone (DOR-2517).
  'extension.approval': 'notable',
  // Somebody's work waits on the answer, so it may reach a phone, with
  // generic text (spec flow-multiproject §7.4).
  'extension.decision': 'blocking',
  // Nothing is stuck and the wait is at least a week: it badges the bell and never reaches a
  // phone (DOR-2543).
  'community.owner-replacement': 'notable',
  // Teammates' posts wake nobody until next month or a higher limit; nothing is broken (DOR-2956).
  'community.teammate-limit': 'notable',
  'community.teammate-limits-reset': 'notable',
  // An offer, raised once per computer: never an alarm (spec heartbeats §6.3).
  'heartbeat.credits-offer': 'quiet',
  // Everyone sees it before it runs, but nothing waits on a person: never
  // paged by the ladder; its own push goes out at once (spec §5.6).
  'connector.destructive_pending': 'notable',
  // News: it ran (spec trusted-by-default-flip §5.6).
  'connector.destructive_executed': 'quiet',
  'web.new_device': 'notable',
};

/**
 * The kinds ADR 260819-234828 says are standing conditions — the three it named,
 * plus `approval.pending`, which DOR-1570 brought onto the same discipline so a
 * destructive capability waiting on a person can reach the escalation ladder,
 * plus `signin.required`, which DOR-1657 did the same for once the sign-in watch
 * gained a store that answers "is this credential still dead?" and an edge where
 * it stops being one, plus `extension.approval` (DOR-2517), whose "is it still
 * waiting?" store is the extension manager.
 */
const STANDING: NotificationKind[] = [
  'ask.pending',
  'schedule.parked',
  'approval.pending',
  'session.error',
  'signin.required',
  'extension.approval',
  'extension.decision',
];

describe('notification registry', () => {
  it('declares an entry for every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(notificationEntry(kind).kind).toBe(kind);
    }
  });

  it('builds a valid notification out of every kind', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = notificationEntry(kind);
      const payload = PAYLOADS[kind];
      const location = entry.locate(payload);
      const parsed = NotificationDTOSchema.safeParse({
        id: '01J000000000000000000000',
        kind,
        tier: resolvePerKind(entry.tier, payload),
        subject: { type: entry.subjectType, id: location.subjectId },
        ...(location.agentId ? { agentId: location.agentId } : {}),
        ...(location.sessionId ? { sessionId: location.sessionId } : {}),
        ...(location.roomId ? { roomId: location.roomId } : {}),
        title: entry.title(payload),
        ...(entry.body?.(payload) ? { body: entry.body(payload) } : {}),
        ...(entry.actions ? { actions: entry.actions(payload) } : {}),
        createdAt: '2026-08-20T00:00:00.000Z',
      });
      expect(parsed.success, `${kind}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it('gives every kind the tier the spec assigns it', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = notificationEntry(kind);
      expect(resolvePerKind(entry.tier, PAYLOADS[kind]), kind).toBe(EXPECTED_TIERS[kind]);
    }
  });

  it('makes a failed run louder than a successful one', () => {
    const entry = notificationEntry('run.completed');
    expect(resolvePerKind(entry.tier, { ...PAYLOADS['run.completed'], status: 'failed' })).toBe(
      'notable'
    );
    expect(resolvePerKind(entry.tier, { ...PAYLOADS['run.completed'], status: 'completed' })).toBe(
      'quiet'
    );
  });

  it('names exactly the kinds something actually raises today', () => {
    // The registry declares the whole vocabulary on purpose, but a declared kind
    // nobody emits is a promise rather than a feature. Every kind now has a
    // real emitter — `dm.received` / `mention.received` from
    // `services/rooms/room-service.ts` (DOR-1388), `report.daily` from
    // `emitters/shift-report.ts` (DOR-1389) — and each carries a comment at
    // its entry saying so.
    expect([...WIRED_NOTIFICATION_KINDS].sort()).toEqual([
      'account.limited',
      'account.reset',
      'agent.note',
      'agent.unreachable',
      'approval.pending',
      'ask.pending',
      'community.owner-replacement',
      'community.teammate-limit',
      'community.teammate-limits-reset',
      'connector.destructive_executed',
      'connector.destructive_pending',
      'credits.refused',
      'dead-letter.created',
      'dm.received',
      'extension.approval',
      'extension.decision',
      'heartbeat.credits-offer',
      'mention.received',
      'report.daily',
      'run.completed',
      'schedule.armed_by_agent',
      'schedule.parked',
      'session.error',
      'signin.required',
      'turn.completed',
      'update.installed',
      'web.new_device',
    ]);

    const reserved = NOTIFICATION_KINDS.filter((k) => !WIRED_NOTIFICATION_KINDS.includes(k));
    expect(reserved).toEqual([]);
  });

  it('treats exactly the standing kinds as standing conditions', () => {
    const standing = NOTIFICATION_KINDS.filter((k) =>
      notificationEntry(k).storage.startsWith('standing')
    );
    expect([...standing].sort()).toEqual([...STANDING].sort());
  });

  it('lets exactly one kind record its own arrival, and says which', () => {
    // `standing-recorded` is the deliberate hole in the storage split: a kind
    // that reaches BOTH `notify()` and `resolveStanding()`. It is affordable
    // only for a condition with no durable owner AND wording that never goes
    // stale, so a second member here is a decision somebody has to defend
    // rather than a line that drifts in.
    const recorded = NOTIFICATION_KINDS.filter(
      (k) => notificationEntry(k).storage === 'standing-recorded'
    );
    expect(recorded).toEqual(['signin.required']);
  });

  it('words a recorded standing kind so both of its rows stay true', () => {
    // Both rows of one episode outlive the moment they describe, and the client
    // renders title and body and nothing else — no outcome, no resolved-at. So
    // the raise row has to read correctly long after somebody signed in, and
    // the two rows have to read DIFFERENTLY or the inbox shows one line twice.
    const entry = notificationEntry('signin.required');
    const raised = { runtime: 'claude-code', since: '2026-08-20T03:00:00.000Z' };
    const cleared = { ...raised, clearedAt: '2026-08-20T08:00:00.000Z' };

    expect(entry.title(raised)).toBe('Your Claude Code sign-in stopped working');
    expect(entry.title(cleared)).toBe('Your Claude Code sign-in is working again');
    expect(entry.title(raised)).not.toBe(entry.title(cleared));
    // One episode, so one key — the ladder arms and disarms on this string.
    expect(entry.dedupeKey(raised)).toBe(entry.dedupeKey(cleared));
  });

  it('lets a failed run reach out unconditionally and a successful one only on opt-in', () => {
    const entry = notificationEntry('run.completed');
    expect(resolvePerKind(entry.relay, { ...PAYLOADS['run.completed'], status: 'failed' })).toBe(
      'always'
    );
    expect(resolvePerKind(entry.relay, { ...PAYLOADS['run.completed'], status: 'completed' })).toBe(
      'opt-in'
    );
  });

  it('keeps every kind but the agent note and the run report inside the app', () => {
    const leaves = NOTIFICATION_KINDS.filter(
      (k) => resolvePerKind(notificationEntry(k).relay, PAYLOADS[k]) !== 'never'
    );
    expect([...leaves].sort()).toEqual(['agent.note', 'run.completed']);
  });

  it('builds a stable dedupe key that does not change between calls', () => {
    for (const kind of NOTIFICATION_KINDS) {
      const entry = notificationEntry(kind);
      expect(entry.dedupeKey(PAYLOADS[kind])).toBe(entry.dedupeKey(PAYLOADS[kind]));
    }
  });

  it('gives two different subjects two different dedupe keys', () => {
    const entry = notificationEntry('run.completed');
    expect(entry.dedupeKey({ ...PAYLOADS['run.completed'], runId: 'run-2' })).not.toBe(
      entry.dedupeKey(PAYLOADS['run.completed'])
    );
  });

  it('gives every kind a dedupe key nobody else can collide with', () => {
    const keys = NOTIFICATION_KINDS.map((k) => notificationEntry(k).dedupeKey(PAYLOADS[k]));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('tells two turns in one session apart, so a second turn is not swallowed', () => {
    const entry = notificationEntry('turn.completed');
    const first = entry.dedupeKey(PAYLOADS['turn.completed']);
    const second = entry.dedupeKey({
      ...PAYLOADS['turn.completed'],
      completedAt: '2026-08-20T00:05:00.000Z',
    });
    expect(second).not.toBe(first);
  });

  it('coalesces a DM burst by room, but gives every mention its own row', () => {
    // dm.received dedupes on the ROOM, deliberately coarser than every other
    // kind: two messages in one DM within the window are one notification.
    const dm = notificationEntry('dm.received');
    expect(dm.dedupeKey({ ...PAYLOADS['dm.received'], entryId: 'entry-2' })).toBe(
      dm.dedupeKey(PAYLOADS['dm.received'])
    );
    expect(dm.dedupeKey({ ...PAYLOADS['dm.received'], roomId: 'room-2' })).not.toBe(
      dm.dedupeKey(PAYLOADS['dm.received'])
    );

    // mention.received still dedupes per entry — each mention is its own event.
    const mention = notificationEntry('mention.received');
    expect(mention.dedupeKey({ ...PAYLOADS['mention.received'], entryId: 'entry-2' })).not.toBe(
      mention.dedupeKey(PAYLOADS['mention.received'])
    );
  });

  it('never puts a tool input in a title or a body', () => {
    // A notification title can end up on a phone lock screen. The Ask summary is
    // the tool's name or display name, never the command it proposed to run.
    const entry = notificationEntry('ask.pending');
    const payload = { ...PAYLOADS['ask.pending'], summary: 'Wants to run Bash' };
    expect(entry.title(payload)).not.toContain('rm -rf');
    expect(entry.body?.(payload)).toBe('Wants to run Bash');
  });

  describe('a run that needs attention (DOR-2101, DOR-3123)', () => {
    const blocked: (typeof PAYLOADS)['run.completed'] = {
      ...PAYLOADS['run.completed'],
      status: 'needs_attention',
      outcome: 'nothing_done',
      taskName: 'Mailroom',
      duration: '4s',
      detail:
        'Skipped Bash and gmail: search — nobody was there to approve them on a scheduled run.',
    };

    it('is notable, like a failure and unlike a success', () => {
      const entry = notificationEntry('run.completed');
      expect(entry.tier).toBeTypeOf('function');
      expect((entry.tier as (p: typeof blocked) => string)(blocked)).toBe('notable');
      expect(
        (entry.tier as (p: typeof blocked) => string)({ ...blocked, status: 'completed' })
      ).toBe('quiet');
    });

    it('titles every failing run "needs attention", and a success "finished"', () => {
      const entry = notificationEntry('run.completed');
      expect(entry.title(blocked)).toBe('Mailroom needs attention');
      expect(entry.title({ ...blocked, status: 'failed' })).toBe('Mailroom needs attention');
      expect(entry.title({ ...blocked, status: 'completed' })).toBe('Mailroom finished');
    });

    it('offers Open schedule on a failing run, and never a raise (SF-18)', () => {
      const actions = notificationEntry('run.completed').actions;
      expect(actions?.(blocked)).toEqual([
        { id: 'open-schedule', label: 'Open schedule', style: 'primary' },
      ]);
      expect(actions?.({ ...blocked, status: 'completed' })).toEqual([]);
    });

    it('says the row’s reason, points at the schedule, and says it will not repeat', () => {
      const body = notificationEntry('run.completed').body;
      expect(body?.({ ...blocked, refusedTools: ['Bash', 'gmail: search'] })).toBe(
        'Nothing got done: Bash and gmail: search were refused. Open the schedule to fix it.'
      );
      expect(
        body?.({ ...blocked, outcome: 'partial', refusedTools: ['Bash'], oncePerStreak: true })
      ).toBe(
        'Bash was refused, with nobody there to approve it. Open the schedule to fix it. ' +
          'You won’t get another notice about it until it runs cleanly and fails again.'
      );
      // "Didn't finish": only the reason line changes.
      expect(body?.({ ...blocked, status: 'failed', detail: 'API Error: 500' })).toBe(
        'Didn’t finish: API Error: 500. Open the schedule to fix it.'
      );
      // A cut error ends in "…", and an error that ends its own sentence keeps
      // its mark: never a full stop after either.
      const cut = body?.({
        ...blocked,
        status: 'failed',
        detail: `which is not ${'x '.repeat(200)}`,
      });
      expect(cut).toMatch(/… Open the schedule to fix it\.$/);
      expect(cut).not.toContain('….');
      expect(body?.({ ...blocked, status: 'failed', detail: 'Is the server up?' })).toBe(
        'Didn’t finish: Is the server up? Open the schedule to fix it.'
      );
      // Never a raise of the schedule's level (spec `schedules-failing` SF-18).
      expect(body?.({ ...blocked, refusedTools: ['Bash'] })).not.toMatch(/permission level|Full/);
    });

    it('reaches out for every failing notice, since a streak raises only one', () => {
      const entry = notificationEntry('run.completed');
      const relay = entry.relay as (p: typeof blocked) => string;
      expect(relay(blocked)).toBe('always');
      expect(relay({ ...blocked, outcome: 'partial' })).toBe('always');
      expect(relay({ ...blocked, status: 'failed' })).toBe('always');
      expect(relay({ ...blocked, status: 'completed' })).toBe('opt-in');
    });
  });

  describe('an extension waiting to be turned on (DOR-2517)', () => {
    const entry = notificationEntry('extension.approval');
    const waiting = PAYLOADS['extension.approval'];

    it('asks a question while it waits, and says why on the second line', () => {
      expect(entry.title(waiting)).toBe('Turn on Flow?');
      expect(entry.body?.(waiting)).toBe(waiting.why);
    });

    it('reads as what happened once it was answered', () => {
      expect(entry.title({ ...waiting, answer: 'approved' })).toBe('You turned on Flow');
      expect(entry.body?.({ ...waiting, answer: 'approved' })).toBe('Flow tab added');
      expect(entry.title({ ...waiting, answer: 'dismissed' })).toBe('Flow is off for now');
      expect(entry.body?.({ ...waiting, answer: 'dismissed' })).toBeUndefined();
    });

    it('is one condition per copy and version, whatever the answer', () => {
      expect(entry.dedupeKey({ ...waiting, answer: 'approved' })).toBe(entry.dedupeKey(waiting));
      expect(entry.dedupeKey({ ...waiting, version: '1.3.0' })).not.toBe(entry.dedupeKey(waiting));
      expect(entry.dedupeKey({ ...waiting, path: '/elsewhere/flow' })).not.toBe(
        entry.dedupeKey(waiting)
      );
    });

    it('files its subject as this exact copy: id, path, plugin and version', () => {
      expect(parseExtensionApprovalSubjectId(entry.locate(waiting).subjectId)).toEqual({
        id: 'flow',
        path: waiting.path,
        plugin: 'flow',
        version: '1.2.0',
      });
    });

    it('never folds a second answer about the same copy into the first', () => {
      // "Not now", then "Turn it on" a minute later, are two answers.
      expect(entry.dedupeWindowMs).toBe(0);
    });

    it('never puts the path on screen', () => {
      expect(entry.title(waiting)).not.toContain(waiting.path);
      expect(entry.body?.(waiting) ?? '').not.toContain(waiting.path);
    });
  });

  describe("an extension's decision (DOR-2523)", () => {
    const entry = notificationEntry('extension.decision');
    const open = PAYLOADS['extension.decision'];
    const resolved = (resolution: Partial<NonNullable<typeof open.resolution>>): typeof open => ({
      ...open,
      resolution: {
        outcome: 'approved',
        resolvedBy: 'person',
        resolvedByLabel: null,
        choiceLabel: 'Ship it',
        recorded: false,
        watch: null,
        ...resolution,
      },
    });

    it('asks in its own words while it is open, and says why', () => {
      expect(entry.title(open)).toBe('Ship the new out-of-usage banner?');
      expect(entry.body?.(open)).toBe(open.why);
    });

    it('says who decided once it is settled', () => {
      expect(entry.body?.(resolved({}))).toBe('Ship it · you');
      expect(entry.body?.(resolved({ resolvedBy: 'deadline', choiceLabel: 'Keep it' }))).toBe(
        'Keep it · decided by the agent'
      );
      expect(
        entry.body?.(resolved({ resolvedBy: 'agent', resolvedByLabel: 'the reviewer agent' }))
      ).toBe('Ship it · the reviewer agent');
      expect(
        entry.body?.(
          resolved({ resolvedBy: 'rule', resolvedByLabel: "your 'Tell me after' setting" })
        )
      ).toBe("Ship it · your 'Tell me after' setting");
      expect(entry.body?.(resolved({ resolvedBy: 'extension', resolvedByLabel: 'in Flow' }))).toBe(
        'Ship it · answered in Flow'
      );
      expect(entry.body?.(resolved({ outcome: 'cleared', resolvedBy: 'extension' }))).toBe(
        'Resolved on its own'
      );
      expect(entry.body?.(resolved({ outcome: 'cancelled', resolvedBy: 'extension' }))).toBe(
        'No longer needed'
      );
    });

    it('pushes a generic line that never carries the title, key or project', () => {
      const said = entry.escalation?.(open);
      expect(said).toEqual({ title: 'Flow needs you in 2 projects' });
      expect(JSON.stringify(said)).not.toContain(open.title);
      expect(JSON.stringify(said)).not.toContain(open.key);
      expect(JSON.stringify(said)).not.toContain('dorkos');
      expect(entry.escalation?.({ ...open, openProjects: 1 })).toEqual({
        title: 'Flow needs you in 1 project',
      });
      expect(entry.escalation?.({ ...open, openProjects: 0 })).toEqual({
        title: 'Flow needs you',
      });
    });

    it('is one condition per row, so a later episode of a key can still push', () => {
      expect(entry.dedupeKey(resolved({}))).toBe(entry.dedupeKey(open));
      expect(entry.dedupeKey({ ...open, decisionId: '01J0000000000000000000000E' })).not.toBe(
        entry.dedupeKey(open)
      );
      expect(entry.locate(open).subjectId).toBe(open.decisionId);
    });
  });

  it('offers approve and reject on a parked schedule and nothing on a quiet event', () => {
    expect(notificationEntry('schedule.parked').actions?.(PAYLOADS['schedule.parked'])).toEqual([
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'danger' },
    ]);
    expect(notificationEntry('update.installed').actions).toBeUndefined();
  });
});

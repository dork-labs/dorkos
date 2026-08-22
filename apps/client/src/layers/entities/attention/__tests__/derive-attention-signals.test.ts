/**
 * What is allowed to need the operator, and what is not (BC-5, BC-6, BC-39).
 *
 * @module entities/attention/__tests__/derive-attention-signals
 */
import { describe, it, expect } from 'vitest';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO, Session, Task } from '@dorkos/shared/types';
import { deriveAttentionSignals, type AttentionSources } from '../model/derive-attention-signals';

const NOW = new Date('2026-08-09T09:15:00.000Z').getTime();
const MINUTE = 60 * 1000;
const ALPHA = '/projects/alpha';

/** An ISO timestamp `ms` before {@link NOW}. */
const ago = (ms: number) => new Date(NOW - ms).toISOString();

/** A session, with everything a case does not care about filled in. */
function session(overrides: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    title: 'Ship the parser',
    cwd: ALPHA,
    createdAt: ago(6 * 60 * MINUTE),
    updatedAt: ago(2 * MINUTE),
    permissionMode: 'default',
    runtime: 'claude-code',
    ...overrides,
  };
}

/**
 * One prompt on the fleet-wide stream.
 *
 * Every case below builds these WITHOUT attaching the session to anything,
 * which is the point: the kind used to be knowable only for an attached
 * session, and now it is knowable for all of them.
 *
 * @param sessionId - The session that raised it.
 * @param interaction - What it is asking.
 */
function pending(sessionId: string, interaction: PendingInteractionDTO): InteractionPendingEvent {
  return { sessionId, cwd: ALPHA, interaction };
}

/** A permission prompt, with the fields a case does not care about filled in. */
function approvalPrompt(
  overrides: Partial<Extract<PendingInteractionDTO, { type: 'approval' }>> = {}
): PendingInteractionDTO {
  return {
    type: 'approval',
    id: 'tc-1',
    startedAt: NOW,
    remainingMs: 9 * MINUTE,
    toolName: 'Edit',
    input: JSON.stringify({ file_path: '/projects/alpha/standup.md' }),
    hasSuggestions: false,
    ...overrides,
  };
}

/** A capability approval waiting on a person. */
function approval(overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    approvalId: 'apr-1',
    capabilityId: 'files.write',
    capabilityTitle: 'Write a file',
    tier: 'destructive',
    summary: 'Write src/index.ts',
    requestedBy: 'alpha',
    hasAgentPath: true,
    requestedAt: ago(9 * MINUTE),
    expiresAt: new Date(NOW + 60 * MINUTE).toISOString(),
    ...overrides,
  };
}

/** A schedule an agent proposed and parked. */
function schedule(overrides: Partial<Task> = {}): Task {
  return {
    id: 'tsk-1',
    name: 'nightly-audit',
    displayName: 'Nightly audit',
    description: null,
    prompt: 'Audit the config migration.',
    cron: '0 3 * * *',
    timezone: 'UTC',
    agentId: null,
    enabled: false,
    maxRuntime: null,
    permissionMode: 'default',
    status: 'pending_approval',
    filePath: '/tasks/nightly-audit.json',
    createdAt: ago(20 * MINUTE),
    updatedAt: ago(20 * MINUTE),
    reason: null,
    proposedBySessionId: null,
    proposedByAgentPath: null,
    proposedByName: null,
    nextRuns: [],
    ...overrides,
  };
}

/** The whole snapshot, with everything empty unless a case says otherwise. */
function sources(overrides: Partial<AttentionSources> = {}): AttentionSources {
  return {
    approvals: [],
    schedules: [],
    sessions: [],
    lifecycles: {},
    interactions: [],
    agentNames: { [ALPHA]: 'alpha' },
    ...overrides,
  };
}

/** One session at one lifecycle — the shape most cases below need. */
function oneSession(lifecycle: SessionLifecycle, overrides: Partial<Session> = {}) {
  const s = session({ id: 'ses-1', ...overrides });
  return { sessions: [s], lifecycles: { [s.id]: lifecycle } };
}

describe('deriveAttentionSignals — membership (BC-5)', () => {
  it('turns a capability approval into a permission prompt, naming who asked', () => {
    const [signal, ...rest] = deriveAttentionSignals(sources({ approvals: [approval()] }));
    expect(rest).toEqual([]);
    expect(signal).toEqual({
      id: 'approval:apr-1',
      kind: 'permission-prompt',
      primary: 'alpha',
      secondary: 'Write a file',
      since: ago(9 * MINUTE),
      deepLink: '/',
    });
  });

  it('falls back to the capability title when nothing says who asked', () => {
    const [signal] = deriveAttentionSignals(
      sources({ approvals: [approval({ requestedBy: undefined })] })
    );
    expect(signal?.primary).toBe('Write a file');
    expect(signal?.secondary).toBeUndefined();
  });

  it('reads a blocked session as a permission prompt when it cannot see the kind', () => {
    const [signal, ...rest] = deriveAttentionSignals(sources(oneSession('blocked')));
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({
      id: 'blocked:ses-1',
      kind: 'permission-prompt',
      primary: 'alpha',
      secondary: 'Waiting on you',
      deepLink: '/session?session=ses-1&dir=%2Fprojects%2Falpha',
      agentPath: ALPHA,
    });
  });

  it('reads it as a QUESTION for a session this window never attached to (BC-39)', () => {
    const signals = deriveAttentionSignals(
      sources({
        ...oneSession('blocked'),
        interactions: [
          pending('ses-1', {
            type: 'question',
            id: 'q-7',
            startedAt: NOW - 4 * MINUTE,
            remainingMs: 6 * MINUTE,
            questions: [],
          }),
        ],
      })
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      id: 'blocked:q-7',
      kind: 'question',
      secondary: 'has a question',
      since: ago(4 * MINUTE),
    });
  });

  it('says what the agent actually asked for, not "Waiting on you"', () => {
    const [signal] = deriveAttentionSignals(
      sources({
        ...oneSession('blocked'),
        interactions: [pending('ses-1', approvalPrompt())],
      })
    );
    expect(signal?.secondary).toBe('wants to edit standup.md');
  });

  it('falls back to "Waiting on you" only when no prompt is in hand', () => {
    // A capability hold parks a turn on a person without raising one of these,
    // and a runtime can report `blocked` before its prompt arrives. Neither is a
    // reason to invent a sentence.
    const [signal] = deriveAttentionSignals(sources(oneSession('blocked')));
    expect(signal?.secondary).toBe('Waiting on you');
    expect(signal?.kind).toBe('permission-prompt');
  });

  it('reads an MCP elicitation as a permission prompt, not a question', () => {
    const [signal] = deriveAttentionSignals(
      sources({
        ...oneSession('blocked'),
        interactions: [
          pending('ses-1', {
            type: 'elicitation',
            id: 'e-1',
            startedAt: NOW,
            remainingMs: 10 * MINUTE,
            serverName: 'linear',
            message: 'Pick a team',
          }),
        ],
      })
    );
    expect(signal?.kind).toBe('permission-prompt');
  });

  it('turns a wedged session into an error', () => {
    const [signal, ...rest] = deriveAttentionSignals(sources(oneSession('error')));
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({ id: 'error:ses-1', kind: 'error' });
  });

  it('turns a parked schedule into a blockage of its own (DOR-1391)', () => {
    const [signal, ...rest] = deriveAttentionSignals(sources({ schedules: [schedule()] }));
    expect(rest).toEqual([]);
    expect(signal).toEqual({
      id: 'schedule:tsk-1',
      kind: 'schedule-approval',
      primary: 'Nightly audit',
      secondary: 'Wants to run on a timer',
      since: ago(20 * MINUTE),
      deepLink: '/tasks',
    });
  });

  it('falls back to the schedule name when nobody gave it a display name', () => {
    const [signal] = deriveAttentionSignals(
      sources({ schedules: [schedule({ displayName: null })] })
    );
    expect(signal?.primary).toBe('nightly-audit');
  });

  it('says nothing about a session that is working, however long the turn runs', () => {
    const quiet = oneSession('streaming', { updatedAt: ago(90 * MINUTE) });
    expect(deriveAttentionSignals(sources(quiet))).toEqual([]);
  });

  it('says nothing about a session that has merely gone quiet (DOR-1391)', () => {
    // The idle nudge is gone: quiet is not a blockage, and what it observed is
    // a Today digest fact now (`use-digest-facts`'s `idleWhileAwayCount`).
    // Every quietness a nudge could ever have fired on, and none of them speak.
    for (const quietFor of [45 * MINUTE, 3 * 60 * MINUTE, 20 * 60 * MINUTE]) {
      const quiet = oneSession('idle', { updatedAt: ago(quietFor) });
      expect(deriveAttentionSignals(sources(quiet))).toEqual([]);
    }
  });

  it('still raises the blockage of a quiet session that is actually blocked', () => {
    // The discriminating half of the case above: the SAME staleness, a
    // different lifecycle. Without this, "quiet says nothing" would also pass
    // for a rule that had stopped reading sessions at all.
    const parked = oneSession('blocked', { updatedAt: ago(45 * MINUTE) });
    expect(deriveAttentionSignals(sources(parked)).map((s) => s.kind)).toEqual([
      'permission-prompt',
    ]);
  });

  it('names the session itself when it belongs to no agent (DOR-203)', () => {
    const [signal] = deriveAttentionSignals(
      sources(oneSession('error', { cwd: undefined, title: 'Loose thread' }))
    );
    expect(signal?.primary).toBe('Loose thread');
    expect(signal?.agentPath).toBeUndefined();
    expect(signal?.deepLink).toBe('/session?session=ses-1');
  });

  it('escapes a project path that would otherwise truncate the deep link', () => {
    const [signal] = deriveAttentionSignals(
      sources({
        ...oneSession('error', { cwd: '/projects/a&b c' }),
        agentNames: {},
      })
    );
    expect(signal?.deepLink).toBe('/session?session=ses-1&dir=%2Fprojects%2Fa%26b+c');
  });
});

describe('deriveAttentionSignals — parked schedules (DOR-1391)', () => {
  it('raises one signal per parked schedule, and never merges two', () => {
    const signals = deriveAttentionSignals(
      sources({
        schedules: [schedule({ id: 'tsk-1' }), schedule({ id: 'tsk-2', displayName: 'Deploy' })],
      })
    );
    expect(signals.map((s) => s.id)).toEqual(['schedule:tsk-1', 'schedule:tsk-2']);
  });

  it('keeps the schedule namespace out of every other source', () => {
    // The ids are what "already seen" is keyed by (`use-blocking-arrivals`), so
    // a collision between a task id and a session id would silence a knock.
    const signals = deriveAttentionSignals(
      sources({
        schedules: [schedule({ id: 'ses-1' })],
        ...oneSession('error'),
      })
    );
    expect(signals.map((s) => s.id).sort()).toEqual(['error:ses-1', 'schedule:ses-1']);
  });

  it('says nothing about a schedule nobody parked', () => {
    // The caller filters to `pending_approval` (`usePendingScheduleApprovals`),
    // so an empty list here is the only shape this rule ever sees for an armed
    // schedule — and an armed schedule needs nobody.
    expect(deriveAttentionSignals(sources({ schedules: [] }))).toEqual([]);
  });
});

describe('deriveAttentionSignals — what can never get in (BC-5, BC-39, P2 AC-5)', () => {
  it('has no room, mention, unread or update input to be given', () => {
    // The allowlist is enforced by the SHAPE: there is nowhere in
    // `AttentionSources` to put a room, a mention count or an update-ready
    // notice, so no future branch can read one.
    //
    // **What this actually guards, exactly.** It reads the keys this file's own
    // factory supplies, which is every REQUIRED field of `AttentionSources` —
    // adding one without adding it here does not compile. It does NOT catch a
    // new OPTIONAL field, which would leave this green; that case is a review
    // question, and the docblock on `AttentionSources` is where it is answered.
    const keys = Object.keys(sources()).sort();
    expect(keys).toEqual([
      'agentNames',
      'approvals',
      'interactions',
      'lifecycles',
      'schedules',
      'sessions',
    ]);
  });

  it('treats an automated session exactly like any other — origin is not read', () => {
    // The property, not a proxy for it: run the same state past the rule twice,
    // once tagged as automated, and require identical answers. Both are
    // `blocked` so the output is non-empty — "identical" must not be satisfiable
    // by two empty lists.
    const user = session({ id: 'same' });
    const automated = session({ id: 'same', origin: 'task' });
    const forUser = deriveAttentionSignals(
      sources({ sessions: [user], lifecycles: { same: 'blocked' } })
    );
    const forAutomated = deriveAttentionSignals(
      sources({ sessions: [automated], lifecycles: { same: 'blocked' } })
    );

    expect(forUser.map((s) => s.id)).toEqual(['blocked:same']);
    expect(forAutomated).toEqual(forUser);
  });

  it('puts an automated session that IS blocked in like anything else (BC-19)', () => {
    const automated = session({ id: 'auto', origin: 'task' });
    const signals = deriveAttentionSignals(
      sources({ sessions: [automated], lifecycles: { auto: 'blocked' } })
    );
    expect(signals.map((s) => s.kind)).toEqual(['permission-prompt']);
  });

  it('emits only the four kinds, whatever it is handed', () => {
    const signals = deriveAttentionSignals(
      sources({
        approvals: [approval()],
        schedules: [schedule()],
        sessions: [
          session({ id: 'a' }),
          session({ id: 'b' }),
          session({ id: 'c', updatedAt: ago(45 * MINUTE) }),
        ],
        lifecycles: { a: 'blocked', b: 'error', c: 'idle' },
        interactions: [
          pending('a', {
            type: 'question',
            id: 'q',
            startedAt: NOW,
            remainingMs: 10 * MINUTE,
            questions: [],
          }),
        ],
      })
    );
    expect(new Set(signals.map((s) => s.kind))).toEqual(
      new Set(['permission-prompt', 'question', 'error', 'schedule-approval'])
    );
  });
});

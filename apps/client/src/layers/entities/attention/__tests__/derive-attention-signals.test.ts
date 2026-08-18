/**
 * What is allowed to need the operator, and what is not (BC-5, BC-6, BC-10,
 * BC-39).
 *
 * @module entities/attention/__tests__/derive-attention-signals
 */
import { describe, it, expect } from 'vitest';
import type { PendingApproval } from '@dorkos/shared/approval-schemas';
import type { InteractionPendingEvent } from '@dorkos/shared/interaction-events';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import type { PendingInteractionDTO, Session } from '@dorkos/shared/types';
import {
  deriveAttentionSignals,
  IDLE_NUDGE_AFTER_MS,
  IDLE_NUDGE_WINDOW_MS,
  type AttentionSources,
} from '../model/derive-attention-signals';

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

/** The whole snapshot, with everything empty unless a case says otherwise. */
function sources(overrides: Partial<AttentionSources> = {}): AttentionSources {
  return {
    now: NOW,
    approvals: [],
    sessions: [],
    lifecycles: {},
    interactions: [],
    agentNames: { [ALPHA]: 'alpha' },
    dismissed: new Set<string>(),
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
      dismissible: false,
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
      dismissible: false,
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
    expect(signal).toMatchObject({ id: 'error:ses-1', kind: 'error', dismissible: false });
  });

  it('says nothing about a session that is working, however long the turn runs', () => {
    // `updatedAt` is deliberately PAST the idle threshold. A turn that has been
    // running for an hour is the case the lifecycle guard exists for, and a
    // freshly-stamped session would have been kept out by the threshold instead
    // — the assertion would then hold with the guard deleted.
    const quiet = oneSession('streaming', { updatedAt: ago(IDLE_NUDGE_AFTER_MS + 30 * MINUTE) });
    expect(deriveAttentionSignals(sources(quiet))).toEqual([]);
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

describe('deriveAttentionSignals — the idle nudge (BC-10)', () => {
  const quietFor = (ms: number) => oneSession('idle', { updatedAt: ago(ms) });

  it('nudges about a session that has been quiet past the threshold', () => {
    const [signal, ...rest] = deriveAttentionSignals(
      sources(quietFor(IDLE_NUDGE_AFTER_MS + MINUTE))
    );
    expect(rest).toEqual([]);
    expect(signal).toMatchObject({
      id: 'idle:ses-1',
      kind: 'idle-timeout',
      secondary: 'Went quiet',
      dismissible: true,
    });
  });

  it('says nothing about a session touched a moment ago', () => {
    expect(deriveAttentionSignals(sources(quietFor(IDLE_NUDGE_AFTER_MS - MINUTE)))).toEqual([]);
  });

  it('says nothing about a session quiet for longer than a day', () => {
    expect(deriveAttentionSignals(sources(quietFor(IDLE_NUDGE_WINDOW_MS + MINUTE)))).toEqual([]);
  });

  it('raises ONE nudge however many sessions have gone quiet, the most recent', () => {
    const stale = session({ id: 'old', updatedAt: ago(5 * 60 * MINUTE) });
    const recent = session({ id: 'new', updatedAt: ago(40 * MINUTE) });
    const signals = deriveAttentionSignals(
      sources({
        sessions: [stale, recent],
        lifecycles: { old: 'idle', new: 'idle' },
      })
    );
    expect(signals.map((s) => s.id)).toEqual(['idle:new']);
  });

  it('drops a nudge the operator waved away, and leaves everything else standing', () => {
    const input = sources({
      ...quietFor(IDLE_NUDGE_AFTER_MS + MINUTE),
      approvals: [approval()],
    });
    // Both are present before the dismissal — otherwise "it is gone" says nothing.
    expect(deriveAttentionSignals(input).map((s) => s.id)).toEqual([
      'approval:apr-1',
      'idle:ses-1',
    ]);
    const after = deriveAttentionSignals({ ...input, dismissed: new Set(['idle:ses-1']) });
    expect(after.map((s) => s.id)).toEqual(['approval:apr-1']);
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
      'dismissed',
      'interactions',
      'lifecycles',
      'now',
      'sessions',
    ]);
  });

  it('treats an automated session exactly like any other — origin is not read', () => {
    // The previous version of this case seeded `origin: 'task'` on a STREAMING
    // session and asserted silence, which the lifecycle guard already produced:
    // deleting the origin changed nothing, so it proved nothing about
    // automation. This asserts the real property instead — that origin is not a
    // dimension this rule has — by running the same two states past it and
    // requiring identical answers.
    const user = session({ id: 'same', updatedAt: ago(45 * MINUTE) });
    const automated = session({ id: 'same', origin: 'task', updatedAt: ago(45 * MINUTE) });
    const forUser = deriveAttentionSignals(
      sources({ sessions: [user], lifecycles: { same: 'idle' } })
    );
    const forAutomated = deriveAttentionSignals(
      sources({ sessions: [automated], lifecycles: { same: 'idle' } })
    );

    // Both raise the nudge — an assertion on non-empty output, so "identical"
    // below cannot be satisfied by two empty lists.
    expect(forUser.map((s) => s.id)).toEqual(['idle:same']);
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
      new Set(['permission-prompt', 'question', 'error', 'idle-timeout'])
    );
  });
});

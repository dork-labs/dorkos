import { describe, it, expect } from 'vitest';
import { createMockSession } from '@dorkos/test-utils';
import type { Session } from '@dorkos/shared/types';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import {
  buildChatList,
  chatStatus,
  type BuildChatListOptions,
  type ChatListModel,
  type ChatListSort,
} from '../model/build-chat-list';

/** An ISO time `minutes` after a fixed noon, so order is plain to read. */
function at(minutes: number): string {
  return new Date(Date.UTC(2026, 9, 8, 12, minutes)).toISOString();
}

/** A chat a person started and used at `used` minutes. */
function yours(id: string, used: number, extra: Partial<Session> = {}): Session {
  return createMockSession({
    id,
    title: id,
    createdAt: at(0),
    updatedAt: at(used),
    lastTouchedByYouAt: at(used),
    ...extra,
  });
}

/** A chat `parentId` started that you never touched. */
function spinOff(id: string, parentId: string, extra: Partial<Session> = {}): Session {
  return createMockSession({
    id,
    title: id,
    origin: 'agent',
    createdAt: at(1),
    updatedAt: at(1),
    startedBy: {
      kind: 'chat',
      sessionId: parentId,
      title: `${parentId} (recorded)`,
      reason: null,
      permission: null,
    },
    ...extra,
  });
}

/** A scheduled chat you never touched. */
function automated(id: string, updated: number, extra: Partial<Session> = {}): Session {
  return createMockSession({
    id,
    title: id,
    origin: 'task',
    createdAt: at(0),
    updatedAt: at(updated),
    ...extra,
  });
}

function build(
  sessions: Session[],
  options: Partial<BuildChatListOptions> & {
    lifecycles?: Record<string, SessionLifecycle>;
    waiting?: string[];
    outOfUsage?: string[];
  } = {}
): ChatListModel {
  return buildChatList(sessions, {
    sort: options.sort ?? 'for-you',
    lifecycles: options.lifecycles ?? {},
    waitingIds: new Set(options.waiting ?? []),
    outOfUsageIds: new Set(options.outOfUsage ?? []),
    ...(options.query === undefined ? {} : { query: options.query }),
  });
}

/** Every top-level row id, section by section. */
function layout(model: ChatListModel): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const section of model.sections) out[section.id] = section.rows.map((r) => r.session.id);
  if (model.automated.length > 0) out.automated = model.automated.map((r) => r.session.id);
  return out;
}

function row(model: ChatListModel, id: string) {
  const all = [...model.sections.flatMap((s) => s.rows), ...model.automated];
  const found = all.find((r) => r.session.id === id);
  if (!found) throw new Error(`no row ${id}`);
  return found;
}

describe('chatStatus', () => {
  it('reads a waiting prompt or a blocked turn as needs you, an error as failed', () => {
    expect(chatStatus('blocked', false)).toBe('needs-you');
    expect(chatStatus('idle', true)).toBe('needs-you');
    expect(chatStatus('error', false)).toBe('failed');
    expect(chatStatus('streaming', false)).toBe('running');
    expect(chatStatus('interrupted', false)).toBe('idle');
    expect(chatStatus(null, false)).toBe('idle');
  });

  it('reads an account that ran out as out of usage, below a waiting prompt', () => {
    expect(chatStatus('idle', false, true)).toBe('out-of-usage');
    expect(chatStatus('error', false, true)).toBe('out-of-usage');
    expect(chatStatus('blocked', false, true)).toBe('needs-you');
  });
});

describe('buildChatList — For you', () => {
  it('orders needs you, then running chats that are yours, then the rest by your last use', () => {
    const model = build(
      [
        yours('old', 1),
        yours('recent', 30),
        yours('busy', 5),
        yours('stuck', 2),
        yours('broke', 3),
      ],
      { lifecycles: { busy: 'streaming', stuck: 'blocked', broke: 'error' } }
    );
    expect(layout(model)).toEqual({
      'needs-you': ['broke', 'stuck'],
      running: ['busy'],
      chats: ['recent', 'old'],
    });
    expect(model.sections.map((s) => s.label)).toEqual(['Needs you', 'Running', 'Other chats']);
  });

  it('counts a waiting question as needs you even before the phase catches up', () => {
    const model = build([yours('a', 1), yours('b', 2)], { waiting: ['a'] });
    expect(layout(model)['needs-you']).toEqual(['a']);
  });

  it('falls back to the last message you wrote, then to the last activity', () => {
    const wrote = createMockSession({
      id: 'wrote',
      origin: 'room',
      updatedAt: at(1),
      userLastMessageAt: at(40),
    });
    const untouched = createMockSession({ id: 'untouched', updatedAt: at(20) });
    const touched = yours('touched', 10);
    expect(layout(build([untouched, touched, wrote])).chats).toEqual([
      'wrote',
      'untouched',
      'touched',
    ]);
  });

  it('drops the heading when the rest is the only section', () => {
    const model = build([yours('a', 1), yours('b', 2)]);
    expect(model.sections).toHaveLength(1);
    expect(model.sections[0]?.label).toBeNull();
  });

  it('keeps the newest chat first when a fresh one is merely touched again', () => {
    expect(layout(build([yours('a', 9), yours('b', 9)])).chats).toEqual(['a', 'b']);
  });
});

describe('buildChatList — other sorts', () => {
  const sessions = [
    yours('made-first', 1, { createdAt: at(0), updatedAt: at(50), lastTouchedByYouAt: at(2) }),
    yours('made-last', 2, { createdAt: at(30), updatedAt: at(31), lastTouchedByYouAt: at(40) }),
    yours('stuck', 3, { createdAt: at(10), updatedAt: at(10) }),
    yours('busy', 4, { createdAt: at(20), updatedAt: at(20) }),
  ];
  const signals = { lifecycles: { stuck: 'blocked', busy: 'streaming' } as const };

  it('Recent activity orders by last activity, keeps Needs you, and has no Running section', () => {
    const model = build(sessions, { ...signals, sort: 'activity' });
    expect(layout(model)).toEqual({
      'needs-you': ['stuck'],
      chats: ['made-first', 'made-last', 'busy'],
    });
  });

  it('Started orders by when each chat began', () => {
    const model = build(sessions, { ...signals, sort: 'started' });
    expect(layout(model).chats).toEqual(['made-last', 'busy', 'made-first']);
  });
});

describe('buildChatList — folding (spec your-activity-first D14)', () => {
  it('rule 1: an untouched spin-off folds under its parent, with its status', () => {
    const model = build(
      [
        yours('parent', 5),
        spinOff('child-a', 'parent'),
        spinOff('child-b', 'parent', { updatedAt: at(9) }),
      ],
      { lifecycles: { 'child-b': 'streaming' } }
    );
    expect(layout(model)).toEqual({ chats: ['parent'] });
    const parent = row(model, 'parent');
    expect(parent.spinOffs.map((s) => [s.session.id, s.status])).toEqual([
      ['child-b', 'running'],
      ['child-a', 'idle'],
    ]);
  });

  it('rule 1: a spin-off of a spin-off folds under the same visible parent', () => {
    const model = build([yours('root', 5), spinOff('mid', 'root'), spinOff('leaf', 'mid')]);
    expect(layout(model)).toEqual({ chats: ['root'] });
    expect(
      row(model, 'root')
        .spinOffs.map((s) => s.session.id)
        .sort()
    ).toEqual(['leaf', 'mid']);
  });

  it('rule 2: automated chats with no parent chat sit in one group at the bottom', () => {
    const model = build([yours('mine', 1), automated('digest', 9), automated('nightly', 4)]);
    expect(layout(model)).toEqual({ chats: ['mine'], automated: ['digest', 'nightly'] });
  });

  it('rule 3: a folded spin-off that needs you is lifted to Needs you, saying where it started', () => {
    const model = build([yours('parent', 5), spinOff('asks', 'parent')], {
      lifecycles: { asks: 'blocked' },
    });
    expect(layout(model)).toEqual({ 'needs-you': ['asks'], chats: ['parent'] });
    expect(row(model, 'parent').spinOffs).toEqual([]);
    expect(row(model, 'asks').startedFrom).toBe('parent');
  });

  it('rule 3: a folded spin-off whose account ran out is lifted too', () => {
    const model = build([yours('parent', 5), spinOff('out', 'parent')], { outOfUsage: ['out'] });
    expect(layout(model)).toEqual({ 'needs-you': ['out'], chats: ['parent'] });
    expect(row(model, 'out').status).toBe('out-of-usage');
  });

  it('rule 3: an automated chat that stopped with an error is lifted too', () => {
    const model = build([automated('nightly', 4)], { lifecycles: { nightly: 'error' } });
    expect(layout(model)).toEqual({ 'needs-you': ['nightly'] });
  });

  it('rule 4: a spin-off you opened is its own row, ranked by your use, keeping Started from', () => {
    const touched = spinOff('opened', 'parent', { lastTouchedByYouAt: at(50) });
    const model = build([yours('parent', 5), yours('other', 20), touched]);
    expect(layout(model).chats).toEqual(['opened', 'other', 'parent']);
    expect(row(model, 'opened').startedFrom).toBe('parent');
    expect(row(model, 'parent').spinOffs).toEqual([]);
  });

  it('rule 4: a spin-off you wrote in counts the same way', () => {
    const wrote = spinOff('wrote', 'parent', { userLastMessageAt: at(50) });
    expect(layout(build([yours('parent', 5), wrote])).chats).toEqual(['wrote', 'parent']);
  });

  it('rule 5: a spin-off whose parent is gone is a normal row named by the recorded title', () => {
    const model = build([yours('mine', 1), spinOff('orphan', 'gone')]);
    expect(layout(model).chats).toContain('orphan');
    expect(row(model, 'orphan').startedFrom).toBe('gone (recorded)');
  });

  it('rule 5: with no recorded title the parent is "another chat"', () => {
    const orphan = spinOff('orphan', 'gone', {
      startedBy: { kind: 'chat', sessionId: 'gone', title: null, reason: null, permission: null },
    });
    expect(row(build([orphan]), 'orphan').startedFrom).toBe('another chat');
  });

  it('rule 5: a search that hides the parent still names it', () => {
    const model = build([yours('Plan launch', 5), spinOff('Draft copy', 'Plan launch')], {
      query: 'draft',
    });
    expect(layout(model)).toEqual({ chats: ['Draft copy'] });
    expect(row(model, 'Draft copy').startedFrom).toBe('Plan launch');
    expect(model.matched).toBe(1);
    expect(model.total).toBe(2);
  });

  it('rule 6: a busy spin-off never moves its parent', () => {
    const quiet = yours('quiet-parent', 1);
    const sessions = [
      quiet,
      yours('newer', 10),
      spinOff('busy-child', 'quiet-parent', { updatedAt: at(59) }),
    ];
    const signals = { lifecycles: { 'busy-child': 'streaming' } as const };
    for (const sort of ['for-you', 'activity'] satisfies ChatListSort[]) {
      expect(layout(build(sessions, { ...signals, sort })).chats).toEqual([
        'newer',
        'quiet-parent',
      ]);
    }
  });

  it('a spin-off of an automated chat folds under it inside the Automated group', () => {
    const model = build([automated('nightly', 4), spinOff('sub', 'nightly')]);
    expect(layout(model)).toEqual({ automated: ['nightly'] });
    expect(row(model, 'nightly').spinOffs.map((s) => s.session.id)).toEqual(['sub']);
  });

  it('survives a cycle in recorded parents', () => {
    const model = build([spinOff('a', 'b'), spinOff('b', 'a')]);
    const ids = [...model.sections.flatMap((s) => s.rows), ...model.automated].flatMap((r) => [
      r.session.id,
      ...r.spinOffs.map((s) => s.session.id),
    ]);
    expect(ids.sort()).toEqual(['a', 'b']);
  });
});

describe('buildChatList — placement edges the review asked for', () => {
  it('puts a running spin-off whose parent is gone in Other chats, not Running', () => {
    const model = build([yours('mine', 1), spinOff('orphan', 'gone')], {
      lifecycles: { orphan: 'streaming' },
    });
    expect(layout(model)).toEqual({ chats: ['mine', 'orphan'] });
  });

  it('breaks a tie on equal times by id, whatever order the chats arrive in', () => {
    const a = yours('a', 9);
    const b = yours('b', 9);
    expect(layout(build([a, b])).chats).toEqual(['a', 'b']);
    expect(layout(build([b, a])).chats).toEqual(['a', 'b']);
  });

  it('compares instants, not their spelling', () => {
    // The same minute written two ways, and a later one written the short way.
    const same = yours('same', 0, { lastTouchedByYouAt: '2026-10-08T12:30:00.000+00:00' });
    const later = yours('later', 0, { lastTouchedByYouAt: '2026-10-08T12:31:00Z' });
    const earlier = yours('earlier', 0, { lastTouchedByYouAt: '2026-10-08T13:29:00.000+01:00' });
    expect(layout(build([earlier, same, later])).chats).toEqual(['later', 'same', 'earlier']);
  });

  it('decides the runtime mark from every chat, not just the search results', () => {
    const model = build([yours('Plan', 1), yours('Port', 2, { runtime: 'codex' })], {
      query: 'plan',
    });
    expect(model.matched).toBe(1);
    expect(model.showRuntime).toBe(true);
  });
});

describe('buildChatList — indicators', () => {
  it('shows the runtime only when the list mixes runtimes', () => {
    expect(build([yours('a', 1), yours('b', 2)]).showRuntime).toBe(false);
    expect(build([yours('a', 1), yours('b', 2, { runtime: 'codex' })]).showRuntime).toBe(true);
  });

  it('carries when you last used each chat, or null when you never did', () => {
    const model = build([yours('a', 7), automated('auto', 3)]);
    expect(row(model, 'a').lastUsedAt).toBe(at(7));
    expect(row(model, 'auto').lastUsedAt).toBeNull();
  });

  it('prefers the live phase over the one the list carried', () => {
    const stale = yours('a', 1, { status: { lifecycle: 'streaming', limit: null } });
    expect(row(build([stale], { lifecycles: { a: 'idle' } }), 'a').status).toBe('idle');
    expect(row(build([stale]), 'a').status).toBe('running');
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { SessionStore } from '../session-store.js';
import { SESSIONS } from '../../../../../config/constants.js';
import type { TranscriptReader } from '../transcript-reader.js';
import type { PendingInteraction } from '../../messaging/interaction-wait.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
afterEach(() => vi.useRealTimers());

function fullStore() {
  const store = new SessionStore();
  for (let n = 0; n < SESSIONS.MAX_SESSIONS; n++) {
    store.ensureSession(`chat-${n}`, { permissionMode: 'default' });
    store.findSession(`chat-${n}`)!.lastActivity = n;
  }
  return store;
}

describe('session record admission at the cap (DOR-3682)', () => {
  it('starts chat 51 and reclaims the least recently used idle record, including aliases', async () => {
    const store = fullStore();
    store.findSession('chat-0')!.lastActivity = Date.now();
    await store.rebindSdkSession('chat-1', 'sdk-oldest', 'chat-1');
    store.ensureSession('new-chat', { permissionMode: 'default' });
    expect(store.findSession('new-chat')).toBeDefined();
    expect(store.findSession('chat-0')).toBeDefined();
    expect(store.findSession('chat-1')).toBeUndefined();
    expect(store.findSession('sdk-oldest')).toBeUndefined();
    expect(store.sessionIdsWhere(() => true)).toHaveLength(SESSIONS.MAX_SESSIONS);
  });

  it.each(['open', 'parked'] as const)(
    'never evicts the oldest %s turn, even after the usual expiry',
    (kind) => {
      const store = fullStore();
      const protectedSession = store.findSession('chat-0')!;
      if (kind === 'open') protectedSession.activeQuery = {} as Query;
      else
        protectedSession.pendingInteractions.set('ask', {
          startedAt: 0,
          resolve: vi.fn(),
          reject: vi.fn(),
        } as unknown as PendingInteraction);
      store.ensureSession('new-chat', { permissionMode: 'default' });
      expect(store.findSession('chat-0')).toBe(protectedSession);
      expect(store.findSession('chat-1')).toBeUndefined();
      expect(store.findSession('new-chat')).toBeDefined();
    }
  );

  it('refuses only when every record is live, with an actionable message', () => {
    const store = fullStore();
    for (const id of store.sessionIdsWhere(() => true))
      store.findSession(id)!.activeQuery = {} as Query;
    expect(() => store.ensureSession('new-chat', { permissionMode: 'default' })).toThrow(
      'All 50 chats are busy. Wait for one to finish, then try again.'
    );
    expect(store.findSession('new-chat')).toBeUndefined();
    expect(store.sessionIdsWhere(() => true)).toHaveLength(SESSIONS.MAX_SESSIONS);
  });

  it('admits two concurrent starts without losing either new chat or a live record', async () => {
    const store = fullStore();
    for (let n = 2; n < SESSIONS.MAX_SESSIONS; n++)
      store.findSession(`chat-${n}`)!.activeQuery = {} as Query;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reader = {
      hasTranscript: vi.fn(async () => {
        await gate;
        return { exists: false };
      }),
    } as unknown as TranscriptReader;
    const starts = ['new-a', 'new-b'].map((id) => store.ensureForMessage(id, reader, '/throwaway'));
    release();
    const [a, b] = await Promise.all(starts);
    expect(store.findSession('new-a')).toBe(a);
    expect(store.findSession('new-b')).toBe(b);
    expect(store.findSession('chat-0')).toBeUndefined();
    expect(store.findSession('chat-1')).toBeUndefined();
    for (let n = 2; n < SESSIONS.MAX_SESSIONS; n++)
      expect(store.findSession(`chat-${n}`)).toBeDefined();
    expect(store.sessionIdsWhere(() => true)).toHaveLength(SESSIONS.MAX_SESSIONS);
  });
});

describe('a brand-new record is protected only by its turn lock', () => {
  /** 49 live records and one idle slot; `locked` stands in for the turn lock. */
  function oneSlotStore(locked: Set<string>) {
    const store = new SessionStore({ isHoldingWork: (id) => locked.has(id) });
    for (let n = 0; n < SESSIONS.MAX_SESSIONS; n++) {
      store.ensureSession(`chat-${n}`, { permissionMode: 'default' });
      if (n !== 0) store.findSession(`chat-${n}`)!.activeQuery = {} as Query;
    }
    return store;
  }
  const reader = {
    hasTranscript: async () => ({ exists: false }),
  } as unknown as TranscriptReader;

  it('refuses the second of two locked starts rather than evicting the first', async () => {
    const locked = new Set(['new-a', 'new-b']);
    const store = oneSlotStore(locked);
    const [a, b] = await Promise.allSettled(
      ['new-a', 'new-b'].map((id) => store.ensureForMessage(id, reader, '/throwaway'))
    );
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { code: 'session_capacity_reached' } });
    expect(store.findSession('new-a')).toBeDefined();
    expect(store.findSession('new-b')).toBeUndefined();
    expect(store.getCapacity()).toMatchObject({ records: 50, live: 50, available: 0 });
  });

  it('lets an unlocked start reclaim another start’s fresh record, which is why callers lock first', async () => {
    const store = oneSlotStore(new Set());
    await Promise.all(
      ['new-a', 'new-b'].map((id) => store.ensureForMessage(id, reader, '/throwaway'))
    );
    expect(store.findSession('new-a')).toBeUndefined();
    expect(store.findSession('new-b')).toBeDefined();
    expect(store.sessionIdsWhere(() => true)).toHaveLength(SESSIONS.MAX_SESSIONS);
  });
});

describe('capacity reporting and resource retirement', () => {
  it('reports idle records as available, and uses the refusal message only when all are live', () => {
    const store = fullStore();
    expect(store.getCapacity()).toMatchObject({
      records: 50,
      live: 0,
      available: 50,
      message: null,
    });
    for (const id of store.sessionIdsWhere(() => true))
      store.findSession(id)!.activeQuery = {} as Query;
    expect(store.getCapacity()).toMatchObject({
      records: 50,
      live: 50,
      available: 0,
      message: 'All 50 chats are busy. Wait for one to finish, then try again.',
    });
  });

  it('resumes a reclaimed chat with its durable settings and transcript', async () => {
    const store = fullStore();
    store.configureSettings(
      {
        getSessionSettings: async () => ({ permissionMode: 'plan', model: 'chosen-model' }),
      } as never,
      'default'
    );
    store.ensureSession('new-chat', { permissionMode: 'default' });
    expect(store.findSession('chat-0')).toBeUndefined();
    const reader = {
      hasTranscript: async () => ({ exists: true, root: '/throwaway/claude' }),
    } as unknown as TranscriptReader;
    const resumed = await store.ensureForMessage('chat-0', reader, '/throwaway');
    expect(resumed).toMatchObject({
      permissionMode: 'plan',
      model: 'chosen-model',
      hasStarted: true,
      accountRoot: '/throwaway/claude',
    });
  });

  it('protects opening turns and background work and retires every alias of the LRU idle record', async () => {
    const retired = vi.fn();
    const store = new SessionStore({ isHoldingWork: (id) => id === 'chat-0', onEvict: retired });
    for (let n = 0; n < 50; n++) {
      store.ensureSession(`chat-${n}`, { permissionMode: 'default' });
      store.findSession(`chat-${n}`)!.lastActivity = n;
    }
    await store.rebindSdkSession('chat-1', 'first-alias', 'chat-1');
    await store.rebindSdkSession('first-alias', 'second-alias', 'first-alias');
    store.ensureSession('new-chat', { permissionMode: 'default' });
    expect(retired).toHaveBeenCalledExactlyOnceWith(['chat-1', 'first-alias', 'second-alias']);
    expect(store.findSession('chat-0')).toBeDefined();
    expect(store.findSession('first-alias')).toBeUndefined();
    expect(store.findSession('second-alias')).toBeUndefined();
    expect(store.getCapacity()).toMatchObject({ records: 50, live: 1, available: 49 });
  });
});

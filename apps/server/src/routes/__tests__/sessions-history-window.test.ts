import { MainRequestAdmission } from '../../services/core/lifecycle/main-request-admission.js';
/**
 * A long conversation leaves the server a window at a time (DOR-2889). The
 * `/events` snapshot carries the newest `HISTORY_WINDOW_LIMIT` messages and
 * counts the rest; `GET /:id/messages?before=<id>` reads the page directly
 * older than a message. A real transcript sent 15 MB of JSON per open before.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FakeAgentRuntime, collectDurableEvents } from '@dorkos/test-utils';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import type { HistoryMessage } from '@dorkos/shared/types';
import { HISTORY_PAGE_LIMIT, HISTORY_WINDOW_LIMIT } from '@dorkos/shared/schemas';
import { wrapKickoff } from '@dorkos/shared/kickoff';

// Mock boundary before importing app (same pattern as sessions.test.ts)
vi.mock('../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(async (p: string) => p),
  // The DorkHome-aware seam is the one the session-cwd routes use. It was
  // missing here and nothing noticed, because `/messages` only ever called it
  // for a caller-supplied `?cwd=` and these cases supply none. The route now
  // also judges the directory it RESOLVED (DOR-1444), so the omission became a
  // 500 rather than a silent pass.
  validateBoundaryOrDorkHome: vi.fn(async (p: string) => p),
  getBoundary: vi.fn(() => '/mock/home'),
  initBoundary: vi.fn().mockResolvedValue('/mock/home'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.name = 'BoundaryError';
      this.code = code;
    }
  },
}));

let fakeRuntime: FakeAgentRuntime;

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    listRuntimes: vi.fn(() => [fakeRuntime]),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
    resolveForSession: vi.fn(async () => fakeRuntime),
    getSessionRuntimeType: vi.fn(async () => 'fake'),
    persistSessionRuntime: vi.fn(async () => {}),
    has: vi.fn(() => true),
    getSessionSettings: vi.fn(async () => null),
    saveSessionSettings: vi.fn(async () => {}),
    getSessionSettingsMany: vi.fn(() => new Map()),
  },
  RuntimeNotRegisteredError: class RuntimeNotRegisteredError extends Error {
    constructor(
      public readonly runtime: string,
      public readonly sessionId: string
    ) {
      super(`Session '${sessionId}' is owned by runtime '${runtime}', which is not registered.`);
      this.name = 'RuntimeNotRegisteredError';
    }
  },
}));

vi.mock('../../services/core/tunnel-manager.js', () => ({
  tunnelManager: {
    status: { enabled: false, connected: false, url: null, port: null, startedAt: null },
  },
}));

vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue(null),
    set: vi.fn(),
  },
}));

vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn(async () => null),
}));

import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { composedListener } from '../../http/__tests__/composed-listener.js';
import { runtimeRegistry } from '../../services/core/runtime-registry.js';

const admission = new MainRequestAdmission();
const listener = composedListener(admission);
const testServer = listeningServer(listener);

const S1 = '00000000-0000-4000-8000-000000000001';
const KICKOFF = wrapKickoff('Read your SOUL.md and introduce yourself.');

/** `count` alternating messages with ids m0, m1, … */
function history(count: number): HistoryMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `message ${i}`,
  }));
}

function idle(messages: HistoryMessage[]): SessionSnapshot {
  return {
    messages,
    inProgressTurn: null,
    status: {
      contextUsage: null,
      cost: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'idle',
      lastError: null,
    },
    pendingInteractions: [],
    cursor: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fakeRuntime = new FakeAgentRuntime('fake');
  fakeRuntime.getSessionETag.mockResolvedValue(null);
  fakeRuntime.getInternalSessionId.mockReturnValue(undefined);
  fakeRuntime.hasSession.mockReturnValue(true);
  fakeRuntime.subscribeSession = vi.fn(async function* () {});
  vi.mocked(runtimeRegistry.resolveForSession).mockResolvedValue(fakeRuntime);
});

describe('the /events snapshot carries the newest window', () => {
  async function snapshotOf(messages: HistoryMessage[]): Promise<SessionSnapshot> {
    fakeRuntime.getSessionSnapshot.mockResolvedValue(idle(messages));
    const { frames } = await collectDurableEvents(listener, S1);
    expect(frames[0]?.event).toBe('snapshot');
    return frames[0]!.data as SessionSnapshot;
  }

  it('sends only the newest messages of a long history and counts the rest', async () => {
    const snap = await snapshotOf(history(HISTORY_WINDOW_LIMIT + 40));

    expect(snap.messages).toHaveLength(HISTORY_WINDOW_LIMIT);
    expect(snap.messages[0]!.id).toBe('m40');
    expect(snap.messages.at(-1)!.id).toBe(`m${HISTORY_WINDOW_LIMIT + 39}`);
    expect(snap.earlierMessages).toBe(40);
  });

  it('sends a short history whole, with no count', async () => {
    const snap = await snapshotOf(history(HISTORY_WINDOW_LIMIT));

    expect(snap.messages).toHaveLength(HISTORY_WINDOW_LIMIT);
    expect(snap).not.toHaveProperty('earlierMessages');
  });

  it('drops the kickoff before counting, so the count is of real messages', async () => {
    const snap = await snapshotOf([
      { id: 'kick', role: 'user', content: KICKOFF },
      ...history(HISTORY_WINDOW_LIMIT + 1),
    ]);

    expect(snap.earlierMessages).toBe(1);
    expect(JSON.stringify(snap)).not.toContain('dork-kickoff');
  });
});

describe('GET /api/sessions/:id/messages?before= reads the page before a message', () => {
  it('answers the whole history without a cursor', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue(history(300));

    const res = await request(testServer).get(`/api/sessions/${S1}/messages`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(300);
    expect(res.body.earlierMessages).toBeUndefined();
  });

  it('answers the page directly older than the named message, and what remains', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue(history(300));

    const res = await request(testServer).get(`/api/sessions/${S1}/messages?before=m250`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(HISTORY_PAGE_LIMIT);
    expect(res.body.messages[0].id).toBe(`m${250 - HISTORY_PAGE_LIMIT}`);
    expect(res.body.messages.at(-1).id).toBe('m249');
    expect(res.body.earlierMessages).toBe(250 - HISTORY_PAGE_LIMIT);
  });

  it('answers a short last page with nothing remaining', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue(history(300));

    const res = await request(testServer).get(`/api/sessions/${S1}/messages?before=m30`);

    expect(res.body.messages.map((m: HistoryMessage) => m.id)).toEqual(
      history(30).map((m) => m.id)
    );
    expect(res.body.earlierMessages).toBe(0);
  });

  it('never serves the kickoff on a page', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue([
      { id: 'kick', role: 'user', content: KICKOFF },
      ...history(5),
    ]);

    const res = await request(testServer).get(`/api/sessions/${S1}/messages?before=m3`);

    expect(res.body.messages.map((m: HistoryMessage) => m.id)).toEqual(['m0', 'm1', 'm2']);
    expect(res.body.earlierMessages).toBe(0);
  });

  it('answers 404 for a message the history does not hold', async () => {
    fakeRuntime.getMessageHistory.mockResolvedValue(history(10));

    const res = await request(testServer).get(`/api/sessions/${S1}/messages?before=gone`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('HISTORY_CURSOR_UNKNOWN');
  });
});

/**
 * Shared setup for the session-mapper tests, split from one file by subject.
 */
import { vi, type Mock } from 'vitest';
import type {
  Session as OpenCodeSession,
  UserMessage,
  AssistantMessage,
  Part,
  OpencodeClient,
} from '@opencode-ai/sdk';
import { type OpenCodeClientProvider } from '../../sessions/session-mapper.js';

export const PROJECT_DIR = '/work/project';

export const DORKOS_ID = '3f2b8c1e-9d4a-4b6f-8a1c-2e5d7f9b0a3c';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const CREATED_MS = 1_751_400_000_000;

export const UPDATED_MS = 1_751_403_600_000;

/** Shared helper for the session-mapper tests: `ocSession`. */
export function ocSession(overrides: Partial<OpenCodeSession> = {}): OpenCodeSession {
  return {
    id: 'ses_abc123',
    projectID: 'prj_1',
    directory: PROJECT_DIR,
    title: 'Fix the flaky test',
    version: '1.17.13',
    time: { created: CREATED_MS, updated: UPDATED_MS },
    ...overrides,
  };
}

/** Shared helper for the session-mapper tests: `userMessage`. */
export function userMessage(overrides: Partial<UserMessage> = {}): UserMessage {
  return {
    id: 'msg_user1',
    sessionID: 'ses_abc123',
    role: 'user',
    time: { created: CREATED_MS },
    agent: 'build',
    model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' },
    ...overrides,
  };
}

/** Shared helper for the session-mapper tests: `assistantMessage`. */
export function assistantMessage(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    id: 'msg_asst1',
    sessionID: 'ses_abc123',
    role: 'assistant',
    time: { created: CREATED_MS + 1_000, completed: CREATED_MS + 5_000 },
    parentID: 'msg_user1',
    modelID: 'claude-sonnet-4-5',
    providerID: 'anthropic',
    mode: 'build',
    path: { cwd: PROJECT_DIR, root: PROJECT_DIR },
    cost: 0.01,
    tokens: { input: 100, output: 50, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  };
}

/** Shared helper for the session-mapper tests: `textPart`. */
export function textPart(
  text: string,
  overrides: Partial<Extract<Part, { type: 'text' }>> = {}
): Part {
  return {
    id: `prt_${text.slice(0, 8)}`,
    sessionID: 'ses_abc123',
    messageID: 'msg_asst1',
    type: 'text',
    text,
    ...overrides,
  };
}

/** Shared helper for the session-mapper tests: `toolPart`. */
export function toolPart(state: Extract<Part, { type: 'tool' }>['state']): Part {
  return {
    id: 'prt_tool1',
    sessionID: 'ses_abc123',
    messageID: 'msg_asst1',
    type: 'tool',
    callID: 'call_1',
    tool: 'bash',
    state,
  };
}

/** Shared helper for the session-mapper tests: `createMockClient`. */
export function createMockClient(): {
  session: { list: Mock; create: Mock; get: Mock; messages: Mock };
} {
  return {
    session: {
      list: vi.fn(),
      create: vi.fn(),
      get: vi.fn(),
      messages: vi.fn(),
    },
  };
}

export type MockClient = ReturnType<typeof createMockClient>;

/**
 * Serve `sessions` the way the real sidecar does — honouring `limit`, and
 * honouring `directory` as EXACT STRING EQUALITY unless `scope=project` widens
 * the read (both live-verified on 1.18.15; see NOTES.md §8).
 *
 * The directory half is what makes these tests able to fail: a mock that hands
 * back every session regardless of `directory` models a sidecar that does the
 * adapter's job for it, so the subfolder cases would pass with or without the
 * widening — which is the bug DOR-674 was. Tests that hand back a fixed array
 * regardless of `limit` model a sidecar that IGNORES it, which is precisely what
 * the probe is built to reject.
 */
export function serveSessions(client: MockClient, sessions: OpenCodeSession[]): void {
  client.session.list.mockImplementation(
    ({ query }: { query: { limit: number; directory: string; scope?: 'project' } }) => {
      const visible =
        query.scope === 'project'
          ? sessions
          : sessions.filter((s) => s.directory === query.directory);
      return Promise.resolve({ data: visible.slice(0, query.limit) }) as never;
    }
  );
}

/**
 * A sidecar that drops `limit` and serves its own fixed page — the future
 * upgrade this guard exists for. `cap` is deliberately varied across tests:
 * pinning the check to any single value is the hole being closed.
 */
export function serveWithCapIgnoringLimit(
  client: MockClient,
  sessions: OpenCodeSession[],
  cap: number
): void {
  client.session.list.mockImplementation(
    () => Promise.resolve({ data: sessions.slice(0, cap) }) as never
  );
}

/** Shared helper for the session-mapper tests: `asClient`. */
export function asClient(mock: MockClient): OpencodeClient {
  return mock as unknown as OpencodeClient;
}

/** Shared helper for the session-mapper tests: `createProvider`. */
export function createProvider(client: MockClient | null): OpenCodeClientProvider & {
  getClient: ReturnType<typeof vi.fn>;
  peekClient: ReturnType<typeof vi.fn>;
} {
  return {
    getClient: vi.fn(async () => {
      if (!client) throw new Error('sidecar unavailable');
      return asClient(client);
    }),
    peekClient: vi.fn(() => (client ? asClient(client) : null)),
  };
}

/**
 * Catch-all error classification in `executeSdkQuery`.
 *
 * A pre-stream credential failure (the classic first-run "not signed in" case)
 * throws out of the SDK query before any typed error event reaches the mappers.
 * The catch-all must classify that raw thrown message: an auth failure earns the
 * `auth_error` category (so the client offers "Fix sign-in"), while an ordinary
 * failure stays `execution_error`. The raw message must always survive in
 * `details` so nothing is hidden from the user.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { query } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi.fn().mockResolvedValue('<env>mock</env>'),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
  buildAllowedTools: vi.fn().mockReturnValue(undefined),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn().mockReturnValue(undefined) },
}));
vi.mock('../../../../core/credential-env.js', () => ({
  resolveClaudeCredentialEnv: vi.fn().mockResolvedValue({}),
}));
vi.mock('../../sdk/context-usage.js', () => ({
  fetchContextBreakdown: vi.fn().mockResolvedValue(undefined),
}));
// Keep the mapper inert so the only `error` event is the catch-all's, not a
// mapped one — this test pins the catch-all classification, nothing else.
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  mapSdkMessage: vi.fn(async function* () {}),
}));

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return { cwd: '/mock/project', sdkSessionIndex: new Map(), sessionMapKey: 's1', ...overrides };
}

/** Drive one turn whose SDK stream throws `error`, collecting yielded events. */
async function runThrowingTurn(error: Error, session = makeSession()): Promise<StreamEvent[]> {
  vi.mocked(query).mockImplementation(
    () =>
      ({
        // eslint-disable-next-line require-yield -- the stream throws before any yield
        [Symbol.asyncIterator]: async function* (): AsyncGenerator<never> {
          throw error;
        },
      }) as unknown as ReturnType<typeof query>
  );
  const events: StreamEvent[] = [];
  for await (const event of executeSdkQuery('s1', 'hello', session, makeOpts())) {
    events.push(event);
  }
  return events;
}

/** The `data` payload of the single emitted `error` event. */
function errorData(events: StreamEvent[]): Record<string, unknown> {
  const error = events.find((e) => e.type === 'error');
  return error?.data as Record<string, unknown>;
}

describe('executeSdkQuery — catch-all error classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies a thrown pre-stream auth failure as auth_error and keeps the raw message in details', async () => {
    const events = await runThrowingTurn(
      new Error('API Error: 401 OAuth access token has been revoked.')
    );

    const data = errorData(events);
    expect(data.category).toBe('auth_error');
    expect(data.details).toContain('OAuth access token has been revoked');
  });

  it('leaves an ordinary thrown failure as execution_error', async () => {
    const events = await runThrowingTurn(new Error('spawn claude ENOENT'));

    const data = errorData(events);
    expect(data.category).toBe('execution_error');
    expect(data.details).toContain('ENOENT');
  });
});

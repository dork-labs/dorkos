/**
 * Auto-mode guard at the SDK-options seam.
 *
 * `permissionMode: 'auto'` is only accepted by models that report
 * `supportsAutoMode`; anything else makes the SDK reject the query with a 400.
 * The model-capability cache can legitimately be cold (fresh process, expired
 * 24h TTL), which reports "unknown" rather than "unsupported" — and a send must
 * survive that. These tests pin the two things that must hold on the uncertain
 * path: the SDK is handed `default`, and the operator's stored `auto` choice is
 * left alone so it resumes as soon as the capability loads.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import type { StreamEvent } from '@dorkos/shared/types';
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
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
// Keep the mapper inert: this test reads the SDK options and the guard's own
// system_status, neither of which comes from mapped output.
vi.mock('../../sdk/sdk-event-mapper.js', () => ({
  mapSdkMessage: vi.fn(async function* () {}),
}));

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'auto',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
    ...overrides,
  };
}

/** The turn-completion `result` SDK message. */
function resultMsg(): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid: 'result-uuid',
    session_id: 'sdk-1',
    is_error: false,
  } as unknown as SDKMessage;
}

/** Drive one turn, returning the SDK `Options` and every yielded StreamEvent. */
async function runTurn(
  session: AgentSession,
  opts: Partial<MessageSenderOpts>
): Promise<{ options: Options; events: StreamEvent[] }> {
  let capturedOptions: Options | undefined;
  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return {
      [Symbol.asyncIterator]: async function* () {
        yield resultMsg();
      },
    } as unknown as ReturnType<typeof query>;
  });
  const events: StreamEvent[] = [];
  const messageOpts: MessageSenderOpts = {
    cwd: '/mock/project',
    onSdkSessionRebind: async () => {},
    ...opts,
  };
  for await (const event of executeSdkQuery('s1', 'hello', session, messageOpts)) {
    events.push(event);
  }
  return { options: capturedOptions!, events };
}

describe('executeSdkQuery — auto-mode guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends default when auto support is UNKNOWN, without claiming auto is unavailable', async () => {
    const session = makeSession();

    const { options, events } = await runTurn(session, { modelSupportsAutoMode: undefined });

    expect(options.permissionMode).toBe('default');
    // This branch also fires permanently for a model id the cache never learns,
    // so the explanation must not assert something nobody established.
    expect(events).toContainEqual({
      type: 'system_status',
      data: {
        message: "Couldn't confirm Auto mode works on this model — running this turn in Default.",
      },
    });
    // The operator's choice survives the downgrade: Auto returns for free once
    // the model capability loads.
    expect(session.permissionMode).toBe('auto');
  });

  it('sends default and states the fact when the model explicitly lacks auto', async () => {
    const session = makeSession();

    const { options, events } = await runTurn(session, { modelSupportsAutoMode: false });

    expect(options.permissionMode).toBe('default');
    expect(events).toContainEqual({
      type: 'system_status',
      data: { message: "Auto mode isn't available on this model — using Default instead." },
    });
    expect(session.permissionMode).toBe('auto');
  });

  it('sends auto untouched (and stays quiet) when the model supports it', async () => {
    const session = makeSession();

    const { options, events } = await runTurn(session, { modelSupportsAutoMode: true });

    expect(options.permissionMode).toBe('auto');
    expect(events.some((event) => event.type === 'system_status')).toBe(false);
  });
});

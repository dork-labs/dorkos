import { beforeEach, vi } from 'vitest';
import { runtimeConformance } from '@dorkos/test-utils';
import { wrapSdkQuery, sdkError, sdkSimpleText } from './sdk-scenarios.js';

// Purpose: ClaudeCodeRuntime must clear the SAME shared conformance gate as
// the stateless TestModeRuntime (spec additional-agent-runtimes, task 1.5).
// The SDK is fully mocked — this suite must NEVER require the real `claude`
// binary. Mock preamble mirrors claude-code-runtime.test.ts.

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
  renameSession: vi.fn(),
  forkSession: vi.fn(),
  getSessionInfo: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    withTag: vi.fn().mockReturnThis(),
  },
  initLogger: vi.fn(),
}));
vi.mock('../messaging/context-builder.js', () => ({
  buildSystemPromptAppend: vi
    .fn()
    .mockResolvedValue('<env>\nWorking directory: /projects/conformance\n</env>'),
  renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
}));
vi.mock('../tooling/tool-filter.js', () => ({
  resolveToolConfig: vi
    .fn()
    .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
  buildAllowedTools: vi.fn().mockReturnValue(undefined),
}));
vi.mock('@dorkos/shared/manifest', () => ({
  readManifest: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../tasks/task-state.js', () => ({
  isTasksEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn().mockReturnValue({
      tasksTools: true,
      relayTools: true,
      meshTools: true,
      adapterTools: true,
    }),
  },
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/projects/conformance'),
  getBoundary: vi.fn().mockReturnValue('/projects'),
  initBoundary: vi.fn().mockResolvedValue('/projects'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));
// Filesystem command scanner — never read a real .claude/commands/ dir.
vi.mock('../tooling/command-registry.js', () => ({
  CommandRegistryService: vi.fn().mockImplementation(() => ({
    getCommands: vi.fn().mockResolvedValue({ commands: [], lastScanned: new Date().toISOString() }),
    invalidateCache: vi.fn(),
  })),
}));
vi.mock('../../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: vi.fn(), addClient: vi.fn(), clientCount: 0 },
}));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dorkos-conformance'),
}));
vi.mock('../../../marketplace/installed-scanner.js', () => ({
  listEnabledPluginNames: vi.fn().mockResolvedValue([]),
}));
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: vi.fn().mockResolvedValue([]),
}));
// checkDependencies() shells out to `claude --version` for real — mock the
// probe so conformance never spawns (or requires) the binary.
vi.mock('../tooling/check-dependency.js', () => ({
  checkClaudeDependency: vi.fn().mockReturnValue({
    name: 'Claude Code CLI',
    description: 'The Claude Code CLI powers agent sessions in DorkOS.',
    status: 'satisfied',
    version: '0.0.0-mock',
  }),
}));

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeRuntime } from '../claude-code-runtime.js';

const mockedQuery = vi.mocked(query);

beforeEach(() => {
  mockedQuery.mockReset();
  // mockImplementation (not mockReturnValue): every sendMessage turn must get
  // a FRESH generator — a spent one would end the stream with zero events.
  mockedQuery.mockImplementation(
    () =>
      wrapSdkQuery(sdkSimpleText('Echo: conformance ping')) as unknown as ReturnType<typeof query>
  );
});

runtimeConformance(
  () => new ClaudeCodeRuntime('/tmp/dorkos-conformance', '/projects/conformance'),
  {
    name: 'ClaudeCodeRuntime (mocked SDK) — AgentRuntime conformance',
    // The mocked SDK writes no JSONL transcript, so native history is [] here;
    // real-binary history round-trips are covered by integration smokes.
    expectHistory: false,
    // One-shot failing turn: the SDK stream ends in a non-success result
    // (error_during_execution), driving the result-event-mapper's typed error
    // + terminal done path. mockImplementationOnce takes precedence over the
    // beforeEach default for exactly the next query() call, which is this
    // runtime's next sendMessage turn.
    makeFailingRuntime: () => {
      mockedQuery.mockImplementationOnce(
        () =>
          wrapSdkQuery(sdkError('Simulated SDK execution failure')) as unknown as ReturnType<
            typeof query
          >
      );
      return new ClaudeCodeRuntime('/tmp/dorkos-conformance', '/projects/conformance');
    },
  }
);

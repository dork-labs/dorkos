/**
 * DOR-132 — runtime-neutral context channel, Phase 1.
 *
 * The Claude adapter must set `excludeDynamicSections: true` on the
 * `claude_code` preset so the SDK stops injecting its native
 * working-directory / auto-memory / git-status sections. DorkOS's own
 * server-derived `<git_status>` block (rendered via `renderContextEntry` from
 * the additional-context bag) then becomes the single source of truth, ending
 * the per-turn git double-injection (ADR-0273 decision A2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { executeSdkQuery, type MessageSenderOpts } from '../message-sender.js';
import type { AgentSession } from '../../agent-types.js';
import { query, type Options } from '@anthropic-ai/claude-agent-sdk';

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
  resolveToolConfig: vi.fn().mockReturnValue({
    tasks: true,
    relay: true,
    mesh: true,
    adapter: true,
  }),
}));
vi.mock('../../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/project'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/project'),
}));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
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
  configManager: {
    get: vi.fn().mockReturnValue(undefined),
  },
}));

function makeSession(): AgentSession {
  return {
    sdkSessionId: 'sdk-1',
    lastActivity: Date.now(),
    permissionMode: 'default',
    hasStarted: false,
    pendingInteractions: new Map(),
    eventQueue: [],
  };
}

function makeOpts(overrides: Partial<MessageSenderOpts> = {}): MessageSenderOpts {
  return {
    cwd: '/mock/project',
    onSdkSessionRebind: async () => {},
    ...overrides,
  };
}

/**
 * Drive executeSdkQuery against an empty SDK stream and return the `Options`
 * that were passed to the SDK `query()` call.
 */
async function captureSdkOptions(
  messageOpts?: Parameters<typeof executeSdkQuery>[4]
): Promise<Options> {
  let capturedOptions: Options | undefined;

  vi.mocked(query).mockImplementation((args) => {
    capturedOptions = args.options;
    return {
      [Symbol.asyncIterator]: async function* () {}, // empty SDK stream
    } as unknown as ReturnType<typeof query>;
  });

  for await (const _event of executeSdkQuery(
    's1',
    'hello',
    makeSession(),
    makeOpts(),
    messageOpts
  )) {
    // drain
  }

  return capturedOptions!;
}

describe('executeSdkQuery — system prompt (DOR-132)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets excludeDynamicSections: true on the claude_code preset', async () => {
    const options = await captureSdkOptions();

    expect(options.systemPrompt).toEqual(
      expect.objectContaining({
        type: 'preset',
        preset: 'claude_code',
        excludeDynamicSections: true,
      })
    );
  });

  it('still forwards the DorkOS system-prompt append alongside the strip flag', async () => {
    const options = await captureSdkOptions();

    expect(options.systemPrompt).toMatchObject({
      append: '<env>mock</env>',
      excludeDynamicSections: true,
    });
  });

  it('puts a caller’s append AFTER DorkOS’s own, never before it', async () => {
    // Order is the whole point of the seam, not a formatting detail. What
    // DorkOS says about the agent — who it is, what it may reach, where it is
    // working — is the same on every turn of a session, so it belongs at the
    // FRONT of the append where it stays inside the prompt cache's stable
    // prefix. A caller's own instructions change more often (a room's `ROOM.md`
    // moves when a merge lands, spec `project-rooms` §3.3), and putting them
    // first would push the whole stable half of the prompt down the moment they
    // did.
    const options = await captureSdkOptions({
      systemPromptAppend: '<dorkos_room_conventions/>',
    });

    const append = (options.systemPrompt as { append?: string }).append ?? '';
    expect(append.indexOf('<env>mock</env>')).toBeGreaterThanOrEqual(0);
    expect(append.indexOf('<dorkos_room_conventions/>')).toBeGreaterThan(
      append.indexOf('<env>mock</env>')
    );
  });
});

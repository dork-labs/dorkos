import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { createTestDb } from '@dorkos/test-utils/db';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK before importing agent-manager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
  BoundaryError: class BoundaryError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.code = code;
    }
  },
}));

// Mock the canonical paths so that ClaudeCodeRuntime's direct imports are intercepted.
const { contextBuilderFactory } = vi.hoisted(() => ({
  contextBuilderFactory: () => ({
    buildSystemPromptAppend: vi.fn().mockResolvedValue({
      text: '<env>\nWorking directory: /mock\n</env>',
      stable: '<env>\nWorking directory: /mock\n</env>',
    }),
    renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
  }),
}));
vi.mock('../messaging/context-builder.js', contextBuilderFactory);
vi.mock('@dorkos/shared/manifest', async () => ({
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
// Only the global plugin set is SDK-injected now; mock it to empty so
// sendMessage never touches the real filesystem or breaks fake-timer timing.
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: vi.fn().mockResolvedValue([]),
}));

// Mock child_process and fs to prevent resolveClaudeCliPath side effects
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn(() => {
      throw new Error('not found');
    }),
  };
});
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
  };
});

import { ClaudeCodeRuntime } from '../claude-code-runtime.js';
import { SESSIONS } from '../../../../config/constants.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';

const mockedQuery = vi.mocked(query);

/** Add stub SDK query methods to a mock async iterable so it matches the real shape. */
function withQueryMethods<T extends object>(obj: T): T {
  return Object.assign(obj, {
    supportedModels: vi.fn().mockResolvedValue([]),
    supportedCommands: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
  });
}

describe('ClaudeCodeRuntime interactive tools', () => {
  let manager: ClaudeCodeRuntime;
  let settingsDb: ReturnType<typeof createTestDb> | undefined;

  beforeEach(async () => {
    vi.stubEnv('CLAUDE_CONFIG_DIR', '/mock/claude-code-test-account');
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'])
      vi.stubEnv(key, '');
    vi.useFakeTimers();
    // Re-arm after the previous case's `vi.resetAllMocks()`, which drops queued
    // implementations along with call history. Before the append became a typed
    // object this went unnoticed: an un-armed mock resolved `undefined`, the
    // resolver interpolated it, and every one of these turns ran with the
    // literal string "undefined" as its system prompt.
    const { buildSystemPromptAppend } = await import('../messaging/context-builder.js');
    vi.mocked(buildSystemPromptAppend).mockResolvedValue({
      text: '<env>\nWorking directory: /mock\n</env>',
      stable: '<env>\nWorking directory: /mock\n</env>',
    });
    manager = new ClaudeCodeRuntime('/tmp/dorkos-test', '/tmp/test-cwd');
    const settingsOwner = new RuntimeRegistry();
    settingsDb = createTestDb();
    settingsOwner.setDb(settingsDb);
    manager.setSessionSettings(settingsOwner);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
    // Vitest 4: restoreAllMocks only touches vi.spyOn spies, so reset
    // vi.mock/vi.fn mocks (call history + queued implementations) explicitly.
    vi.resetAllMocks();
    vi.restoreAllMocks();
    settingsDb?.$client.close();
    settingsDb = undefined;
  });

  // ---- checkSessionHealth ----

  describe('checkSessionHealth', () => {
    it('removes expired sessions after SESSION_TIMEOUT_MS', () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });
      expect(manager.hasSession('sess-1')).toBe(true);

      // Advance time past the 30-minute session timeout
      vi.advanceTimersByTime(31 * 60 * 1000);

      manager.checkSessionHealth();
      expect(manager.hasSession('sess-1')).toBe(false);
    });

    it('cleans up pending interactions of expired sessions', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      // Create a sendMessage flow that registers a pending interaction,
      // then expire the session. We simulate this by starting sendMessage
      // with a canUseTool that blocks.
      const toolApprovalPromise = new Promise<void>((resolve) => {
        // We create a mock SDK that triggers canUseTool with a tool approval
        const mockAsyncIterable = {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              new Promise<{ done: boolean; value?: unknown }>(() => {
                // Never resolves - simulates waiting for SDK
              }),
          }),
        };
        mockedQuery.mockReturnValue(
          withQueryMethods(mockAsyncIterable) as unknown as ReturnType<typeof query>
        );
        resolve();
      });

      await toolApprovalPromise;

      // Start consuming sendMessage (will call query())
      const gen = manager.sendMessage('sess-1', 'hello');
      // Pull the first value to kick off the generator (it will block on SDK)
      const _firstResult = gen.next();
      // Flush microtasks so the generator passes its awaits (per-cwd plugin
      // resolution, boundary validation) and parks on the never-resolving SDK
      // iterator while the query mock is still in scope — otherwise it would
      // resume after afterEach restores the mock and hit an undefined query.
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the in-flight bound. The turn above never finishes, and a
      // running turn is not idle at thirty-one minutes (DOR-2681); it is
      // evicted only once it has outrun the background-work ceiling.
      vi.advanceTimersByTime(SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS + 60 * 1000);
      manager.checkSessionHealth();

      expect(manager.hasSession('sess-1')).toBe(false);
    });
  });

  // ---- sendMessage integration ----

  describe('sendMessage', () => {
    it('sends default instead of auto while the model cache cannot confirm auto support', async () => {
      // Auto only works on models that report it, and the SDK rejects the whole
      // query otherwise. With no cached capability for this model (cold cache),
      // the runtime sends the safe mode rather than gambling the turn. The
      // operator's stored choice is untouched and the send explains itself —
      // both pinned in message-sender-auto-mode.test.ts, along with the
      // pass-through once the capability IS known.
      manager.ensureSession('sess-1', { permissionMode: 'auto' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue(
        withQueryMethods({
          [Symbol.asyncIterator]: () => mockIterator,
        }) as unknown as ReturnType<typeof query>
      );

      const events: StreamEvent[] = [];
      for await (const event of manager.sendMessage('sess-1', 'hi')) {
        events.push(event);
      }

      expect(mockedQuery).toHaveBeenCalledOnce();
      const callArgs = mockedQuery.mock.calls[0][0] as { options: { permissionMode: string } };
      expect(callArgs.options.permissionMode).toBe('default');
      expect(events.some((event) => event.type === 'system_status')).toBe(true);
    });

    it('sets allowDangerouslySkipPermissions for bypassPermissions mode', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      const mockIterator = {
        next: vi
          .fn()
          .mockResolvedValueOnce({
            done: false,
            value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
          })
          .mockResolvedValueOnce({ done: true }),
      };
      mockedQuery.mockReturnValue(
        withQueryMethods({
          [Symbol.asyncIterator]: () => mockIterator,
        }) as unknown as ReturnType<typeof query>
      );

      for await (const _event of manager.sendMessage('sess-1', 'hi')) {
        // drain
      }

      expect(mockedQuery).toHaveBeenCalledOnce();
      const callArgs = mockedQuery.mock.calls[0][0] as {
        options: { permissionMode: string; allowDangerouslySkipPermissions?: boolean };
      };
      expect(callArgs.options.permissionMode).toBe('bypassPermissions');
      expect(callArgs.options.allowDangerouslySkipPermissions).toBe(true);
    });

    // Power flows downstream, never up (spec `trusted-by-default-flip` §4): a
    // conversation already at Full autonomy that a stranger's message (or a
    // lower agent's post) wakes runs THAT turn at no more than the ceiling,
    // and the next turn without one runs at the session's own level again.
    describe('a turn held to a permission ceiling', () => {
      function initOnly() {
        const mockIterator = {
          next: vi
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
            })
            .mockResolvedValueOnce({ done: true }),
        };
        mockedQuery.mockReturnValueOnce(
          withQueryMethods({
            [Symbol.asyncIterator]: () => mockIterator,
          }) as unknown as ReturnType<typeof query>
        );
      }
      const modeOfCall = (n: number) =>
        (mockedQuery.mock.calls[n]![0] as { options: { permissionMode: string } }).options
          .permissionMode;

      it('launches a Full autonomy conversation at the runtime default for a stranger’s turn', async () => {
        manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });
        initOnly();
        for await (const _event of manager.sendMessage('sess-1', 'hi', {
          permissionCeiling: 'runtime-default',
        })) {
          // drain
        }
        expect(modeOfCall(0)).toBe('default');
      });

      it('holds an Accept edits ceiling from another agent below Full autonomy', async () => {
        manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });
        initOnly();
        for await (const _event of manager.sendMessage('sess-1', 'hi', {
          permissionCeiling: { asks: 'when-risky', reach: 'edit' },
        })) {
          // drain
        }
        expect(modeOfCall(0)).toBe('acceptEdits');
      });

      it('never rewrites the session’s own level, so the next turn runs at it again', async () => {
        manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });
        initOnly();
        for await (const _event of manager.sendMessage('sess-1', 'hi', {
          permissionCeiling: 'runtime-default',
        })) {
          // drain
        }
        initOnly();
        for await (const _event of manager.sendMessage('sess-1', 'again')) {
          // drain
        }
        expect(modeOfCall(0)).toBe('default');
        expect(modeOfCall(1)).toBe('bypassPermissions');
      });

      it('leaves a session already below the ceiling where it is', async () => {
        manager.ensureSession('sess-1', { permissionMode: 'plan' });
        initOnly();
        for await (const _event of manager.sendMessage('sess-1', 'hi', {
          permissionCeiling: { asks: 'never', reach: 'everything' },
        })) {
          // drain
        }
        expect(modeOfCall(0)).toBe('plan');
      });
    });
  });

  // ---- canUseTool callback integration (via sendMessage) ----

  describe('canUseTool integration', () => {
    it('AskUserQuestion pushes question_prompt and submitAnswers resolves it', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      // Capture the canUseTool callback from query options

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              // This next() will block until we resolve the canUseTool promise
              .mockImplementationOnce(
                () =>
                  new Promise(() => {
                    // Never resolves - we test the interaction flow before SDK continues
                  })
              ),
          };
          return withQueryMethods({
            [Symbol.asyncIterator]: () => mockIterator,
          }) as unknown as ReturnType<typeof query>;
        }
      );

      // Start consuming sendMessage
      const gen = manager.sendMessage('sess-1', 'ask me');
      const _collectedEvents: StreamEvent[] = [];

      // Pull the first event (init is consumed internally, no yield)
      // The generator will block on the second SDK next() call,
      // but we need canUseTool to fire first.
      // We need to advance: pull from gen which races SDK next + queue
      const pullPromise = gen.next();

      // Flush microtasks so validateBoundary() resolves and query() is called
      await vi.advanceTimersByTimeAsync(0);

      // Now invoke canUseTool as if the SDK called it
      const questions = [
        { header: 'Test', question: 'Pick one?', options: [{ label: 'A' }], multiSelect: false },
      ];
      const permissionPromise = canUseToolFn!(
        'AskUserQuestion',
        { questions },
        { signal: new AbortController().signal, toolUseID: 'tool-q1' }
      );

      // The question_prompt event should be in the queue, so the generator should yield it
      const firstEvent = await pullPromise;
      expect(firstEvent.done).toBe(false);
      expect(firstEvent.value.type).toBe('question_prompt');
      expect((firstEvent.value.data as { toolCallId: string }).toolCallId).toBe('tool-q1');

      // Submit answers in the client's canonical (index-keyed) format.
      const submitted = manager.submitAnswers('sess-1', 'tool-q1', { '0': 'A' });
      expect(submitted).toBe(true);

      // canUseTool resolves with allow + updatedInput, with the answers
      // re-keyed by question text so the SDK's executor can match them.
      const permissionResult = await permissionPromise;
      expect(permissionResult).toEqual({
        behavior: 'allow',
        updatedInput: { questions, answers: { 'Pick one?': 'A' } },
      });
    });

    it('RT-TOOL-01: tool approval in default mode pushes approval_required and approveTool resolves it', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return withQueryMethods({
            [Symbol.asyncIterator]: () => mockIterator,
          }) as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'do something');
      const pullPromise = gen.next();

      // Flush microtasks so validateBoundary() resolves and query() is called
      await vi.advanceTimersByTimeAsync(0);

      // Trigger canUseTool for a regular tool (not AskUserQuestion)
      const permissionPromise = canUseToolFn!(
        'Write',
        { file_path: '/tmp/test.txt', content: 'hello' },
        { signal: new AbortController().signal, toolUseID: 'tool-w1' }
      );

      const firstEvent = await pullPromise;
      expect(firstEvent.done).toBe(false);
      expect(firstEvent.value.type).toBe('approval_required');
      expect((firstEvent.value.data as { toolName: string }).toolName).toBe('Write');

      // CLI-C1 wiring: the projector tracks the pending approval (as the
      // trigger path's feedProjector would have ingested it) so we can assert
      // approveTool notifies it — emitting a seq'd `interaction_resolved` that
      // live /events subscribers (other windows included) fold immediately.
      const { getOrCreateProjector, disposeProjector } =
        await import('../../../session/session-state-projector.js');
      const projector = getOrCreateProjector('sess-1');
      projector.ingest({
        type: 'approval_required',
        id: 'tool-w1',
        startedAt: Date.now(),
        remainingMs: 600_000,
        toolName: 'Write',
        input: '{}',
        hasSuggestions: false,
      } as never);
      expect(projector.getPendingInteractions()).toHaveLength(1);

      // Approve the tool
      const approved = manager.approveTool('sess-1', 'tool-w1', true);
      expect(approved).toBe(true);

      const permissionResult = await permissionPromise;
      expect(permissionResult).toEqual({
        behavior: 'allow',
        updatedInput: { file_path: '/tmp/test.txt', content: 'hello' },
      });

      // The projector was notified: pending cleared + a replayable
      // interaction_resolved event on the stream.
      expect(projector.getPendingInteractions()).toEqual([]);
      const resolved = projector.replayFrom(1);
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        type: 'interaction_resolved',
        id: 'tool-w1',
        resolution: 'approved',
      });
      disposeProjector('sess-1');
    });

    it('denying a tool approval resolves with deny', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'default' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return withQueryMethods({
            [Symbol.asyncIterator]: () => mockIterator,
          }) as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'do something');
      const pullPromise = gen.next();

      // Flush microtasks so validateBoundary() resolves and query() is called
      await vi.advanceTimersByTimeAsync(0);

      const permissionPromise = canUseToolFn!(
        'Bash',
        { command: 'rm -rf /' },
        { signal: new AbortController().signal, toolUseID: 'tool-b1' }
      );

      await pullPromise; // drain approval_required event

      // Deny the tool
      const denied = manager.approveTool('sess-1', 'tool-b1', false);
      expect(denied).toBe(true);

      const permissionResult = await permissionPromise;
      expect(permissionResult).toEqual({
        behavior: 'deny',
        message: 'User denied tool execution',
      });
    });

    /**
     * Drive the REAL approval path end to end and hand back what the durable
     * stream recorded: register a genuine pending approval through the SDK's
     * own `canUseTool` seam, answer it through `ClaudeCodeRuntime.approveTool`,
     * and read the `interaction_resolved` the projector emitted.
     */
    async function answerRealApproval(
      toolCallId: string,
      approved: boolean,
      options?: { alwaysAllow?: boolean; denyReason?: string; answeredBy?: string }
    ) {
      // A session (and projector) of its own per case: the projector registry
      // is module-global, so a shared id would let one case read the previous
      // case's resolution back out of `replayFrom`.
      const sessionId = `sess-${toolCallId}`;
      manager.ensureSession(sessionId, { permissionMode: 'default' });
      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;
      const captureCanUseTool = (args: {
        options: { canUseTool?: typeof canUseToolFn };
      }): ReturnType<typeof query> => {
        canUseToolFn = args.options.canUseTool!;
        const mockIterator = {
          next: vi
            .fn()
            .mockResolvedValueOnce({
              done: false,
              value: { type: 'system', subtype: 'init', session_id: sessionId },
            })
            .mockImplementationOnce(() => new Promise(() => {})),
        };
        return withQueryMethods({
          [Symbol.asyncIterator]: () => mockIterator,
        }) as unknown as ReturnType<typeof query>;
      };
      mockedQuery.mockImplementation(captureCanUseTool as unknown as typeof query);
      const gen = manager.sendMessage(sessionId, 'do something');
      const pullPromise = gen.next();
      await vi.advanceTimersByTimeAsync(0);
      const permission = canUseToolFn!(
        'Bash',
        { command: 'rm -rf node_modules' },
        { signal: new AbortController().signal, toolUseID: toolCallId }
      );
      await pullPromise;

      const { getOrCreateProjector, disposeProjector } =
        await import('../../../session/session-state-projector.js');
      const projector = getOrCreateProjector(sessionId);
      projector.ingest({
        type: 'approval_required',
        id: toolCallId,
        startedAt: Date.now(),
        remainingMs: 600_000,
        timeoutMs: 600_000,
        toolName: 'Bash',
        input: '{}',
        hasSuggestions: false,
      } as never);

      expect(manager.approveTool(sessionId, toolCallId, approved, options)).toBe(true);

      const resolved = projector.replayFrom(0).find((e) => e.type === 'interaction_resolved') as
        { resolution?: string; reasonGiven?: boolean; resolvedBy?: string } | undefined;
      disposeProjector(sessionId);
      return { resolved, permission: (await permission) as { behavior: string; message?: string } };
    }

    // DOR-809. `reasonGiven` is the ONLY thing the transcript's "agent was told
    // why" renders from, and the line that sets it lives one call away from the
    // one that hands the model the reason. Pinned against the real runtime
    // rather than a fake, because a test that computes the flag inside its own
    // `approveTool` stub pins the projector and never the authorizing line:
    // deleting the argument entirely, or hardcoding it to `true`, both left
    // 8,585 tests green before this existed.
    it('declares a reason was given, and hands the model that reason', async () => {
      const { resolved, permission } = await answerRealApproval('tool-r1', false, {
        denyReason: 'Use pnpm prune instead',
      });
      expect(resolved).toMatchObject({ resolution: 'denied', reasonGiven: true });
      expect(permission.message).toContain('Use pnpm prune instead');
    });

    // DOR-1355. The name of whoever answered rides the same argument for the
    // same reason `reasonGiven` does: only the caller that took the answer knows
    // it, and every other window's receipt says "Already answered by Ada at
    // 2:01" on the strength of this and nothing else. Against the real runtime,
    // so a pass-through that was dropped shows up here rather than in a stub.
    it('records the name the caller gave for whoever answered', async () => {
      const { resolved } = await answerRealApproval('tool-r6', true, { answeredBy: 'Ada' });
      expect(resolved).toMatchObject({ resolution: 'approved', resolvedBy: 'Ada' });
    });
  });

  // ---- Timeout behavior ----

  describe('interaction timeout', () => {
    it('question interaction is refused four hours on, having parked at ten minutes', async () => {
      manager.ensureSession('sess-1', { permissionMode: 'bypassPermissions' });

      let canUseToolFn: (
        toolName: string,
        input: Record<string, unknown>,
        context: { signal: AbortSignal; toolUseID: string }
      ) => Promise<unknown>;

      (mockedQuery as any).mockImplementation(
        (args: { options: { canUseTool?: typeof canUseToolFn } }) => {
          canUseToolFn = args.options.canUseTool!;

          const mockIterator = {
            next: vi
              .fn()
              .mockResolvedValueOnce({
                done: false,
                value: { type: 'system', subtype: 'init', session_id: 'sess-1' },
              })
              .mockImplementationOnce(() => new Promise(() => {})),
          };
          return withQueryMethods({
            [Symbol.asyncIterator]: () => mockIterator,
          }) as unknown as ReturnType<typeof query>;
        }
      );

      const gen = manager.sendMessage('sess-1', 'ask');
      gen.next(); // kick off

      await vi.advanceTimersByTimeAsync(0);

      const permissionPromise = canUseToolFn!(
        'AskUserQuestion',
        { questions: [] },
        { signal: new AbortController().signal, toolUseID: 'tool-q-timeout' }
      );

      // Past the countdown the prompt PARKS: nothing is answered on the
      // person's behalf, and the tool call stays held (spec
      // `ask-parks-on-timeout`).
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 1);
      expect(manager.submitAnswers('sess-1', 'tool-q-timeout', {})).toBe(true);

      // A second prompt, this time left to run all the way out.
      const parked = canUseToolFn!(
        'AskUserQuestion',
        { questions: [] },
        { signal: new AbortController().signal, toolUseID: 'tool-q-ceiling' }
      );
      await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1000 + 1);

      await permissionPromise;
      const result = await parked;
      expect(result).toEqual({
        behavior: 'deny',
        message: 'User did not respond within 4 hours',
      });

      // submitAnswers should return false since interaction was cleaned up
      expect(manager.submitAnswers('sess-1', 'tool-q-ceiling', {})).toBe(false);
    });
  });
});

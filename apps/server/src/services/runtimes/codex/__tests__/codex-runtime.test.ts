import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import type { DependencyCheck, SessionSettingsPort } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ThreadEvent } from '@openai/codex-sdk';
import { CodexRuntime, buildCodexOptions } from '../codex-runtime.js';
import { CODEX_UI_MCP_SERVER } from '../codex-ui-mcp-server.js';
import { CodexThreadMap } from '../thread-map.js';
import { checkCodexDependencies } from '../check-dependencies.js';
import { enumerateCodexMcpServers } from '../enumerate-mcp-servers.js';
import { scanSkillCommands } from '../scan-skill-commands.js';
import { getOrCreateProjector } from '../../../session/session-state-projector.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import {
  THREAD_ID,
  codexSimpleTurn,
  codexThreadStarted,
  codexTurnStarted,
  codexItemUpdated,
  agentMessageItem,
  makeMockThread,
} from './codex-scenarios.js';

vi.mock('../check-dependencies.js', () => ({
  checkCodexDependencies: vi.fn(),
}));

// MCP enumeration and skill-command scanning are tested in isolation
// (enumerate-mcp-servers.test.ts / scan-skill-commands.test.ts); here we mock
// them to assert how the runtime delegates and caches.
vi.mock('../enumerate-mcp-servers.js', () => ({
  enumerateCodexMcpServers: vi.fn(),
}));
vi.mock('../scan-skill-commands.js', () => ({
  scanSkillCommands: vi.fn(() => []),
}));

/**
 * Module-level SDK mock. The Codex constructor records its options (the
 * env-gotcha / codexPathOverride assertions) and hands out the shared
 * startThread/resumeThread spies, which each test scripts per scenario.
 */
const sdkMocks = vi.hoisted(() => ({
  constructorOptions: [] as unknown[],
  startThread: vi.fn(),
  resumeThread: vi.fn(),
}));

vi.mock('@openai/codex-sdk', () => ({
  Codex: class {
    startThread = sdkMocks.startThread;
    resumeThread = sdkMocks.resumeThread;
    constructor(options?: unknown) {
      sdkMocks.constructorOptions.push(options);
    }
  },
}));

const SATISFIED_CHECKS: DependencyCheck[] = [
  {
    name: 'Codex CLI',
    description: 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.',
    status: 'satisfied',
    version: 'codex-cli 0.142.5',
  },
];

/**
 * Fresh runtime + thread map over an isolated in-memory DB. Pass `db` to share
 * one DB across two runtime instances — the simulated-restart setup.
 */
function makeRuntime(opts: { binaryPath?: string | null; db?: Db } = {}) {
  const db = opts.db ?? createTestDb();
  const threadMap = new CodexThreadMap(db);
  const runtime = new CodexRuntime({ threadMap, binaryPath: opts.binaryPath ?? null });
  return { runtime, threadMap, db };
}

/** Drain a sendMessage generator into an array. */
async function drain(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

/**
 * A ThreadEvent stream that yields a partial answer and then parks until the
 * captured TurnOptions.signal aborts, at which point it throws the AbortError
 * the real SDK surfaces (per-turn subprocess kill, NOTES.md Verdict 3).
 */
async function* abortableStream(getSignal: () => AbortSignal): AsyncGenerator<ThreadEvent> {
  yield codexThreadStarted();
  yield codexTurnStarted();
  yield codexItemUpdated(agentMessageItem('msg-1', 'partial answer'));
  await new Promise<never>((_, reject) => {
    const signal = getSignal();
    const abort = (): void => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

describe('CodexRuntime', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMocks.constructorOptions.length = 0;
    // Default scenario: a fresh single-turn thread per call (multi-turn safe).
    sdkMocks.startThread.mockImplementation(() => makeMockThread(codexSimpleTurn('Hello there')));
    sdkMocks.resumeThread.mockImplementation(() => makeMockThread(codexSimpleTurn('Resumed')));
    // ensureSession now pre-warms the MCP cache (fire-and-forget). Default the
    // probe to a clean "unavailable" so tests that don't care about MCP never
    // spawn `codex mcp list` and the warm is a cache no-op; MCP-specific tests
    // override this with their own resolved value.
    vi.mocked(enumerateCodexMcpServers).mockResolvedValue(null);
  });

  describe('identity and dependencies', () => {
    it('identifies as the codex runtime', () => {
      const { runtime } = makeRuntime();
      expect(runtime.type).toBe('codex');
    });

    it('delegates checkDependencies to checkCodexDependencies', async () => {
      vi.mocked(checkCodexDependencies).mockReturnValue(SATISFIED_CHECKS);
      const { runtime } = makeRuntime();

      const checks = await runtime.checkDependencies();

      expect(checkCodexDependencies).toHaveBeenCalledOnce();
      expect(checks).toEqual(SATISFIED_CHECKS);
    });

    it('never sets CodexOptions.env and only passes codexPathOverride when configured', () => {
      makeRuntime();
      makeRuntime({ binaryPath: '/opt/custom/codex' });

      const [defaults, overridden] = sdkMocks.constructorOptions as Record<string, unknown>[];
      expect(defaults).not.toHaveProperty('env');
      expect(defaults).not.toHaveProperty('codexPathOverride');
      expect(overridden).not.toHaveProperty('env');
      expect(overridden).toMatchObject({ codexPathOverride: '/opt/custom/codex' });
    });
  });

  describe('buildCodexOptions', () => {
    it('includes codexPathOverride and the dorkos_ui MCP server when both args are given', () => {
      const options = buildCodexOptions('/opt/custom/codex', 'http://127.0.0.1:4242/codex-ui-mcp');
      expect(options).toEqual({
        codexPathOverride: '/opt/custom/codex',
        config: {
          mcp_servers: {
            [CODEX_UI_MCP_SERVER]: { url: 'http://127.0.0.1:4242/codex-ui-mcp' },
          },
        },
      });
    });

    it('omits config when no mcpUiUrl is provided', () => {
      const options = buildCodexOptions('/opt/custom/codex');
      expect(options).toEqual({ codexPathOverride: '/opt/custom/codex' });
      expect(options).not.toHaveProperty('config');
    });

    it('omits codexPathOverride when binaryPath is falsy', () => {
      expect(buildCodexOptions(null)).toEqual({});
      expect(buildCodexOptions(undefined, 'http://127.0.0.1:4242/codex-ui-mcp')).toEqual({
        config: {
          mcp_servers: { [CODEX_UI_MCP_SERVER]: { url: 'http://127.0.0.1:4242/codex-ui-mcp' } },
        },
      });
    });

    it('never sets env', () => {
      expect(
        buildCodexOptions('/bin/codex', 'http://127.0.0.1:4242/codex-ui-mcp')
      ).not.toHaveProperty('env');
    });
  });

  describe('capabilities', () => {
    it('returns the finalized capability shape from the 2.2 verification', () => {
      const { runtime } = makeRuntime();
      const caps = runtime.getCapabilities();

      expect(caps).toMatchObject({
        type: 'codex',
        supportsToolApproval: false,
        supportsCostTracking: false,
        supportsResume: true,
        supportsMcp: false,
        supportsQuestionPrompt: false,
        supportsPlugins: false,
        nativeContext: [],
      });
      expect(caps.permissionModes.supported).toBe(true);
      expect(caps.permissionModes.default).toBe('default');
      expect(caps.permissionModes.values.map((v) => v.id)).toEqual([
        'default',
        'acceptEdits',
        'bypassPermissions',
      ]);
    });

    it('exposes the pinned CLI model catalog with gpt-5.5 as default', async () => {
      const { runtime } = makeRuntime();
      const models = await runtime.getSupportedModels();

      const defaults = models.filter((m) => m.isDefault);
      expect(defaults).toHaveLength(1);
      expect(defaults[0]!.value).toBe('gpt-5.5');
      expect(models.map((m) => m.value)).toContain('gpt-5.3-codex');
      for (const model of models) expect(model.provider).toBe('openai');
    });
  });

  describe('session lifecycle', () => {
    it('tracks sessions via ensureSession and reports metadata through getSession', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      expect(runtime.hasSession(sessionId)).toBe(false);
      runtime.ensureSession(sessionId, { permissionMode: 'acceptEdits', cwd: '/projects/demo' });
      expect(runtime.hasSession(sessionId)).toBe(true);

      const session = await runtime.getSession('/projects/demo', sessionId);
      expect(session).toMatchObject({
        id: sessionId,
        runtime: 'codex',
        permissionMode: 'acceptEdits',
        cwd: '/projects/demo',
      });
      await expect(runtime.getSession('/projects/demo', crypto.randomUUID())).resolves.toBeNull();
    });

    it('lists tracked sessions scoped to the project directory', async () => {
      const { runtime } = makeRuntime();
      const inProject = crypto.randomUUID();
      const elsewhere = crypto.randomUUID();
      runtime.ensureSession(inProject, { permissionMode: 'default', cwd: '/projects/demo' });
      runtime.ensureSession(elsewhere, { permissionMode: 'default', cwd: '/projects/other' });

      const sessions = await runtime.listSessions('/projects/demo');
      expect(sessions.map((s) => s.id)).toEqual([inProject]);
      expect(sessions[0]!.runtime).toBe('codex');
    });

    it('renameSession sets the tracked title', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default' });

      await runtime.renameSession(sessionId, 'Investigate flaky test', '/projects/demo');

      const session = await runtime.getSession('/projects/demo', sessionId);
      expect(session?.title).toBe('Investigate flaky test');
    });

    it('updateSession auto-creates untracked sessions and writes through the settings port', async () => {
      const { runtime } = makeRuntime();
      const port: SessionSettingsPort = {
        getSessionSettings: vi.fn().mockResolvedValue(null),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      runtime.setSessionSettings(port);
      const sessionId = crypto.randomUUID();

      const updated = await runtime.updateSession(sessionId, { permissionMode: 'acceptEdits' });

      expect(updated).toBe(true);
      expect(runtime.hasSession(sessionId)).toBe(true);
      expect(port.saveSessionSettings).toHaveBeenCalledWith(sessionId, {
        permissionMode: 'acceptEdits',
      });
      const session = await runtime.getSession('/projects/demo', sessionId);
      expect(session?.permissionMode).toBe('acceptEdits');
    });

    it('forkSession is unsupported and resolves null', async () => {
      const { runtime } = makeRuntime();
      await expect(runtime.forkSession('/p', crypto.randomUUID())).resolves.toBeNull();
    });

    it('getInternalSessionId returns undefined — the DorkOS id is canonical (no rekey)', () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, THREAD_ID);

      // Returning the Codex thread id here would trip trigger-turn's C1 rekey
      // and re-key the projector (and the 202 canonical id) to the thread id.
      expect(runtime.getInternalSessionId(sessionId)).toBeUndefined();
    });
  });

  describe('durable metadata (restart survival)', () => {
    it('hydrateSessions restores the session list with title and preview after a simulated restart', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' }));

      // Simulated restart: a fresh runtime instance over the same DB.
      const { runtime: restarted } = makeRuntime({ db });
      await expect(restarted.listSessions('/projects/demo')).resolves.toEqual([]);
      await restarted.hydrateSessions();

      const sessions = await restarted.listSessions('/projects/demo');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        id: sessionId,
        runtime: 'codex',
        title: 'Fix the flaky test',
        lastMessagePreview: 'Fix the flaky test',
        cwd: '/projects/demo',
      });
      expect(restarted.hasSession(sessionId)).toBe(true);
    });

    it('rename persists across a simulated restart', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      await runtime.renameSession(sessionId, 'Investigate flaky test', '/projects/demo');

      const { runtime: restarted } = makeRuntime({ db });
      await restarted.hydrateSessions();
      const session = await restarted.getSession('/projects/demo', sessionId);
      expect(session?.title).toBe('Investigate flaky test');
    });

    it('recordMessage writes preview/updatedAt through once the binding exists', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'first question', { cwd: '/projects/demo' }));
      const afterFirst = threadMap.get(sessionId)!;
      expect(afterFirst).toMatchObject({
        title: 'first question',
        lastMessagePreview: 'first question',
      });

      await drain(runtime.sendMessage(sessionId, 'second question', { cwd: '/projects/demo' }));
      const afterSecond = threadMap.get(sessionId)!;
      // Title is first-turn-derived and sticky; the preview tracks the latest turn.
      expect(afterSecond.title).toBe('first question');
      expect(afterSecond.lastMessagePreview).toBe('second question');
      expect(afterSecond.updatedAt! >= afterFirst.updatedAt!).toBe(true);
    });

    it('hydration joins persisted settings from the settings port', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      const { runtime: restarted } = makeRuntime({ db });
      const port: SessionSettingsPort = {
        getSessionSettings: vi.fn().mockResolvedValue({
          permissionMode: 'acceptEdits',
          model: 'gpt-5.4-mini',
          effort: 'high',
          fastMode: true,
        }),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      restarted.setSessionSettings(port);
      await restarted.hydrateSessions();

      expect(port.getSessionSettings).toHaveBeenCalledWith(sessionId);
      const session = await restarted.getSession('/projects/demo', sessionId);
      expect(session).toMatchObject({
        permissionMode: 'acceptEdits',
        model: 'gpt-5.4-mini',
        effort: 'high',
        fastMode: true,
      });
    });

    it('hydrateSessions is idempotent and never clobbers fresher in-memory state', async () => {
      const { runtime, db } = makeRuntime();
      const sessionId = crypto.randomUUID();
      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      const { runtime: restarted } = makeRuntime({ db });
      await restarted.hydrateSessions();
      await restarted.renameSession(sessionId, 'renamed after hydrate', '/projects/demo');
      await restarted.hydrateSessions();

      const sessions = await restarted.listSessions('/projects/demo');
      expect(sessions).toHaveLength(1);
      expect(sessions[0]?.title).toBe('renamed after hydrate');
    });

    describe('pre-hydration touches (boot-time race)', () => {
      it('renameSession before hydration seeds the durable row, keeps the rename, and survives later hydration', async () => {
        const { runtime, db, threadMap } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );
        const durable = threadMap.getRecord(sessionId)!;

        // Simulated restart: the rename lands BEFORE hydrateSessions runs.
        const { runtime: restarted } = makeRuntime({ db });
        await restarted.renameSession(sessionId, 'Renamed before hydration', '/projects/demo');

        // The entry was seeded from the durable row (createdAt/cwd preserved),
        // with the genuinely fresher rename on top.
        const seeded = await restarted.getSession('/projects/demo', sessionId);
        expect(seeded).toMatchObject({
          title: 'Renamed before hydration',
          createdAt: durable.createdAt,
          cwd: '/projects/demo',
        });

        // Later startup hydration does not clobber the touched id.
        await restarted.hydrateSessions();
        const sessions = await restarted.listSessions('/projects/demo');
        expect(sessions).toHaveLength(1);
        expect(sessions[0]).toMatchObject({
          title: 'Renamed before hydration',
          createdAt: durable.createdAt,
        });

        // The rename write-through persisted: a third instance hydrates it back.
        const { runtime: third } = makeRuntime({ db });
        await third.hydrateSessions();
        const rehydrated = await third.getSession('/projects/demo', sessionId);
        expect(rehydrated?.title).toBe('Renamed before hydration');
      });

      it('sendMessage before hydration keeps the durable saved title while refreshing preview/updatedAt', async () => {
        const { runtime, db, threadMap } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(runtime.sendMessage(sessionId, 'first question', { cwd: '/projects/demo' }));
        await runtime.renameSession(sessionId, 'Saved title', '/projects/demo');
        const durable = threadMap.getRecord(sessionId)!;

        // Simulated restart: a message lands BEFORE hydrateSessions runs.
        const { runtime: restarted } = makeRuntime({ db });
        await drain(
          restarted.sendMessage(sessionId, 'follow-up question', { cwd: '/projects/demo' })
        );

        // The auto-derived preview must NOT overwrite the persisted title.
        const session = await restarted.getSession('/projects/demo', sessionId);
        expect(session).toMatchObject({
          title: 'Saved title',
          lastMessagePreview: 'follow-up question',
          createdAt: durable.createdAt,
          cwd: '/projects/demo',
        });
        expect(session!.updatedAt >= durable.updatedAt!).toBe(true);

        // The refreshed preview wrote through; the durable title stayed intact.
        const after = threadMap.getRecord(sessionId)!;
        expect(after.title).toBe('Saved title');
        expect(after.lastMessagePreview).toBe('follow-up question');

        // Later hydration does not resurrect the stale preview.
        await restarted.hydrateSessions();
        const rehydrated = await restarted.getSession('/projects/demo', sessionId);
        expect(rehydrated?.title).toBe('Saved title');
        expect(rehydrated?.lastMessagePreview).toBe('follow-up question');
      });

      it('updateSession before hydration seeds the durable row and applies the patch on top', async () => {
        const { runtime, db } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );

        // Simulated restart: the settings PATCH lands BEFORE hydrateSessions.
        const { runtime: restarted } = makeRuntime({ db });
        const port: SessionSettingsPort = {
          getSessionSettings: vi.fn().mockResolvedValue(null),
          saveSessionSettings: vi.fn().mockResolvedValue(undefined),
        };
        restarted.setSessionSettings(port);
        await restarted.updateSession(sessionId, { permissionMode: 'acceptEdits' });

        const session = await restarted.getSession('/projects/demo', sessionId);
        expect(session).toMatchObject({
          title: 'Fix the flaky test',
          permissionMode: 'acceptEdits',
          cwd: '/projects/demo',
        });

        await restarted.hydrateSessions();
        const rehydrated = await restarted.getSession('/projects/demo', sessionId);
        expect(rehydrated).toMatchObject({
          title: 'Fix the flaky test',
          permissionMode: 'acceptEdits',
        });
      });

      it('ensureSession before hydration seeds display metadata with the caller opts folded on top', async () => {
        const { runtime, db } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );

        // Simulated restart: ensureSession lands BEFORE hydrateSessions.
        const { runtime: restarted } = makeRuntime({ db });
        restarted.ensureSession(sessionId, {
          permissionMode: 'acceptEdits',
          cwd: '/projects/demo',
        });

        const session = await restarted.getSession('/projects/demo', sessionId);
        expect(session).toMatchObject({
          id: sessionId,
          title: 'Fix the flaky test',
          lastMessagePreview: 'Fix the flaky test',
          permissionMode: 'acceptEdits',
          cwd: '/projects/demo',
        });

        await restarted.hydrateSessions();
        const rehydrated = await restarted.getSession('/projects/demo', sessionId);
        expect(rehydrated?.title).toBe('Fix the flaky test');
        expect(rehydrated?.permissionMode).toBe('acceptEdits');
      });

      it('hydrateSessions after a pre-hydration touch emits no stale session_upserted for the touched id', async () => {
        const { runtime, db } = makeRuntime();
        const sessionId = crypto.randomUUID();
        await drain(
          runtime.sendMessage(sessionId, 'Fix the flaky test', { cwd: '/projects/demo' })
        );

        const { runtime: restarted } = makeRuntime({ db });
        await restarted.renameSession(sessionId, 'Renamed before hydration', '/projects/demo');

        const iterator = restarted
          .subscribeSessionList({ permissionMode: 'default' })
          [Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value).toMatchObject({
          type: 'session_upserted',
          session: { id: sessionId, title: 'Renamed before hydration' },
        });

        await restarted.hydrateSessions();
        // Registry emissions are synchronous: had hydrate re-upserted the
        // tracked id, the stale event would already be queued and win this
        // race over the macrotask timer.
        const outcome = await Promise.race([
          iterator.next().then((result) => ({ kind: 'event' as const, result })),
          new Promise<{ kind: 'idle' }>((resolve) => setImmediate(() => resolve({ kind: 'idle' }))),
        ]);
        expect(outcome).toEqual({ kind: 'idle' });
        await iterator.return?.(undefined);
      });
    });
  });

  describe('sendMessage — start path', () => {
    it('starts a new thread with explicit read-only sandbox and never-approval options', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });

      const events = await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(sdkMocks.startThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.startThread).toHaveBeenCalledWith({
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        workingDirectory: '/projects/demo',
      });
      expect(sdkMocks.resumeThread).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(events.at(-1)!.type).toBe('done');
      const text = events
        .filter((e) => e.type === 'text_delta')
        .map((e) => (e.data as { text: string }).text)
        .join('');
      expect(text).toBe('Hello there');
    });

    it('persists the thread binding from thread.started (first-write-wins map)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(threadMap.getThreadId(sessionId)).toBe(THREAD_ID);
    });

    it('persists the turn cwd and bind-time metadata alongside the binding so both survive a restart', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      const binding = threadMap.get(sessionId)!;
      expect(binding).toMatchObject({
        threadId: THREAD_ID,
        cwd: '/projects/demo',
        // The first turn's registry metadata rides along with the bind.
        title: 'hi',
        lastMessagePreview: 'hi',
      });
      expect(new Date(binding.updatedAt!).toISOString()).toBe(binding.updatedAt);
    });

    it('projects acceptEdits -> workspace-write and bypassPermissions -> danger-full-access', async () => {
      const { runtime } = makeRuntime();
      const editsSession = crypto.randomUUID();
      runtime.ensureSession(editsSession, { permissionMode: 'acceptEdits' });
      await drain(runtime.sendMessage(editsSession, 'hi'));
      expect(sdkMocks.startThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxMode: 'workspace-write', approvalPolicy: 'never' })
      );

      const bypassSession = crypto.randomUUID();
      runtime.ensureSession(bypassSession, { permissionMode: 'bypassPermissions' });
      await drain(runtime.sendMessage(bypassSession, 'hi'));
      expect(sdkMocks.startThread).toHaveBeenLastCalledWith(
        expect.objectContaining({ sandboxMode: 'danger-full-access', approvalPolicy: 'never' })
      );
    });

    it('projects session model and effort into ThreadOptions', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, {
        permissionMode: 'default',
        model: 'gpt-5.4',
        effort: 'max',
      });

      await drain(runtime.sendMessage(sessionId, 'hi'));

      expect(sdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'gpt-5.4', modelReasoningEffort: 'xhigh' })
      );
    });

    it('hydrates persisted settings for an untracked session (restart resume path)', async () => {
      const { runtime } = makeRuntime();
      const port: SessionSettingsPort = {
        getSessionSettings: vi
          .fn()
          .mockResolvedValue({ permissionMode: 'acceptEdits', model: 'gpt-5.4-mini' }),
        saveSessionSettings: vi.fn().mockResolvedValue(undefined),
      };
      runtime.setSessionSettings(port);
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'hi', { cwd: '/projects/demo' }));

      expect(port.getSessionSettings).toHaveBeenCalledWith(sessionId);
      expect(sdkMocks.startThread).toHaveBeenCalledWith(
        expect.objectContaining({ sandboxMode: 'workspace-write', model: 'gpt-5.4-mini' })
      );
    });

    it('prepends systemPromptAppend and additional context, keeping content last and unmutated', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const thread = makeMockThread(codexSimpleTurn('ok'));
      sdkMocks.startThread.mockReturnValue(thread);

      await drain(
        runtime.sendMessage(sessionId, 'What changed?', {
          cwd: '/projects/demo',
          systemPromptAppend: 'Scheduled task context',
          additionalContext: [
            { kind: 'git_status', scope: 'per-turn', data: { isRepo: true, branch: 'main' } },
          ],
        })
      );

      const [input] = thread.runStreamed.mock.calls[0]!;
      expect(input).toContain('Scheduled task context');
      expect(input).toContain('<git_status>');
      expect(input).toContain('</git_status>');
      expect(String(input).endsWith('What changed?')).toBe(true);
    });

    it('sends the bare content when no context is supplied', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const thread = makeMockThread(codexSimpleTurn('ok'));
      sdkMocks.startThread.mockReturnValue(thread);

      await drain(runtime.sendMessage(sessionId, 'plain message'));

      expect(thread.runStreamed.mock.calls[0]![0]).toBe('plain message');
    });
  });

  describe('sendMessage — resume path', () => {
    it('resumes the mapped thread with explicit options instead of starting a new one', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, 'thread-existing');
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });

      await drain(runtime.sendMessage(sessionId, 'continue', { cwd: '/projects/demo' }));

      expect(sdkMocks.resumeThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.resumeThread).toHaveBeenCalledWith('thread-existing', {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        workingDirectory: '/projects/demo',
      });
      expect(sdkMocks.startThread).not.toHaveBeenCalled();
      // The pre-existing binding stays intact (first-write-wins).
      expect(threadMap.getThreadId(sessionId)).toBe('thread-existing');
    });

    it('starts then resumes across two turns of one session', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await drain(runtime.sendMessage(sessionId, 'one'));
      await drain(runtime.sendMessage(sessionId, 'two'));

      expect(sdkMocks.startThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.resumeThread).toHaveBeenCalledTimes(1);
      expect(sdkMocks.resumeThread).toHaveBeenCalledWith(THREAD_ID, expect.any(Object));
    });

    it('resolves the persisted binding cwd when the in-memory registry is gone (post-restart)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      // A pre-restart binding persisted with its cwd; the in-memory registry is
      // empty (as on a fresh process), and the trigger carries no opts.cwd.
      threadMap.setThreadId(sessionId, 'thread-persisted', '/projects/persisted');

      await drain(runtime.sendMessage(sessionId, 'resume in the right dir'));

      expect(sdkMocks.resumeThread).toHaveBeenCalledWith('thread-persisted', {
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        skipGitRepoCheck: true,
        workingDirectory: '/projects/persisted',
      });
    });

    it('resumes a legacy binding without a persisted cwd, omitting workingDirectory (no crash)', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      threadMap.setThreadId(sessionId, 'thread-legacy'); // pre-cwd (legacy) binding

      await drain(runtime.sendMessage(sessionId, 'resume'));

      expect(sdkMocks.resumeThread).toHaveBeenCalledWith(
        'thread-legacy',
        expect.not.objectContaining({ workingDirectory: expect.anything() })
      );
    });
  });

  describe('interrupt semantics', () => {
    it('interruptQuery aborts the in-flight turn; the stream ends with a quiet done', async () => {
      const { runtime, threadMap } = makeRuntime();
      const sessionId = crypto.randomUUID();
      let capturedSignal: AbortSignal | undefined;
      sdkMocks.startThread.mockReturnValue({
        id: null,
        runStreamed: vi.fn((_input: unknown, turnOptions?: { signal?: AbortSignal }) => {
          capturedSignal = turnOptions?.signal;
          return Promise.resolve({ events: abortableStream(() => capturedSignal!) });
        }),
        run: vi.fn(),
      });

      const gen = runtime.sendMessage(sessionId, 'long task');
      const first = await gen.next();
      expect(first.value).toEqual({ type: 'text_delta', data: { text: 'partial answer' } });

      await expect(runtime.interruptQuery(sessionId)).resolves.toBe(true);
      expect(capturedSignal?.aborted).toBe(true);

      const rest: StreamEvent[] = [];
      for await (const event of gen) rest.push(event);
      // Abort is user-initiated: exactly one quiet done, no error event.
      expect(rest).toEqual([{ type: 'done', data: { sessionId } }]);

      // The thread binding still landed (thread.started arrived before the abort).
      expect(threadMap.getThreadId(sessionId)).toBe(THREAD_ID);
      // The turn is settled — a second interrupt has nothing to abort.
      await expect(runtime.interruptQuery(sessionId)).resolves.toBe(false);
    });

    it('resolves false when no turn is in flight', async () => {
      const { runtime } = makeRuntime();
      await expect(runtime.interruptQuery(crypto.randomUUID())).resolves.toBe(false);
    });
  });

  describe('history and live state (projector-backed)', () => {
    it('reconstructs message history from the DorkOS EventLog after a fed turn', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const projector = getOrCreateProjector(sessionId, '/projects/demo');

      await feedProjector(projector, runtime.sendMessage(sessionId, 'hello'), {
        userMessage: 'hello',
      });

      const history = await runtime.getMessageHistory('/projects/demo', sessionId);
      expect(history.length).toBeGreaterThan(0);
      expect(history.some((m) => m.role === 'user' && m.content === 'hello')).toBe(true);
      expect(history.some((m) => m.role === 'assistant')).toBe(true);
    });

    it('returns empty history for a session that never streamed', async () => {
      const { runtime } = makeRuntime();
      await expect(
        runtime.getMessageHistory('/projects/demo', crypto.randomUUID())
      ).resolves.toEqual([]);
    });

    it('getSessionSnapshot serves the projector snapshot (cold session: empty, cursor 0)', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      const snapshot = await runtime.getSessionSnapshot(
        { permissionMode: 'default', cwd: '/projects/demo' },
        sessionId
      );

      expect(snapshot.messages).toEqual([]);
      expect(snapshot.inProgressTurn).toBeNull();
      expect(snapshot.cursor).toBe(0);
    });

    it('subscribeSessionList yields the tracked inventory as session_upserted events', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default', cwd: '/projects/demo' });

      const iterator = runtime
        .subscribeSessionList({ permissionMode: 'default' })
        [Symbol.asyncIterator]();
      const first = await iterator.next();
      await iterator.return?.(undefined);

      expect(first.done).toBe(false);
      expect(first.value).toMatchObject({
        type: 'session_upserted',
        session: { id: sessionId, runtime: 'codex' },
      });
    });
  });

  describe('approval-free interactive surface (NOTES.md Verdict 1)', () => {
    it('approveTool, submitAnswers, submitElicitation, and stopTask all report unsupported', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      runtime.ensureSession(sessionId, { permissionMode: 'default' });

      expect(runtime.approveTool(sessionId, 'tool-1', true)).toBe(false);
      expect(runtime.submitAnswers(sessionId, 'tool-1', { '0': 'yes' })).toBe(false);
      expect(runtime.submitElicitation(sessionId, 'int-1', 'accept')).toBe(false);
      await expect(runtime.stopTask(sessionId, 'task-1')).resolves.toBe(false);
    });
  });

  describe('session locking', () => {
    it('grants the lock to one client and refuses a second until released', () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();
      const res = { on: vi.fn() };

      expect(runtime.acquireLock(sessionId, 'client-a', res)).toBe(true);
      expect(runtime.acquireLock(sessionId, 'client-b', res)).toBe(false);
      expect(runtime.isLocked(sessionId, 'client-b')).toBe(true);
      expect(runtime.getLockInfo(sessionId)?.clientId).toBe('client-a');

      runtime.releaseLock(sessionId, 'client-a');
      expect(runtime.acquireLock(sessionId, 'client-b', res)).toBe(true);
    });
  });

  describe('storage stubs', () => {
    it('returns honest empties for surfaces Codex has no native store for', async () => {
      const { runtime } = makeRuntime();
      const sessionId = crypto.randomUUID();

      await expect(runtime.getSessionTasks('/p', sessionId)).resolves.toEqual([]);
      await expect(runtime.getSessionETag('/p', sessionId)).resolves.toBeNull();
      await expect(runtime.getLastMessageIds(sessionId)).resolves.toBeNull();
      await expect(runtime.readFromOffset('/p', sessionId, 0)).resolves.toEqual({
        content: '',
        newOffset: 0,
      });
      await expect(runtime.getSupportedSubagents()).resolves.toEqual([]);
    });
  });

  describe('commands (project-skill palette)', () => {
    it('surfaces the project skills under the session cwd as slash commands', async () => {
      const { runtime } = makeRuntime();
      const commands = [{ command: 'deploy', fullCommand: '/deploy', description: 'Ship it' }];
      vi.mocked(scanSkillCommands).mockReturnValue(commands);

      const registry = await runtime.getCommands(false, '/projects/demo');

      expect(scanSkillCommands).toHaveBeenCalledWith('/projects/demo');
      expect(registry.commands).toEqual(commands);
      expect(typeof registry.lastScanned).toBe('string');
    });

    it('returns an empty palette with no cwd (cold discovery, no project to scan)', async () => {
      const { runtime } = makeRuntime();

      const registry = await runtime.getCommands();

      expect(registry.commands).toEqual([]);
      expect(scanSkillCommands).not.toHaveBeenCalled();
    });
  });

  describe('mcp status (Codex config surfacing)', () => {
    it('warms lazily then serves the configured servers synchronously from cache', async () => {
      const { runtime } = makeRuntime();
      const servers = [{ name: 'linear', type: 'http' as const, scope: 'user' }];
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(servers);

      // The synchronous interface returns null on the cold call while the async
      // `codex mcp list` probe warms the cache out-of-band.
      expect(runtime.getMcpStatus('/projects/demo')).toBeNull();

      await vi.waitFor(() => {
        expect(runtime.getMcpStatus('/projects/demo')).toEqual(servers);
      });
      // Subsequent calls hit the warm cache — no re-enumeration.
      runtime.getMcpStatus('/projects/demo');
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);
    });

    it('caches an empty result (no servers configured) without re-enumerating', async () => {
      const { runtime } = makeRuntime();
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue([]);

      expect(runtime.getMcpStatus('/p')).toBeNull();
      await vi.waitFor(() => {
        expect(runtime.getMcpStatus('/p')).toEqual([]);
      });
      runtime.getMcpStatus('/p');
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);
    });

    it('stays null when enumeration genuinely fails', async () => {
      const { runtime } = makeRuntime();
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(null);

      expect(runtime.getMcpStatus('/p')).toBeNull();
      await vi.waitFor(() => {
        expect(enumerateCodexMcpServers).toHaveBeenCalled();
      });
      expect(runtime.getMcpStatus('/p')).toBeNull();
    });

    it('pre-warms the cache on ensureSession so the first getMcpStatus is populated', async () => {
      const { runtime } = makeRuntime();
      const servers = [{ name: 'linear', type: 'http' as const, scope: 'user' }];
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(servers);

      // ensureSession kicks the warm before any getMcpStatus call.
      runtime.ensureSession(crypto.randomUUID(), {
        permissionMode: 'default',
        cwd: '/projects/demo',
      });
      await vi.waitFor(() => {
        expect(runtime.getMcpStatus('/projects/demo')).toEqual(servers);
      });
      // The pre-warm satisfied the first ask — no extra probe from getMcpStatus.
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);
    });

    it('re-warms after the TTL window but serves the cached value within it', async () => {
      const { runtime } = makeRuntime();
      const first = [{ name: 'linear', type: 'http' as const, scope: 'user' }];
      const second = [{ name: 'github', type: 'http' as const, scope: 'user' }];
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(first);

      const t0 = 1_000_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t0);

      runtime.getMcpStatus('/p'); // kicks the initial warm
      await vi.waitFor(() => expect(runtime.getMcpStatus('/p')).toEqual(first));
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);

      // Within the TTL: no re-warm, still serves the cached value.
      nowSpy.mockReturnValue(t0 + 30_000);
      expect(runtime.getMcpStatus('/p')).toEqual(first);
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(1);

      // Past the TTL: background re-warm, but the stale value is returned
      // immediately (the getter stays synchronous).
      vi.mocked(enumerateCodexMcpServers).mockResolvedValue(second);
      nowSpy.mockReturnValue(t0 + 61_000);
      expect(runtime.getMcpStatus('/p')).toEqual(first);
      await vi.waitFor(() => expect(runtime.getMcpStatus('/p')).toEqual(second));
      expect(enumerateCodexMcpServers).toHaveBeenCalledTimes(2);

      nowSpy.mockRestore();
    });
  });
});

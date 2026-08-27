/**
 * DOR-493 — a session's stored settings live under exactly ONE key.
 *
 * A brand-new claude-code session is created under the id DorkOS mints, then
 * rebound to the canonical id the SDK assigns on the first turn. Settings
 * written before that rebind land under the pre-rebind id. Unless the row MOVES
 * with the session, two things break:
 *
 * 1. Enforcement. After eviction or a restart there is no in-memory session to
 *    translate ids, so a turn triggered under the canonical id hydrates a miss
 *    and the runtime enforces its DEFAULT mode — the agent silently stops asking
 *    (or starts asking) against the operator's choice.
 * 2. Agreement. Two reads of the same session can find different rows.
 *
 * These tests drive the REAL runtime, the REAL registry and a REAL database, and
 * assert the permission mode that reaches the SDK `query()` call — the value
 * that is actually enforced — never a read-back through the same resolver the
 * production read path uses.
 */
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import type { PermissionMode } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { sessionMetadata, type Db } from '@dorkos/db';
import { wrapSdkQuery, sdkSimpleText } from './sdk-scenarios.js';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { overlayStoredSettings } from '../../../session/session-settings-overlay.js';
import { SESSIONS } from '../../../../config/constants.js';
import type { Session } from '@dorkos/shared/types';

// Same hoisted stubs the sibling runtime tests use — context assembly and tool
// filtering are irrelevant here and must not touch the filesystem.
const { contextBuilderFactory, toolFilterFactory } = vi.hoisted(() => ({
  contextBuilderFactory: () => ({
    buildSystemPromptAppend: vi
      .fn()
      .mockResolvedValue({ text: '<env>mock</env>', stable: '<env>mock</env>' }),
    renderContextEntry: vi.fn((entry: { kind: string }) => `<${entry.kind}>mock</${entry.kind}>`),
  }),
  toolFilterFactory: () => ({
    resolveToolConfig: vi
      .fn()
      .mockReturnValue({ tasks: true, relay: true, mesh: true, adapter: true }),
  }),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));
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
vi.mock('../messaging/context-builder.js', contextBuilderFactory);
vi.mock('../tooling/tool-filter.js', toolFilterFactory);
vi.mock('@dorkos/shared/manifest', () => ({ readManifest: vi.fn().mockResolvedValue(null) }));
vi.mock('../../../relay/relay-state.js', () => ({
  isRelayEnabled: vi.fn().mockReturnValue(false),
}));
vi.mock('../../../tasks/task-state.js', () => ({ isTasksEnabled: vi.fn().mockReturnValue(false) }));
// The server's execution defaults, as `resolveSessionDefaults` reads them.
// Mutable because the seeded-default direction below needs
// `runtimes.defaultTrustStop` set — that config is what makes
// `persistSessionRuntime` write a permission mode nobody chose.
const { serverConfig } = vi.hoisted(() => ({
  serverConfig: { runtimes: {} as Record<string, unknown> },
}));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: vi.fn(() => serverConfig.runtimes) },
}));
vi.mock('../../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn().mockResolvedValue('/mock/path'),
  validateBoundaryOrDorkHome: vi.fn().mockResolvedValue('/mock/path'),
  getBoundary: vi.fn().mockReturnValue('/mock/boundary'),
  initBoundary: vi.fn().mockResolvedValue('/mock/boundary'),
  isWithinBoundary: vi.fn().mockResolvedValue(true),
}));
vi.mock('../tooling/command-registry.js', () => ({
  CommandRegistryService: vi.fn().mockImplementation(() => ({
    getCommands: vi.fn().mockResolvedValue({ commands: [], lastScanned: '' }),
    invalidateCache: vi.fn(),
  })),
}));
vi.mock('../../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: vi.fn(), addClient: vi.fn(), clientCount: 0 },
}));
vi.mock('../../../../lib/dork-home.js', () => ({
  resolveDorkHome: vi.fn().mockReturnValue('/tmp/dorkos-test-rekey'),
}));
vi.mock('../../../marketplace/installed-scanner.js', () => ({
  listEnabledPluginNames: vi.fn().mockResolvedValue([]),
}));
vi.mock('../messaging/plugin-activation.js', () => ({
  buildClaudeAgentSdkPluginsArray: vi.fn().mockResolvedValue([]),
}));

/** The id DorkOS mints client-side and the POST is triggered with. */
const REQUEST_ID = '11111111-1111-4111-8111-111111111111';
/** The id the SDK assigns on the first turn; every later read uses this one. */
const CANONICAL_ID = '22222222-2222-4222-8222-222222222222';

describe('claude-code session-settings re-key on canonical-id rebind (DOR-493)', () => {
  let runtime: InstanceType<typeof import('../claude-code-runtime.js').ClaudeCodeRuntime>;
  let registry: RuntimeRegistry;
  let db: Db;
  let mockedQuery: Mock;

  beforeEach(async () => {
    // No server defaults unless a test asks for them.
    serverConfig.runtimes = {};
    // Reset the module graph so each test gets a fresh runtime AND a fresh
    // `query` spy (the top-level vi.mock factory re-runs on re-import).
    vi.resetModules();
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    mockedQuery = sdk.query as unknown as Mock;

    db = createTestDb();
    registry = new RuntimeRegistry();
    registry.setDb(db);

    const mod = await import('../claude-code-runtime.js');
    runtime = new mod.ClaudeCodeRuntime('/mock/path');
    registry.register(runtime);
    runtime.setSessionSettings(registry);
  });

  /** Run one full turn, with the SDK reporting `sdkSessionId` for every message. */
  async function runTurn(triggerId: string, sdkSessionId: string): Promise<void> {
    mockedQuery.mockClear();
    mockedQuery.mockReturnValue(wrapSdkQuery(sdkSimpleText('ok', sdkSessionId)));
    for await (const _event of runtime.sendMessage(triggerId, 'hello')) {
      // drain
    }
  }

  /** The permission mode handed to the SDK on the most recent `query()` call. */
  function enforcedMode(): PermissionMode | undefined {
    const call = mockedQuery.mock.calls.at(-1) as
      [{ options?: { permissionMode?: PermissionMode } }] | undefined;
    // Without this, a turn that never reached the SDK would throw a bare
    // TypeError instead of naming what went wrong.
    expect(call, 'the SDK was never queried — there is no enforced mode').toBeDefined();
    return call![0].options?.permissionMode;
  }

  /** Push every in-memory session past its idle timeout and evict it. */
  function evictEverything(): void {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SESSIONS.TIMEOUT_MS + 1);
    runtime.checkSessionHealth();
    clock.mockRestore();
  }

  /** A transcript-derived session as the read paths receive it (store not applied). */
  function transcriptSession(id: string): Session {
    return {
      id,
      title: 'Session',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      permissionMode: 'default',
      runtime: 'claude-code',
    };
  }

  it('enforces the operator mode on a post-eviction turn under the canonical id', async () => {
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code');
    // The operator sets bypassPermissions before the first turn — the PATCH
    // route's exact call, under the only id that exists yet.
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'bypassPermissions' });

    await runTurn(REQUEST_ID, CANONICAL_ID);
    expect(runtime.getInternalSessionId(REQUEST_ID)).toBe(CANONICAL_ID);
    // In-memory, the mode is enforced — this half already worked.
    expect(enforcedMode()).toBe('bypassPermissions');

    evictEverything();
    expect(runtime.hasSession(CANONICAL_ID)).toBe(false);
    expect(runtime.hasSession(REQUEST_ID)).toBe(false);

    // The client re-keyed to the canonical id long ago; this is every turn from
    // now on. Nothing in memory translates ids, so the store must answer.
    await runTurn(CANONICAL_ID, CANONICAL_ID);

    // The value the SDK is actually given. A resolver read-back would pass here
    // even unfixed, and prove nothing.
    expect(enforcedMode()).toBe('bypassPermissions');
  });

  it('leaves the settings under exactly one key after the rebind', async () => {
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code', '/agents/dorkbot');
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'plan', model: 'sonnet' });

    await runTurn(REQUEST_ID, CANONICAL_ID);

    const rows = db.select().from(sessionMetadata).all();
    expect(rows.map((r) => r.sessionId)).toEqual([CANONICAL_ID]);
    expect(rows[0]).toMatchObject({
      runtime: 'claude-code',
      agentPath: '/agents/dorkbot',
      permissionMode: 'plan',
      model: 'sonnet',
    });
    await expect(registry.getSessionSettings(REQUEST_ID)).resolves.toBeNull();
  });

  it('keeps a pre-turn and a post-turn change in the same row', async () => {
    // The divergence a reviewer built on DOR-463: a change made before the first
    // turn landed under the request id, a later one under the canonical id, and
    // which row a read found depended on which id it arrived with.
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code');
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'plan' });

    await runTurn(REQUEST_ID, CANONICAL_ID);

    await runtime.updateSession(CANONICAL_ID, { permissionMode: 'bypassPermissions' });

    const rows = db.select().from(sessionMetadata).all();
    expect(rows.map((r) => r.sessionId)).toEqual([CANONICAL_ID]);
    expect(rows[0]?.permissionMode).toBe('bypassPermissions');
  });

  it('shows a pre-turn change on a read keyed by the canonical id', async () => {
    // The other half of the divergence: the canonical read found no row at all
    // and reported the transcript-derived mode, while a read arriving with the
    // retired id reached the operator's row through the extra key. With one row
    // and one key there is nothing left for two reads to disagree about.
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code');
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'plan' });

    await runTurn(REQUEST_ID, CANONICAL_ID);
    evictEverything();

    const sessions = [transcriptSession(CANONICAL_ID)];
    overlayStoredSettings(sessions, registry);

    expect(sessions[0]?.permissionMode).toBe('plan');
  });

  it('never lets the retired row overwrite a newer choice made under the canonical id', async () => {
    // The re-key merges two rows, and the source is the OLDER of the two. A
    // settings write can land on the canonical id between the SDK announcing it
    // and the re-key firing, so a source-wins merge would reinstate the mode the
    // operator just moved away from — an agent acting without asking, which is
    // the exact failure this ticket exists to remove.
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code');
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'bypassPermissions' });

    mockedQuery.mockClear();
    mockedQuery.mockReturnValue(wrapSdkQuery(sdkSimpleText('ok', CANONICAL_ID)));
    let wrote = false;
    for await (const _event of runtime.sendMessage(REQUEST_ID, 'hello')) {
      // The first mapped event proves the SDK has announced the canonical id;
      // the PATCH route resolves to it from here on, so this is where a
      // concurrent settings write lands.
      if (!wrote && runtime.getInternalSessionId(REQUEST_ID) === CANONICAL_ID) {
        wrote = true;
        await registry.saveSessionSettings(CANONICAL_ID, { permissionMode: 'plan' });
      }
    }
    expect(wrote, 'the interleaving never happened — this test proved nothing').toBe(true);

    const rows = db.select().from(sessionMetadata).all();
    expect(rows.map((r) => r.sessionId)).toEqual([CANONICAL_ID]);
    expect(rows[0]?.permissionMode).toBe('plan');
  });

  it('never lets a SEEDED default outrank the operator choice, mid-turn', async () => {
    // The mirror of the test above, and the reason recency of the ROW cannot be
    // the rule. The cockpit adopts the canonical id the instant `trigger-turn`
    // announces it as `retiredSessionId`, and its next message is POSTed under
    // that id. If the row has not moved yet, that POST reaches
    // `persistSessionRuntime` with an id the table has never seen: it mints a
    // second row, pre-seeded from the server's configured trust stop, and
    // reports a brand-new session. The seeded row is NEWER than the operator's
    // and nothing in it was chosen by anybody, so destination-wins hands the
    // session a default the operator had already overridden — while source-wins
    // loses the other direction. The fix is not a better merge rule: the row
    // moves before the id is ever announced, so the rival is never minted.
    serverConfig.runtimes = { defaultTrustStop: 'act' };
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code', undefined, {
      interactive: true,
    });
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'plan', model: 'opus' });

    // The control: this config really does seed `acceptEdits` for an id nobody
    // has touched. Without it, every assertion below could pass because the
    // fixture never armed the seed at all.
    await registry.persistSessionRuntime('unrelated-session', 'claude-code', undefined, {
      interactive: true,
    });
    expect(
      (await registry.getSessionSettings('unrelated-session'))?.permissionMode,
      'the trust-stop seed is not armed — this test proves nothing'
    ).toBe('acceptEdits');

    mockedQuery.mockClear();
    mockedQuery.mockReturnValue(wrapSdkQuery(sdkSimpleText('ok', CANONICAL_ID)));
    let posted = false;
    let countedAsNew: boolean | undefined;
    for await (const _event of runtime.sendMessage(REQUEST_ID, 'hello')) {
      // The client has adopted the canonical id and sends its next message. The
      // route persists on the id it was called with, so this binds CANONICAL_ID
      // — exactly what `POST /api/sessions/:id/messages` does.
      if (!posted && runtime.getInternalSessionId(REQUEST_ID) === CANONICAL_ID) {
        posted = true;
        countedAsNew = await registry.persistSessionRuntime(
          CANONICAL_ID,
          'claude-code',
          undefined,
          { interactive: true }
        );
      }
    }
    expect(posted, 'the interleaving never happened — this test proved nothing').toBe(true);

    const rows = db
      .select()
      .from(sessionMetadata)
      .all()
      .filter((r) => r.sessionId !== 'unrelated-session');
    expect(rows.map((r) => r.sessionId)).toEqual([CANONICAL_ID]);
    // The operator chose `plan`. Nobody chose `acceptEdits`.
    expect(rows[0]?.permissionMode).toBe('plan');
    expect(rows[0]?.model).toBe('opus');

    // The same mid-turn write is what double-fired `session_created`: this is
    // the session's own next message, not a second session (DOR-838).
    expect(countedAsNew, 'a message under the canonical id is not a NEW session').toBe(false);
  });

  it('does not let the next turn under the canonical id count as a second new session', async () => {
    // `persistSessionRuntime` returning true is the once-per-session signal the
    // POST /messages route fires `session_created` usage telemetry on. The row
    // used to stay under the request id, so the FIRST post under the canonical
    // id — which is every post after the client re-keys — inserted a fresh row,
    // returned true, and counted the same session twice.
    const firstPost = await registry.persistSessionRuntime(REQUEST_ID, 'claude-code');
    expect(firstPost, 'the session was never minted — this test proved nothing').toBe(true);

    await runTurn(REQUEST_ID, CANONICAL_ID);

    // The client re-keyed to the canonical id; this is its next message.
    const nextPost = await registry.persistSessionRuntime(CANONICAL_ID, 'claude-code');

    expect(nextPost).toBe(false);
    expect(db.select().from(sessionMetadata).all()).toHaveLength(1);
  });

  it('survives a settings-store failure without killing the turn', async () => {
    // Before DOR-493 the rebind was Map writes that could not throw. It now
    // awaits a database write, so a failing store must not take the turn — and
    // the id alias must still be published, or approvals, interrupt and the
    // event stream all stop resolving by the canonical id for the rest of the
    // session's life.
    const boom = vi
      .spyOn(registry, 'rekeySessionSettings')
      .mockRejectedValue(new Error('database is locked'));
    await registry.persistSessionRuntime(REQUEST_ID, 'claude-code');
    await runtime.updateSession(REQUEST_ID, { permissionMode: 'plan' });

    mockedQuery.mockClear();
    mockedQuery.mockReturnValue(wrapSdkQuery(sdkSimpleText('ok', CANONICAL_ID)));
    const events: string[] = [];
    for await (const event of runtime.sendMessage(REQUEST_ID, 'hello')) {
      events.push(event.type);
    }

    expect(boom).toHaveBeenCalledWith(REQUEST_ID, CANONICAL_ID);
    // The turn ran to its terminal event and reported no failure to the client.
    expect(events).toContain('done');
    expect(events).not.toContain('error');
    // The alias is published even though the row could not move.
    expect(runtime.hasSession(CANONICAL_ID)).toBe(true);
    expect(runtime.getInternalSessionId(CANONICAL_ID)).toBe(CANONICAL_ID);

    // The two facts that separate a handled failure from a swallowed one. The
    // row really is stranded under the retired id — that is the cost being
    // accepted, so it is asserted rather than implied — and the failure was
    // REPORTED. Without these, an empty `catch {}` passes every line above.
    const rows = db.select().from(sessionMetadata).all();
    expect(rows.map((r) => r.sessionId)).toEqual([REQUEST_ID]);
    expect(rows[0]?.permissionMode).toBe('plan');
    const { logger } = await import('../../../../lib/logger.js');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('settings re-key failed'),
      expect.objectContaining({
        previousSdkSessionId: REQUEST_ID,
        nextSdkSessionId: CANONICAL_ID,
        err: 'database is locked',
      })
    );
    boom.mockRestore();
  });

  it('does not re-key when the SDK keeps the id it was given (resumed session)', async () => {
    await registry.persistSessionRuntime(CANONICAL_ID, 'claude-code');
    await runtime.updateSession(CANONICAL_ID, { permissionMode: 'acceptEdits' });

    await runTurn(CANONICAL_ID, CANONICAL_ID);

    const rows = db.select().from(sessionMetadata).all();
    expect(rows.map((r) => r.sessionId)).toEqual([CANONICAL_ID]);
    expect(rows[0]?.permissionMode).toBe('acceptEdits');
  });
});

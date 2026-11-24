/**
 * What a relay-triggered turn runs on. The manifest tier runs for real against
 * a `.dork/agent.json` on disk, because the reported break was that nothing on
 * this path read one. Only the registry and the config file are doubles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import type { SessionSettings } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';

/** What `session_metadata` holds for the session under test — `null` = no row. */
let storedSettings: SessionSettings | null = null;
/** What reading that row does. */
let readSettings: () => Promise<SessionSettings | null> = () => Promise.resolve(storedSettings);
/** Which runtimes this server registered, and what each declares about itself. */
let registered: Record<string, { configSection: string | null; supportsEffort: boolean }> = {};

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    computerRuntimeForAgentPath: () => undefined,
    getNativeSessionCwd: vi.fn(() => null),
    getSessionSettings: () => readSettings(),
    getSessionAgentPath: async () => null,
    has: (type: string) => registered[type] !== undefined,
    // The real `get` THROWS on an unregistered type, so this double does too.
    get: (type: string) => {
      const declared = registered[type];
      if (!declared) throw new Error(`Runtime '${type}' not registered`);
      return { getCapabilities: () => ({ settings: { ...declared, sections: [] } }) };
    },
  },
}));

let runtimesConfig: UserConfig['runtimes'] = USER_CONFIG_DEFAULTS.runtimes;
vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? runtimesConfig : undefined) },
}));

/** The accounts the registry holds. */
let accounts: {
  runtime: string;
  id: string;
  routable: boolean;
  implicit: boolean;
  isDefault: boolean;
}[] = [];
vi.mock('../../core/usage/current-usage-store.js', () => ({
  getAccountUsageStore: () => ({
    listAccounts: (runtime: string) => accounts.filter((a) => a.runtime === runtime),
  }),
}));

const checkAccountLaunch = vi.fn();
vi.mock('../../core/usage/account-ranking.js', () => ({
  checkAccountLaunch: (request: unknown) => checkAccountLaunch(request),
}));

const { createTurnExecutionSettingsResolver } = await import('../turn-execution-settings.js');
const { setSessionAgentSources } = await import('../../core/agent-identity/session-agent.js');
const { clearTestHomes, registerTestHomes } =
  await import('../../core/agent-identity/__tests__/agent-home-fixture.js');

let agentDir: string;
const CLAUDE = { configSection: 'claudeCode', supportsEffort: true };

/** Write an agent manifest to `dir/.dork/agent.json`. */
async function writeManifest(manifest: Record<string, unknown>, dir = agentDir): Promise<void> {
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'agent.json'),
    JSON.stringify({
      id: 'ana',
      name: 'Ana',
      runtime: 'claude-code',
      registeredAt: '2026-08-18T10:00:00.000Z',
      registeredBy: 'test',
      ...manifest,
    })
  );
}

/** Set the server-wide Claude Code defaults. */
function serverDefaults(claudeCode: Partial<UserConfig['runtimes']['claudeCode']>): void {
  runtimesConfig = {
    ...USER_CONFIG_DEFAULTS.runtimes,
    claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, ...claudeCode },
  };
}

function resolveFor(runtimeType = 'claude-code', extra: Record<string, unknown> = {}) {
  return createTurnExecutionSettingsResolver()({
    runtimeType,
    sessionId: 'agent-ulid-1',
    agentDirectory: agentDir,
    ...extra,
  });
}

beforeEach(async () => {
  storedSettings = null;
  readSettings = () => Promise.resolve(storedSettings);
  runtimesConfig = USER_CONFIG_DEFAULTS.runtimes;
  registered = { 'claude-code': CLAUDE };
  accounts = [];
  checkAccountLaunch.mockReset();
  agentDir = await mkdtemp(path.join(tmpdir(), 'dorkos-relay-agent-'));
});

afterEach(async () => {
  await rm(agentDir, { recursive: true, force: true });
});

describe('createTurnExecutionSettingsResolver', () => {
  it.each([
    // An agent pinned to haiku used to answer a colleague on the server's default.
    [
      "the agent's own model over the server default",
      { model: 'claude-haiku-4-5', effort: 'low' },
      null,
      { model: 'claude-haiku-4-5', effort: 'low' },
    ],
    ["the server's default when the agent names none", {}, null, { model: 'opus' }],
    // A row with settings is a running conversation, whatever the manifest says now.
    [
      'a running conversation keeps its settings',
      { model: 'claude-haiku-4-5' },
      { model: 'opus', effort: 'high', fastMode: true },
      { model: 'opus', effort: 'high', fastMode: true },
    ],
    // Moving the trust dial writes a row naming only a mode; that is not a model.
    [
      'a row naming only a permission mode keeps the manifest model',
      { model: 'claude-haiku-4-5' },
      { permissionMode: 'plan' },
      { model: 'claude-haiku-4-5' },
    ],
    // The relay resolves its own mode from the binding (DOR-604).
    [
      'never a permission mode, whatever the row holds',
      undefined,
      { permissionMode: 'bypassPermissions', model: 'opus' },
      { model: 'opus' },
    ],
    // This build has no Codex adapter, so the turn falls back to claude-code.
    [
      'never a Codex model on the claude-code fallback',
      { runtime: 'codex', model: 'gpt-5.3-codex' },
      null,
      { model: 'opus' },
    ],
  ] as const)('answers %s', async (_label, manifest, stored, expected) => {
    serverDefaults({ defaultModel: 'opus' });
    if (manifest) await writeManifest(manifest);
    storedSettings = stored as SessionSettings | null;
    expect(await resolveFor()).toEqual(expected);
  });

  it('fills only the keys a row leaves unanswered', async () => {
    serverDefaults({ defaultEffort: 'high' });
    await writeManifest({ model: 'claude-haiku-4-5' });
    storedSettings = { fastMode: true };
    expect(await resolveFor()).toEqual({
      model: 'claude-haiku-4-5',
      effort: 'high',
      fastMode: true,
    });
  });

  it('asks for nothing when nothing is configured anywhere', async () => {
    expect(await resolveFor()).toEqual({});
  });

  it('starts on the ladder when the settings row cannot be read', async () => {
    readSettings = () => Promise.reject(new Error('database is locked'));
    await writeManifest({ model: 'claude-haiku-4-5' });
    expect(await resolveFor()).toEqual({ model: 'claude-haiku-4-5' });
  });

  it('drops an effort a runtime says it has none of', async () => {
    registered = { opencode: { configSection: 'opencode', supportsEffort: false } };
    await writeManifest({ runtime: 'opencode', model: 'anthropic/claude-opus', effort: 'high' });
    expect(await resolveFor('opencode')).toEqual({ model: 'anthropic/claude-opus' });
  });

  it('answers rather than throws for an unregistered runtime (DOR-1614)', async () => {
    registered = {};
    await writeManifest({ runtime: 'codex', model: 'gpt-5.3-codex' });
    expect(await resolveFor('codex')).toEqual({ model: 'gpt-5.3-codex' });
  });

  // DOR-5057: a turn addressed to a chat names no agent; the chat's own agent answers.
  it("reads the chat's own agent when the turn names none, and the subject's agent when it does", async () => {
    await writeManifest({ model: 'claude-haiku-4-5' });
    const other = await mkdtemp(path.join(tmpdir(), 'dorkos-relay-other-'));
    await writeManifest({ id: 'rio', name: 'Rio', model: 'claude-opus-4-1' }, other);
    const { RuntimeRegistry } = await vi.importActual<
      typeof import('../../core/runtime-registry.js')
    >('../../core/runtime-registry.js');
    const db = createTestDb();
    const registry = new RuntimeRegistry();
    registry.setDb(db);
    registry.register(new FakeAgentRuntime('claude-code') as never);
    await registry.persistSessionRuntime('chat-1', 'claude-code', { kind: 'interactive' });
    registerTestHomes([agentDir, other]);
    try {
      setSessionAgentSources({ db, liveCwd: (id) => (id === 'chat-1' ? agentDir : undefined) });
      expect(
        await resolveFor('claude-code', { sessionId: 'chat-1', agentDirectory: undefined })
      ).toEqual({ model: 'claude-haiku-4-5' });
      setSessionAgentSources({ db: createTestDb(), liveCwd: () => other });
      expect(await resolveFor('claude-code', { sessionId: 'chat-1' })).toEqual({
        model: 'claude-haiku-4-5',
      });
    } finally {
      setSessionAgentSources(undefined);
      clearTestHomes();
      await rm(other, { recursive: true, force: true });
    }
  });
});

describe('a relay message naming an account (DOR-2384)', () => {
  beforeEach(() => {
    accounts = [
      { runtime: 'claude-code', id: 'work', routable: true, implicit: false, isDefault: false },
    ];
  });

  it('launches on the account when the advisor allows it, asking as a relay caller', async () => {
    checkAccountLaunch.mockResolvedValue({ allowed: true });
    expect((await resolveFor('claude-code', { requestedAccount: 'work' })).accountHint).toBe(
      'work'
    );
    expect(checkAccountLaunch).toHaveBeenCalledWith({
      accountId: 'work',
      cwd: agentDir,
      runtime: 'claude-code',
      caller: 'relay',
    });
  });

  it('runs without the account when the advisor refuses it or none is registered', async () => {
    checkAccountLaunch.mockResolvedValue({ allowed: false, reason: 'no advisor' });
    expect(await resolveFor('claude-code', { requestedAccount: 'work' })).not.toHaveProperty(
      'accountHint'
    );
  });

  it('never asks the advisor about an id nobody registered', async () => {
    checkAccountLaunch.mockResolvedValue({ allowed: true });
    expect(
      await resolveFor('claude-code', { requestedAccount: 'someone-elses' })
    ).not.toHaveProperty('accountHint');
    expect(checkAccountLaunch).not.toHaveBeenCalled();
  });

  it('runs the turn on its settings when the account check throws', async () => {
    checkAccountLaunch.mockRejectedValue(new Error('advisor exploded'));
    await writeManifest({ model: 'claude-opus-4-6' });
    expect(await resolveFor('claude-code', { requestedAccount: 'work' })).toEqual({
      model: 'claude-opus-4-6',
    });
  });
});

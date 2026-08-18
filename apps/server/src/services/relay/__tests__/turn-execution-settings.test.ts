/**
 * What a relay-triggered turn runs on.
 *
 * The manifest tier runs for real here — `readAgentExecutionDefaults` reads a
 * real `.dork/agent.json` off disk — because the reported break was that
 * nothing on this path read one at all, and a stubbed manifest would prove
 * nothing about it. Only the registry (a database) and the config file are
 * doubles.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import type { SessionSettings } from '@dorkos/shared/types';

/** What `session_metadata` holds for the session under test — `null` = no row. */
let storedSettings: SessionSettings | null = null;
/** What reading that row does. Throws for the one test about a locked database. */
let readSettings: () => Promise<SessionSettings | null> = () => Promise.resolve(storedSettings);
/** Which runtimes this server registered, and what each declares about itself. */
let registered: Record<string, { configSection: string | null; supportsEffort: boolean }> = {};

vi.mock('../../core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getSessionSettings: () => readSettings(),
    get: (type: string) =>
      registered[type]
        ? { getCapabilities: () => ({ settings: { ...registered[type], sections: [] } }) }
        : undefined,
  },
}));

/** The stored `runtimes` section the real resolver reads. */
let runtimesConfig: UserConfig['runtimes'] = USER_CONFIG_DEFAULTS.runtimes;

vi.mock('../../core/config-manager.js', () => ({
  configManager: { get: (key: string) => (key === 'runtimes' ? runtimesConfig : undefined) },
}));

const { createTurnExecutionSettingsResolver } = await import('../turn-execution-settings.js');

/** An agent directory holding the manifest this test wrote. */
let agentDir: string;

/**
 * Write an agent manifest to disk, exactly where `.dork/agent.json` lives.
 *
 * @param manifest - The manifest fields under test.
 */
async function writeManifest(manifest: Record<string, unknown>): Promise<void> {
  await mkdir(path.join(agentDir, '.dork'), { recursive: true });
  await writeFile(
    path.join(agentDir, '.dork', 'agent.json'),
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

describe('createTurnExecutionSettingsResolver', () => {
  beforeEach(async () => {
    storedSettings = null;
    readSettings = () => Promise.resolve(storedSettings);
    runtimesConfig = USER_CONFIG_DEFAULTS.runtimes;
    registered = { 'claude-code': { configSection: 'claudeCode', supportsEffort: true } };
    agentDir = await mkdtemp(path.join(tmpdir(), 'dorkos-relay-agent-'));
  });

  afterEach(async () => {
    await rm(agentDir, { recursive: true, force: true });
  });

  it("runs the turn on the addressed agent's own model", async () => {
    // The reported break, end to end: an agent pinned to haiku answered a
    // colleague on the server's default because nothing here read the manifest.
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    };
    await writeManifest({ model: 'claude-haiku-4-5', effort: 'low' });

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'agent-ulid-1',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'claude-haiku-4-5', effort: 'low' });
  });

  it("falls back to the server's default for an agent that names no model", async () => {
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    };
    await writeManifest({});

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'agent-ulid-1',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'opus' });
  });

  it('asks for nothing when nothing is configured anywhere', async () => {
    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'agent-ulid-1',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({});
  });

  it('leaves a conversation that already has settings alone', async () => {
    // "Applies to new conversations — running ones keep their settings." A relay
    // thread with a row is a running one, whatever the manifest now says. It has
    // to be read HERE rather than left to the runtime: the adapter creates the
    // session record before the runtime's own hydration would run.
    await writeManifest({ model: 'claude-haiku-4-5' });
    storedSettings = { model: 'opus', effort: 'high', fastMode: true };

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'sdk-uuid-42',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'opus', effort: 'high', fastMode: true });
  });

  it('never answers with a permission mode, whatever the row holds', async () => {
    // The relay resolves its own mode from the binding that carried the message
    // and treats an absent one as prompting rather than as consent (DOR-604).
    storedSettings = { permissionMode: 'bypassPermissions', model: 'opus' };

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'sdk-uuid-42',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'opus' });
  });

  it('never seeds a Codex model onto the claude-code session it falls back to', async () => {
    // This build has no Codex adapter, so the relay turn runs on claude-code —
    // and `gpt-5.3-codex` would otherwise reach the Claude Code SDK as an id
    // from another provider's namespace.
    registered = { 'claude-code': { configSection: 'claudeCode', supportsEffort: true } };
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    };
    await writeManifest({ runtime: 'codex', model: 'gpt-5.3-codex' });

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'agent-ulid-1',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'opus' });
  });

  it('answers for an agent nobody could locate', async () => {
    // No directory means no manifest tier at all, not a refusal: the server's
    // default still applies.
    runtimesConfig = {
      ...USER_CONFIG_DEFAULTS.runtimes,
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    };

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'agent-ulid-1',
    });

    expect(settings).toEqual({ model: 'opus' });
  });

  it('starts a new session on the ladder when the settings row cannot be read', async () => {
    // A locked database makes "has this conversation got settings?" unanswerable
    // for a moment. The honest fallback is the ladder a new session starts on,
    // never a refused turn — the message is somebody's agent talking.
    readSettings = () => Promise.reject(new Error('database is locked'));
    await writeManifest({ model: 'claude-haiku-4-5' });

    const settings = await createTurnExecutionSettingsResolver('claude-code')({
      sessionId: 'agent-ulid-1',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'claude-haiku-4-5' });
  });

  it('drops an effort a runtime says it has none of', async () => {
    registered = { opencode: { configSection: 'opencode', supportsEffort: false } };
    await writeManifest({ runtime: 'opencode', model: 'anthropic/claude-opus', effort: 'high' });

    const settings = await createTurnExecutionSettingsResolver('opencode')({
      sessionId: 'agent-ulid-1',
      agentDirectory: agentDir,
    });

    expect(settings).toEqual({ model: 'anthropic/claude-opus' });
  });
});

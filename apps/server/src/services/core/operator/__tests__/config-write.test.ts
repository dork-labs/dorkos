/**
 * The guarded config write, as the three doors reach it — and in particular as
 * `dorkos config set` reaches it (DOR-1247).
 *
 * ## Why this file and not a CLI test
 *
 * The CLI cannot execute this code from source. It reaches the server through a
 * specifier that only resolves once esbuild has rewritten it, so a test in
 * `packages/cli` can only assert that `handleConfigSet` calls the writer it was
 * handed — never what the writer DOES. That half is asserted there; this file is
 * the other half, running the real function against a real `ConfigManager` over
 * a real temp data directory, under the exact authority the CLI passes.
 *
 * Nothing here is mocked except the clock the logger writes to.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ConfigManager } from '../../config-manager.js';
import type { ConfigWriteAuthority } from '../config-write.js';

/** The stop that turns the approval gate off for every session born after it. */
const AUTONOMY_STOP_PATH = 'runtimes.claudeCode.defaultTrustStop';

describe('applyGuardedConfigWrite', () => {
  let tmpDir: string;
  let configManager: ConfigManager;
  let applyGuardedConfigWrite: typeof import('../config-write.js').applyGuardedConfigWrite;
  let logConfigWrite: typeof import('../config-write.js').logConfigWrite;
  let LOCAL_OPERATOR_AUTHORITY: ConfigWriteAuthority;
  let OPERATOR_TOOL_AUTHORITY: ConfigWriteAuthority;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-config-write-'));
    process.env.DORK_HOME = tmpDir;

    const configModule = await import('../../config-manager.js');
    configManager = configModule.initConfigManager(tmpDir);

    const writeModule = await import('../config-write.js');
    applyGuardedConfigWrite = writeModule.applyGuardedConfigWrite;
    logConfigWrite = writeModule.logConfigWrite;
    LOCAL_OPERATOR_AUTHORITY = writeModule.LOCAL_OPERATOR_AUTHORITY;
    OPERATOR_TOOL_AUTHORITY = writeModule.OPERATOR_TOOL_AUTHORITY;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Every `info` line written while `run` executed.
   *
   * Spied on the real logger singleton, resolved through the same module
   * registry the code under test imported it from, so it is the very object the
   * write calls.
   */
  async function infoLines(run: () => void): Promise<string[]> {
    const { logger } = await import('../../../../lib/logger.js');
    const lines: string[] = [];
    const spy = vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
      lines.push(String(args[0]));
    });
    try {
      run();
    } finally {
      spy.mockRestore();
    }
    return lines;
  }

  /** The stored value of a Claude-Code default trust stop. */
  function storedStop(): string | null {
    return configManager.get('runtimes').claudeCode.defaultTrustStop;
  }

  describe('as `dorkos config set`, under the operator authority', () => {
    it('writes an operator-only setting and leaves a line naming the leaf and the door', async () => {
      // The write the CLI could always make, now with the record it never left.
      // `runtimes.claudeCode.defaultTrustStop` is the leaf DOR-1237 was about,
      // and it is `operator-only`: the point is that a person at their own
      // terminal may still move it, and that doing so is now visible.
      const lines = await infoLines(() => {
        const result = applyGuardedConfigWrite({
          patch: { runtimes: { claudeCode: { defaultTrustStop: 'act' } } },
          authority: LOCAL_OPERATOR_AUTHORITY,
          source: 'dorkos config set',
          writer: { kind: 'operator' },
        });
        expect(result.ok).toBe(true);
      });

      expect(storedStop()).toBe('act');
      expect(lines).toContain(`[Config] Patched by dorkos config set: ${AUTONOMY_STOP_PATH}`);
    });

    it('refuses Full autonomy without the acknowledgement, in the cockpit’s own words, and writes nothing', async () => {
      // Reproduced against the built CLI before this existed: `dorkos config set
      // runtimes.claudeCode.defaultTrustStop autonomy` on an install whose
      // `ui.autonomyAcknowledgedAt` was null left every new session starting
      // bypassed, with no dialog anywhere and nothing in the log.
      const { AUTONOMY_DEFAULT_ACK_MESSAGE, AUTONOMY_ACK_REQUIRED_CODE } =
        await import('../../approvals/autonomy-consent.js');

      const lines = await infoLines(() => {
        const result = applyGuardedConfigWrite({
          patch: { runtimes: { claudeCode: { defaultTrustStop: 'autonomy' } } },
          authority: LOCAL_OPERATOR_AUTHORITY,
          source: 'dorkos config set',
          writer: { kind: 'operator' },
        });

        expect(result.ok).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.kind).toBe('refused');
        if (result.kind !== 'refused') throw new Error('unreachable');
        // The same sentence and the same code the cockpit's 428 carries.
        expect(result.refusal.message).toBe(AUTONOMY_DEFAULT_ACK_MESSAGE);
        expect(result.refusal.code).toBe(AUTONOMY_ACK_REQUIRED_CODE);
        expect(result.refusal.status).toBe(428);
        expect(result.refusal.paths).toEqual([AUTONOMY_STOP_PATH]);
      });

      // Nothing written, and nothing claimed in the log.
      expect(storedStop()).toBeNull();
      expect(lines.filter((line) => line.startsWith('[Config] Patched by'))).toEqual([]);
    });

    it('lets Full autonomy through once the acknowledgement is on file', async () => {
      // The other half of the door: it asks once. Without this the refusal above
      // would pass just as well if the door were simply "never allow autonomy".
      applyGuardedConfigWrite({
        patch: { ui: { autonomyAcknowledgedAt: '2026-08-16T09:00:00.000Z' } },
        authority: LOCAL_OPERATOR_AUTHORITY,
        source: 'dorkos config set',
        writer: { kind: 'operator' },
      });

      const result = applyGuardedConfigWrite({
        patch: { runtimes: { claudeCode: { defaultTrustStop: 'autonomy' } } },
        authority: LOCAL_OPERATOR_AUTHORITY,
        source: 'dorkos config set',
        writer: { kind: 'operator' },
      });

      expect(result.ok).toBe(true);
      expect(storedStop()).toBe('autonomy');
    });

    it('still lets the person turn standing permissions off with login off', async () => {
      // `approvals.standingGrants` needs login ON over HTTP, because a caller
      // there could pre-arm it. At the terminal that rule would refuse the
      // person the PROTECTIVE direction — switching it off — on the one surface
      // `standing-grant-posture.ts` says has to work with no server running.
      configManager.set('approvals', {
        ...configManager.get('approvals'),
        standingGrants: true,
      });

      const result = applyGuardedConfigWrite({
        patch: { approvals: { standingGrants: false } },
        authority: LOCAL_OPERATOR_AUTHORITY,
        source: 'dorkos config set',
        writer: { kind: 'operator' },
      });

      expect(result.ok).toBe(true);
      expect(configManager.get('approvals').standingGrants).toBe(false);
    });

    it('refuses a value the schema will not take, instead of storing it', async () => {
      const result = applyGuardedConfigWrite({
        patch: { server: { port: 'notanumber' } },
        authority: LOCAL_OPERATOR_AUTHORITY,
        source: 'dorkos config set',
        writer: { kind: 'operator' },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.kind).toBe('invalid');
      // The old `setDot` path wrote this string into the file, and the server
      // then silently ran on a default it never mentioned.
      expect(configManager.get('server').port).toBe(4242);
    });
  });

  describe('as the config_patch tool, under the agent authority', () => {
    it('refuses the same operator-only leaf the CLI may write, and writes nothing', async () => {
      const { OPERATOR_ONLY_CONFIG_CODE } = await import('../config-write-policy.js');

      const result = applyGuardedConfigWrite({
        patch: { runtimes: { claudeCode: { defaultTrustStop: 'act' } } },
        authority: OPERATOR_TOOL_AUTHORITY,
        source: 'the config_patch tool',
        writer: { kind: 'agent', agentName: 'DorkBot' },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('unreachable');
      expect(result.refusal.code).toBe(OPERATOR_ONLY_CONFIG_CODE);
      expect(result.refusal.paths).toEqual([AUTONOMY_STOP_PATH]);
      expect(storedStop()).toBeNull();
    });

    it('lets an ordinary preference through, and names the tool in the line', async () => {
      const lines = await infoLines(() => {
        const result = applyGuardedConfigWrite({
          patch: { ui: { theme: 'dark' } },
          authority: OPERATOR_TOOL_AUTHORITY,
          source: 'the config_patch tool',
          writer: { kind: 'agent', agentName: 'DorkBot' },
        });
        expect(result.ok).toBe(true);
      });

      expect(configManager.get('ui').theme).toBe('dark');
      expect(lines).toContain('[Config] Patched by the config_patch tool: ui.theme');
    });
  });

  describe('the display-name receipt (DOR-1022)', () => {
    /** What is stored right now, both leaves, off the real ConfigManager. */
    function storedName(): { displayName: string | null; source: unknown } {
      const profile = configManager.get('profile');
      return { displayName: profile.displayName, source: profile.displayNameSource };
    }

    /** One `config_patch` write, as DorkBot makes it. */
    function agentWrites(displayName: string | null, agentName: string | null = 'DorkBot') {
      return applyGuardedConfigWrite({
        patch: { profile: { displayName } },
        authority: OPERATOR_TOOL_AUTHORITY,
        source: 'the config_patch tool',
        writer: { kind: 'agent', agentName },
      });
    }

    /** One `PATCH /api/config` write, as a person makes it. */
    function personWrites(displayName: string | null) {
      return applyGuardedConfigWrite({
        patch: { profile: { displayName } },
        authority: LOCAL_OPERATOR_AUTHORITY,
        source: 'PATCH /api/config',
        writer: { kind: 'operator' },
      });
    }

    it('stamps the agent that set a name, in the SAME write as the name', () => {
      // One write, both leaves: read back off the manager, a new name is never
      // seen carrying the previous writer's stamp.
      expect(agentWrites('Dorian').ok).toBe(true);
      expect(storedName()).toEqual({
        displayName: 'Dorian',
        source: { kind: 'agent', agentName: 'DorkBot' },
      });
    });

    it('stamps the person that saved a name through the config door', () => {
      expect(personWrites('Dorian').ok).toBe(true);
      expect(storedName()).toEqual({ displayName: 'Dorian', source: { kind: 'operator' } });
    });

    it('lets a person’s save clear an agent’s stamp for good, unchanged value and all', () => {
      // The dismissal path, end to end through the real store: DorkBot proposes,
      // the person saves the very same string, and the record flips to theirs.
      expect(agentWrites('Dorian').ok).toBe(true);
      expect(personWrites('Dorian').ok).toBe(true);
      expect(storedName()).toEqual({ displayName: 'Dorian', source: { kind: 'operator' } });
    });

    it('does not re-stamp when an agent re-sends the name the person confirmed', () => {
      expect(personWrites('Dorian').ok).toBe(true);
      expect(agentWrites('Dorian').ok).toBe(true);
      expect(storedName()).toEqual({ displayName: 'Dorian', source: { kind: 'operator' } });
    });

    it('records an agent it could not identify rather than nothing', () => {
      expect(agentWrites('Dorian', null).ok).toBe(true);
      expect(storedName().source).toEqual({ kind: 'agent', agentName: null });
    });

    it('clears the record when the name itself is cleared', () => {
      expect(agentWrites('Dorian').ok).toBe(true);
      expect(agentWrites(null).ok).toBe(true);
      expect(storedName()).toEqual({ displayName: null, source: null });
    });

    it('leaves the record alone for a patch that never names the display name', () => {
      expect(agentWrites('Dorian').ok).toBe(true);
      const result = applyGuardedConfigWrite({
        patch: { profile: { roles: ['Engineer'] } },
        authority: OPERATOR_TOOL_AUTHORITY,
        source: 'the config_patch tool',
        writer: { kind: 'agent', agentName: 'DorkBot' },
      });
      expect(result.ok).toBe(true);
      expect(configManager.get('profile').roles).toEqual(['Engineer']);
      expect(storedName().source).toEqual({ kind: 'agent', agentName: 'DorkBot' });
    });

    it('refuses an agent that tries to sign its own suggestion as the person’s', async () => {
      // The whole hint is worthless if the agent that raised it can clear it.
      // `profile.displayNameSource` is `operator-only`, so the patch is refused
      // WHOLE — the name it was smuggled in beside is not written either.
      const { OPERATOR_ONLY_CONFIG_CODE } = await import('../config-write-policy.js');
      expect(agentWrites('Dorian').ok).toBe(true);

      const result = applyGuardedConfigWrite({
        patch: { profile: { displayName: 'Dorian C', displayNameSource: { kind: 'operator' } } },
        authority: OPERATOR_TOOL_AUTHORITY,
        source: 'the config_patch tool',
        writer: { kind: 'agent', agentName: 'DorkBot' },
      });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.kind).toBe('refused');
      if (result.kind !== 'refused') throw new Error('unreachable');
      expect(result.refusal.code).toBe(OPERATOR_ONLY_CONFIG_CODE);
      expect(result.refusal.paths).toContain('profile.displayNameSource.kind');
      expect(storedName()).toEqual({
        displayName: 'Dorian',
        source: { kind: 'agent', agentName: 'DorkBot' },
      });
    });
  });

  describe('logConfigWrite, for the writers that have their own gate', () => {
    it('names the fully-qualified path and never the value', async () => {
      // `mcp.apiKey` is a secret the schema declares as one. The migration that
      // clears it logs through here, which is only safe because the line carries
      // paths and nothing else.
      const before = configManager.get('mcp');
      configManager.set('mcp', { ...before, apiKey: 'dork_mcp_do-not-log-me' });

      const lines = await infoLines(() => {
        logConfigWrite('the MCP key migration', 'mcp', before, configManager.get('mcp'));
      });

      expect(lines).toContain('[Config] Set by the MCP key migration: mcp.apiKey');
      expect(lines.join('\n')).not.toContain('dork_mcp_do-not-log-me');
    });

    it('says nothing when the writer changed nothing', async () => {
      const unchanged = configManager.get('tunnel');

      const lines = await infoLines(() => {
        logConfigWrite('the tunnel route', 'tunnel', unchanged, configManager.get('tunnel'));
      });

      expect(lines.filter((line) => line.startsWith('[Config] Set by'))).toEqual([]);
    });
  });
});

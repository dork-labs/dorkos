/** Supported account choices stay stable through launch, writes and restart. */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { ConfigManager, configManager, initConfigManager } from '../../../core/config-manager.js';
import { ConfigUpgradeRequiredError } from '../../../core/config/upgrade-floor.js';
import { applyConfigPatch } from '../../../core/operator/config-patch.js';
import {
  describeClaudeCodeAccounts,
  resolveActiveClaudeRoot,
  resolveLaunchAccountRoot as resolveLaunch,
} from '../claude-config-dir.js';

/**
 * The ladder's folder for a launch in no project (where no account rule
 * applies), or the refusal thrown: what this file asserts on.
 */
function resolveLaunchAccountRoot(
  opts: Omit<Parameters<typeof resolveLaunch>[0], 'project'> & {
    project?: Parameters<typeof resolveLaunch>[0]['project'];
  }
): string {
  const launch = resolveLaunch({ project: null, ...opts });
  if (!launch.ok) throw launch.error;
  return launch.root;
}

/** The account the person chose under the current setting. */
const CHOSEN = '/Users/me/.claude2';
/** A second registered account, so "the ladder picked one" is not "there is one". */
const OTHER = '/Users/me/.claude3';
/** What the launching shell exported — where "inherited" lands. */
const SHELL_ACCOUNT = '/staged/claude-from-the-shell';

const dirs: string[] = [];
const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  process.env.CLAUDE_CONFIG_DIR = SHELL_ACCOUNT;
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A supported config with a chosen default and two registered accounts.
 *
 * @returns The config directory and the path of the file inside it.
 */
function seedSupportedRegistry(): { dir: string; configPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-pre-ladder-seam-'));
  dirs.push(dir);
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      ...USER_CONFIG_DEFAULTS,
      runtimes: {
        ...USER_CONFIG_DEFAULTS.runtimes,
        claudeCode: {
          defaultAccount: CHOSEN,
          accounts: [
            { id: 'acme-corp', path: CHOSEN, label: 'Acme Corp' },
            { id: 'personal', path: OTHER, label: 'Personal' },
          ],
        },
      },
      __internal__: { migrations: { version: '0.115.0' } },
    })
  );
  return { dir, configPath };
}

describe('a supported registry through the launch ladder', () => {
  it('still bills the account the operator chose', () => {
    const { dir } = seedSupportedRegistry();
    const manager = new ConfigManager(dir);

    expect(resolveActiveClaudeRoot(manager)).toBe(CHOSEN);
  });

  it('reports that account as CHOSEN, not inherited, on GET /api/config', () => {
    const { dir } = seedSupportedRegistry();
    const manager = new ConfigManager(dir);

    const block = describeClaudeCodeAccounts(manager);

    expect(block.resolvedAccount).toBe(CHOSEN);
    expect(block.inherited).toBe(false);
  });

  it('gives every registered account a referenceable id on the wire', () => {
    const { dir } = seedSupportedRegistry();
    const manager = new ConfigManager(dir);

    expect(describeClaudeCodeAccounts(manager).accounts.map((a) => a.id)).toEqual([
      'acme-corp',
      'personal',
    ]);
  });

  it('resolves a launch hint against those ids', () => {
    const { dir } = seedSupportedRegistry();
    const manager = new ConfigManager(dir);

    expect(resolveLaunchAccountRoot({ hintId: 'personal', config: manager })).toBe(OTHER);
  });

  it("resolves an agent's account against those ids", () => {
    const { dir } = seedSupportedRegistry();
    const manager = new ConfigManager(dir);

    expect(resolveLaunchAccountRoot({ agentAccountId: 'personal', config: manager })).toBe(OTHER);
  });

  it('still falls through an id that names nothing, to the chosen default', () => {
    const { dir } = seedSupportedRegistry();
    const manager = new ConfigManager(dir);

    expect(resolveLaunchAccountRoot({ hintId: 'no-such-account', config: manager })).toBe(CHOSEN);
  });
});

describe('changing the chosen default account', () => {
  /** What the app sends when somebody picks "Default" in the account field. */
  const CLEAR = { runtimes: { claudeCode: { defaultAccount: null } } };

  it('actually clears — the old spelling does not vote on this write', () => {
    const { dir } = seedSupportedRegistry();
    initConfigManager(dir);

    expect(applyConfigPatch(CLEAR).ok).toBe(true);

    const block = describeClaudeCodeAccounts(configManager);
    expect(block.inherited).toBe(true);
    expect(block.resolvedAccount).toBe(SHELL_ACCOUNT);
  });

  it('leaves no legacy key behind to resurrect it later', () => {
    const { dir, configPath } = seedSupportedRegistry();
    initConfigManager(dir);
    applyConfigPatch(CLEAR);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      runtimes: { claudeCode: Record<string, unknown> };
    };
    expect(onDisk.runtimes.claudeCode).not.toHaveProperty('activeAccount');
    expect(onDisk.runtimes.claudeCode.defaultAccount).toBeNull();
  });

  it('stays cleared when the config is read fresh', () => {
    const { dir } = seedSupportedRegistry();
    initConfigManager(dir);
    applyConfigPatch(CLEAR);

    expect(resolveActiveClaudeRoot(new ConfigManager(dir))).toBe(SHELL_ACCOUNT);
  });

  it('sets a NEW account explicitly, and drops the old spelling with it', () => {
    const { dir, configPath } = seedSupportedRegistry();
    initConfigManager(dir);

    expect(applyConfigPatch({ runtimes: { claudeCode: { defaultAccount: OTHER } } }).ok).toBe(true);

    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
      runtimes: { claudeCode: Record<string, unknown> };
    };
    expect(onDisk.runtimes.claudeCode.defaultAccount).toBe(OTHER);
    expect(onDisk.runtimes.claudeCode).not.toHaveProperty('activeAccount');
  });

  it('does NOT clear anything when the patch never names the account', () => {
    const { dir } = seedSupportedRegistry();
    initConfigManager(dir);

    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);

    expect(describeClaudeCodeAccounts(configManager).resolvedAccount).toBe(CHOSEN);
  });
});

describe('account choices across writes and refused old encodings', () => {
  it('keeps the choice through an unrelated settings write and another boot', () => {
    const { dir, configPath } = seedSupportedRegistry();
    initConfigManager(dir);
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);

    const manager = new ConfigManager(dir);
    expect(resolveActiveClaudeRoot(manager)).toBe(CHOSEN);
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(stored.runtimes.claudeCode.defaultAccount).toBe(CHOSEN);
  });

  it('refuses an old alias beside a cleared current default', () => {
    const { dir, configPath } = seedSupportedRegistry();
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    stored.runtimes.claudeCode.activeAccount = CHOSEN;
    stored.runtimes.claudeCode.defaultAccount = null;
    fs.writeFileSync(configPath, JSON.stringify(stored));
    const before = fs.readFileSync(configPath);
    expect(() => new ConfigManager(dir)).toThrow(ConfigUpgradeRequiredError);
    expect(fs.readFileSync(configPath)).toEqual(before);
  });

  it('refuses an old alias even beside a chosen current default', () => {
    const { dir, configPath } = seedSupportedRegistry();
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    stored.runtimes.claudeCode.activeAccount = OTHER;
    stored.runtimes.claudeCode.defaultAccount = CHOSEN;
    fs.writeFileSync(configPath, JSON.stringify(stored));
    const before = fs.readFileSync(configPath);
    expect(() => new ConfigManager(dir)).toThrow(ConfigUpgradeRequiredError);
    expect(fs.readFileSync(configPath)).toEqual(before);
  });
});

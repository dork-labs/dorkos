/**
 * What a config written BEFORE the account ladder does on an install the
 * `'0.65.0'` migration has not reached (spec `billing-account-ladder`).
 *
 * The migration is skipped far more often than it sounds — a dev tree resolves
 * `SERVER_VERSION` to `0.0.0` and runs none at all, and a release cut at
 * `0.63.0` or `0.64.0` would skip it for everyone on it. So every guarantee this
 * feature makes has to hold WITHOUT it, and this file asks that question at the
 * real seams rather than at a schema: the `GET /api/config` block, the launch
 * ladder, and the migration that eventually runs.
 *
 * Two failures were found here by review, and both were silent — the reason
 * this file drives real objects end to end instead of parsing a fixture:
 *
 * - The rename was healed nowhere the LAUNCH path could see. `describe…` and
 *   the ladder read the stored object through `readClaudeCodeConfig`, never
 *   through Zod, so a person's chosen account read as "inherited" and new work
 *   billed whatever the environment pointed at.
 * - Worse, one unrelated settings write then persisted `defaultAccount: null`
 *   beside the old key, and the migration preferred the new one — so the choice
 *   was destroyed permanently, by a theme change.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import {
  ConfigManager,
  initConfigManager,
  migrateClaudeAccountRegistry,
} from '../../../core/config-manager.js';
import { applyConfigPatch } from '../../../core/operator/config-patch.js';
import {
  describeClaudeCodeAccounts,
  resolveActiveClaudeRoot,
  resolveLaunchAccountRoot,
} from '../claude-config-dir.js';

/** The account the operator chose, back when the key was called `activeAccount`. */
const CHOSEN = '/Users/me/.claude2';
/** A second registered account, so "the ladder picked one" is not "there is one". */
const OTHER = '/Users/me/.claude3';

const dirs: string[] = [];
const ORIGINAL_ENV = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  // A launching shell pointing somewhere else entirely, so "inherited the env"
  // and "honored the stored choice" cannot be confused for one another.
  process.env.CLAUDE_CONFIG_DIR = '/staged/claude-from-the-shell';
});

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_ENV;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A config file in the pre-ladder shape: the old key name, and accounts with no
 * ids because ids did not exist yet.
 *
 * @returns The config directory and the path of the file inside it.
 */
function seedPreLadder(): { dir: string; configPath: string } {
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
          activeAccount: CHOSEN,
          accounts: [
            { path: CHOSEN, label: 'Acme Corp' },
            { path: OTHER, label: 'Personal' },
          ],
        },
      },
      __internal__: { migrations: { version: '0.64.0' } },
    })
  );
  return { dir, configPath };
}

describe('a pre-ladder config, on an install the migration has not reached', () => {
  it('still bills the account the operator chose', () => {
    // The whole point of the setting. Reading `defaultAccount` alone finds
    // `null` here and hands back the shell's account — a different paying
    // client's subscription, silently.
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);

    expect(resolveActiveClaudeRoot(manager)).toBe(CHOSEN);
  });

  it('reports that account as CHOSEN, not inherited, on GET /api/config', () => {
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);

    const block = describeClaudeCodeAccounts(manager);

    expect(block.resolvedAccount).toBe(CHOSEN);
    // `inherited: true` is what puts the cockpit's account field in the state
    // that says "nothing chosen" over a choice that was made.
    expect(block.inherited).toBe(false);
  });

  it('gives every registered account a referenceable id on the wire', () => {
    // `id: null` means "nothing can point at this row". Every row answering that
    // is a registry no agent and no session hint can name — the ladder's top two
    // rungs inert on every un-migrated install.
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);

    expect(describeClaudeCodeAccounts(manager).accounts.map((a) => a.id)).toEqual([
      'acme-corp',
      'personal',
    ]);
  });

  it('resolves a launch hint against those ids', () => {
    // The substance behind the row above: a hint is matched by id, so ids that
    // exist only after a migration make the top rung unreachable.
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);

    expect(resolveLaunchAccountRoot({ hintId: 'personal', config: manager })).toBe(OTHER);
  });

  it("resolves an agent's account against those ids", () => {
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);

    expect(resolveLaunchAccountRoot({ agentAccountId: 'personal', config: manager })).toBe(OTHER);
  });

  it('still falls through an id that names nothing, to the chosen default', () => {
    // Invariant 3 has to survive the healing too: healed ids are real ids, and a
    // reference that matches none of them still falls to the next rung.
    const { dir } = seedPreLadder();
    const manager = new ConfigManager(dir);

    expect(resolveLaunchAccountRoot({ hintId: 'no-such-account', config: manager })).toBe(CHOSEN);
  });
});

describe('the two-step that used to destroy a billing choice', () => {
  it('keeps the choice through an unrelated settings write and the migration', () => {
    // Step 1: somebody changes the theme. `applyConfigPatch` re-parses and
    // persists the whole config, which is how `defaultAccount` lands on disk
    // beside the old key.
    const { dir, configPath } = seedPreLadder();
    initConfigManager(dir);
    expect(applyConfigPatch({ ui: { theme: 'light' } }).ok).toBe(true);

    // Step 2: the release carrying `'0.65.0'` finally arrives and the migration
    // runs over that file. It must not prefer a `null` the theme change wrote
    // over the value the person actually chose.
    const stored = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
    const store = {
      get: (key: string) => stored[key],
      set: (key: string, value: unknown) => {
        stored[key] = value;
      },
    };
    migrateClaudeAccountRegistry(store);

    const claudeCode = (stored.runtimes as { claudeCode: Record<string, unknown> }).claudeCode;
    expect(claudeCode.defaultAccount).toBe(CHOSEN);
    expect(claudeCode).not.toHaveProperty('activeAccount');
  });

  it('carries the old value even when nothing has healed the file first', () => {
    // The migration's own half, in isolation: a file where a pre-fix build
    // already wrote `defaultAccount: null` beside the old key. `null` is the
    // absence of a choice, so the old key still speaks for the person.
    const stored: Record<string, unknown> = {
      runtimes: {
        claudeCode: { activeAccount: CHOSEN, defaultAccount: null, accounts: [] },
      },
    };
    const store = {
      get: (key: string) => stored[key],
      set: (key: string, value: unknown) => {
        stored[key] = value;
      },
    };

    migrateClaudeAccountRegistry(store);

    expect((stored.runtimes as { claudeCode: Record<string, unknown> }).claudeCode).toEqual({
      defaultAccount: CHOSEN,
      accounts: [],
    });
  });

  it('leaves a real new-key choice alone when both keys carry a value', () => {
    // Not a free-for-all: `defaultAccount` holding an actual path is a decision
    // made under the new name and outranks the stale one.
    const stored: Record<string, unknown> = {
      runtimes: {
        claudeCode: { activeAccount: OTHER, defaultAccount: CHOSEN, accounts: [] },
      },
    };
    const store = {
      get: (key: string) => stored[key],
      set: (key: string, value: unknown) => {
        stored[key] = value;
      },
    };

    migrateClaudeAccountRegistry(store);

    expect(
      (stored.runtimes as { claudeCode: Record<string, unknown> }).claudeCode.defaultAccount
    ).toBe(CHOSEN);
  });
});

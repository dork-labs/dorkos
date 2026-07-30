/**
 * A Claude account change applies LIVE (spec `claude-code-accounts` D5).
 *
 * The trigger sits on `applyConfigPatch` rather than on `PATCH /api/config`,
 * because that is the seam BOTH writers share: the HTTP route and the
 * `config_patch` operator MCP tool. Wiring the route alone would mean an account
 * switched through the tool took effect only after a restart.
 *
 * What is asserted is the trigger, not the effect — the effect has its own tests
 * in `runtimes/claude-code/__tests__/account-switch.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyConfigPatch } from '../config-patch.js';
import { applyClaudeAccountChange } from '../../../runtimes/claude-code/account-switch.js';
import { configManager } from '../../config-manager.js';

vi.mock('../../../runtimes/claude-code/account-switch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../runtimes/claude-code/account-switch.js')>()),
  applyClaudeAccountChange: vi.fn().mockResolvedValue(undefined),
}));

/** The whole config, so `deepMerge` and the schema see a real shape. */
const stored: Record<string, unknown> = {};

vi.mock('../../config-manager.js', () => ({
  configManager: {
    getAll: vi.fn(() => structuredClone(stored)),
    get: vi.fn((key: string) => structuredClone(stored)[key]),
    set: vi.fn((key: string, value: unknown) => {
      stored[key] = value;
    }),
  },
}));

describe('applyConfigPatch — Claude account live-apply trigger', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(stored)) delete stored[key];
    Object.assign(stored, {
      version: 1,
      runtimes: { claudeCode: { activeAccount: null, accounts: [] } },
      ui: { theme: 'dark' },
    });
  });

  it('applies live when the active account changes', () => {
    const result = applyConfigPatch({
      runtimes: { claudeCode: { activeAccount: '/Users/dev/.claude2' } },
    });

    expect(result.ok).toBe(true);
    expect(applyClaudeAccountChange).toHaveBeenCalledTimes(1);
  });

  it('applies live when the account roster changes', () => {
    applyConfigPatch({
      runtimes: {
        claudeCode: { accounts: [{ path: '/Users/dev/.claude2', label: 'Acme' }] },
      },
    });

    expect(applyClaudeAccountChange).toHaveBeenCalledTimes(1);
  });

  it('does NOT apply for a patch that leaves the accounts alone', () => {
    // Restarting every session watcher because somebody changed the theme would
    // drop and rebuild the whole session list for no reason.
    applyConfigPatch({ ui: { theme: 'light' } });

    expect(applyClaudeAccountChange).not.toHaveBeenCalled();
  });

  it('does NOT apply when the write leaves the accounts at the same values', () => {
    // The cockpit saving an unchanged form, or a patch that touches a sibling
    // runtime. Same values must be a no-op, or every save costs a full rebuild.
    applyConfigPatch({
      runtimes: { claudeCode: { activeAccount: null, accounts: [] }, codex: { enabled: true } },
    });

    expect(applyClaudeAccountChange).not.toHaveBeenCalled();
  });

  it('does NOT apply when the write was REJECTED', () => {
    const result = applyConfigPatch({ runtimes: { claudeCode: { activeAccount: 42 } } });

    expect(result.ok).toBe(false);
    expect(applyClaudeAccountChange).not.toHaveBeenCalled();
    // And nothing was persisted, so there is genuinely nothing to apply.
    expect(vi.mocked(configManager.set)).not.toHaveBeenCalled();
  });
});

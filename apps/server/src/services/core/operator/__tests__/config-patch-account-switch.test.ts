/**
 * A Claude account change applies LIVE (spec `claude-code-accounts` D5) — and
 * ONLY in a process that has something to re-derive (DOR-1247).
 *
 * The trigger sits on `applyConfigPatch` rather than on `PATCH /api/config`,
 * because that is the seam every writer shares: the HTTP route, the
 * `config_patch` operator MCP tool, and `dorkos config set`. Wiring the route
 * alone would mean an account switched through either of the others took effect
 * only after a restart.
 *
 * The applier is BOOT-WIRED rather than imported, because that shared seam is
 * reached from the CLI too, where re-deriving is meaningless: an empty registry,
 * no connected clients, and a success line in the operator's log for an apply
 * that did not happen. So these tests cover both halves — wired fires, unwired
 * says the true thing instead.
 *
 * What is asserted is the trigger, not the effect — the effect has its own tests
 * in `runtimes/claude-code/__tests__/account-switch.test.ts`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  applyConfigPatch,
  initClaudeAccountApplier,
  resetClaudeAccountApplier,
} from '../config-patch.js';
import { configManager } from '../../config-manager.js';
import { logger } from '../../../../lib/logger.js';

/** Stands in for the server's own re-derivation, which boot wires in. */
const applyClaudeAccountChange = vi.fn();

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
    initClaudeAccountApplier(applyClaudeAccountChange);
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

  describe('with no applier wired — `dorkos config set`, not a server', () => {
    beforeEach(() => {
      resetClaudeAccountApplier();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('claims no apply, and says what is actually true about a running DorkOS', () => {
      // Reproduced against the built CLI before the seam existed: the write
      // logged "[claude-accounts] applied an account change without a restart"
      // into the operator's own log while the running server's caches stayed
      // stale — a false success line, in the one place they would go looking.
      const lines: string[] = [];
      vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });

      const result = applyConfigPatch({
        runtimes: { claudeCode: { activeAccount: '/Users/dev/.claude2' } },
      });

      expect(result.ok).toBe(true);
      expect(applyClaudeAccountChange).not.toHaveBeenCalled();
      expect(lines).toContain(
        '[Config] The Claude account changed. Any running DorkOS keeps the account it started with until it restarts.'
      );
    });

    it('says nothing at all when the accounts did not move', () => {
      const lines: string[] = [];
      vi.spyOn(logger, 'info').mockImplementation((...args: unknown[]) => {
        lines.push(String(args[0]));
      });

      applyConfigPatch({ ui: { theme: 'light' } });

      expect(lines.filter((line) => line.includes('Claude account'))).toEqual([]);
    });
  });
});

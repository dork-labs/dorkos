/**
 * What actually happens when the Claude accounts move (spec D5).
 *
 * Three effects, each guarding a distinct stale answer:
 * the reader's caches (a session's account, and metadata cached under the old
 * account set), the watchers (which projects roots they watch), and the
 * connected cockpits (which sessions they are holding).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { applyClaudeAccountChange, claudeAccountsChanged } from '../account-switch.js';
import { eventFanOut } from '../../../core/event-fan-out.js';
import { runtimeRegistry } from '../../../core/runtime-registry.js';
import { sessionListBroadcaster } from '../../../session/session-list-broadcaster.js';

const { _invalidateAll, _registeredRuntimes } = vi.hoisted(() => {
  const invalidateAll = vi.fn();
  return {
    _invalidateAll: invalidateAll,
    _registeredRuntimes: [
      { type: 'claude-code', getTranscriptReader: () => ({ invalidateAll }) },
      { type: 'codex' },
    ],
  };
});

vi.mock('../../../core/event-fan-out.js', () => ({
  eventFanOut: { broadcast: vi.fn(), addClient: vi.fn(), clientCount: 0 },
}));
vi.mock('../../../session/session-list-broadcaster.js', () => ({
  sessionListBroadcaster: { stop: vi.fn().mockResolvedValue(undefined), start: vi.fn() },
}));
vi.mock('../../../core/runtime-registry.js', () => ({
  runtimeRegistry: { listRuntimes: vi.fn() },
}));
vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('claudeAccountsChanged', () => {
  it('sees a new active account', () => {
    expect(
      claudeAccountsChanged(
        { claudeCode: { defaultAccount: null, accounts: [] } },
        { claudeCode: { defaultAccount: '/Users/dev/.claude2', accounts: [] } }
      )
    ).toBe(true);
  });

  it('sees a new roster entry', () => {
    expect(
      claudeAccountsChanged(
        { claudeCode: { defaultAccount: null, accounts: [] } },
        {
          claudeCode: {
            defaultAccount: null,
            accounts: [{ id: 'acct-4', path: '/Users/dev/.claude2', label: null }],
          },
        }
      )
    ).toBe(true);
  });

  it('sees a REMOVED roster entry', () => {
    expect(
      claudeAccountsChanged(
        {
          claudeCode: {
            defaultAccount: null,
            accounts: [{ id: 'acct-5', path: '/Users/dev/.claude2', label: null }],
          },
        },
        { claudeCode: { defaultAccount: null, accounts: [] } }
      )
    ).toBe(true);
  });

  it('ignores an identical section handed back as a fresh object', () => {
    // The config manager returns a new object on every read, so identity
    // comparison would fire on every single config write.
    expect(
      claudeAccountsChanged(
        {
          claudeCode: {
            defaultAccount: '/Users/dev/.claude2',
            accounts: [{ id: 'acme', path: '/Users/dev/.claude2', label: 'Acme' }],
          },
        },
        {
          claudeCode: {
            defaultAccount: '/Users/dev/.claude2',
            accounts: [{ id: 'acme', path: '/Users/dev/.claude2', label: 'Acme' }],
          },
        }
      )
    ).toBe(false);
  });

  it('ignores a change to a SIBLING runtime', () => {
    expect(
      claudeAccountsChanged(
        { claudeCode: { defaultAccount: null, accounts: [] }, codex: { enabled: true } },
        { claudeCode: { defaultAccount: null, accounts: [] }, codex: { enabled: false } }
      )
    ).toBe(false);
  });

  it('treats an absent section as its defaults, so a first write is not a change', () => {
    // The pre-migration read window: `runtimes.claudeCode` may be missing
    // entirely, and the section defaults are `null` + `[]`.
    expect(
      claudeAccountsChanged(undefined, { claudeCode: { defaultAccount: null, accounts: [] } })
    ).toBe(false);
  });
});

describe('applyClaudeAccountChange', () => {
  beforeEach(() => {
    // Implementations, not just call history: `clearAllMocks` leaves a previous
    // case's `mockRejectedValue` in place, which would silently make later cases
    // assert against a broken broadcaster.
    vi.clearAllMocks();
    vi.mocked(sessionListBroadcaster.stop).mockResolvedValue(undefined);
    vi.mocked(sessionListBroadcaster.start).mockImplementation(() => undefined);
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue(
      _registeredRuntimes as unknown as ReturnType<typeof runtimeRegistry.listRuntimes>
    );
  });

  it('drops the account-derived caches, restarts discovery, and tells clients', async () => {
    await applyClaudeAccountChange();

    expect(_invalidateAll).toHaveBeenCalledTimes(1);
    expect(sessionListBroadcaster.stop).toHaveBeenCalledTimes(1);
    expect(sessionListBroadcaster.start).toHaveBeenCalledTimes(1);
    expect(eventFanOut.broadcast).toHaveBeenCalledWith('session_list_invalidated', {
      changedAt: expect.any(String),
    });
  });

  it('stops the watchers BEFORE starting them again', async () => {
    // `start()` is a no-op while the broadcaster is still running, so a restart
    // in the wrong order silently leaves every watcher on the old roots.
    const order: string[] = [];
    vi.mocked(sessionListBroadcaster.stop).mockImplementation(async () => {
      order.push('stop');
    });
    vi.mocked(sessionListBroadcaster.start).mockImplementation(() => {
      order.push('start');
    });

    await applyClaudeAccountChange();

    expect(order).toEqual(['stop', 'start']);
  });

  it('restarts with EVERY runtime and the persisted-settings store', async () => {
    // Matching the composition root: without the settings store, each upsert
    // overwrites the operator's stored permission mode in the client's cache.
    await applyClaudeAccountChange();

    const [runtimes, settings] = vi.mocked(sessionListBroadcaster.start).mock.calls[0]!;
    expect(runtimes.map((runtime) => runtime.type)).toEqual(['claude-code', 'codex']);
    expect(settings).toBe(runtimeRegistry);
  });

  it('still broadcasts when the watcher restart fails', async () => {
    // The client invalidation is the step that cannot be skipped: without it a
    // cockpit shows the union of the old and new account sets until a reload.
    vi.mocked(sessionListBroadcaster.stop).mockRejectedValue(new Error('watcher wedged'));

    await expect(applyClaudeAccountChange()).resolves.toBeUndefined();

    expect(eventFanOut.broadcast).toHaveBeenCalledWith(
      'session_list_invalidated',
      expect.anything()
    );
  });

  it('survives a server with no Claude runtime registered', async () => {
    vi.mocked(runtimeRegistry.listRuntimes).mockReturnValue([]);

    await expect(applyClaudeAccountChange()).resolves.toBeUndefined();

    expect(_invalidateAll).not.toHaveBeenCalled();
    expect(sessionListBroadcaster.start).toHaveBeenCalledTimes(1);
  });
});

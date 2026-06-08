import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from '../sessions/session-store.js';
import type { Query } from '@anthropic-ai/claude-agent-sdk';

/** Build a minimal mock Query with controllable setPermissionMode behavior. */
function mockQuery(overrides?: Partial<Pick<Query, 'setPermissionMode'>>): Query {
  return {
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as Query;
}

describe('SessionStore.updateSession', () => {
  let store: SessionStore;

  beforeEach(() => {
    store = new SessionStore();
  });

  it('updates permissionMode when no activeQuery exists', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const result = await store.updateSession('s1', { permissionMode: 'plan' });
    expect(result).toBe(true);
    expect(store.findSession('s1')!.permissionMode).toBe('plan');
  });

  it('calls setPermissionMode on activeQuery when present', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const query = mockQuery();
    store.findSession('s1')!.activeQuery = query;

    await store.updateSession('s1', { permissionMode: 'acceptEdits' });

    expect(query.setPermissionMode).toHaveBeenCalledWith('acceptEdits');
    expect(store.findSession('s1')!.permissionMode).toBe('acceptEdits');
  });

  it('keeps the new permissionMode when setPermissionMode rejects (best-effort, ADR-0261)', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const query = mockQuery({
      setPermissionMode: vi.fn().mockRejectedValue(new Error('SDK rejected mode change')),
    });
    store.findSession('s1')!.activeQuery = query;

    // Live failure is swallowed — no throw, no revert.
    const result = await store.updateSession('s1', { permissionMode: 'bypassPermissions' });
    expect(result).toBe(true);
    // New mode is kept (already persisted via write-through; applies next turn).
    expect(store.findSession('s1')!.permissionMode).toBe('bypassPermissions');
  });

  it('does not propagate the error from setPermissionMode (best-effort, ADR-0261)', async () => {
    store.ensureSession('s1', { permissionMode: 'plan' });
    const query = mockQuery({
      setPermissionMode: vi.fn().mockRejectedValue(new Error('connection lost')),
    });
    store.findSession('s1')!.activeQuery = query;

    await expect(store.updateSession('s1', { permissionMode: 'auto' })).resolves.toBe(true);
    expect(store.findSession('s1')!.permissionMode).toBe('auto');
  });

  it('still applies non-permission fields after successful mode change', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const query = mockQuery();
    store.findSession('s1')!.activeQuery = query;

    await store.updateSession('s1', {
      permissionMode: 'plan',
      model: 'claude-sonnet-4',
      effort: 'high',
    });

    const session = store.findSession('s1')!;
    expect(session.permissionMode).toBe('plan');
    expect(session.model).toBe('claude-sonnet-4');
    expect(session.effort).toBe('high');
  });

  it('still applies non-permission fields when setPermissionMode rejects (best-effort, ADR-0261)', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const query = mockQuery({
      setPermissionMode: vi.fn().mockRejectedValue(new Error('fail')),
    });
    store.findSession('s1')!.activeQuery = query;

    const result = await store.updateSession('s1', {
      permissionMode: 'bypassPermissions',
      model: 'claude-sonnet-4',
    });
    expect(result).toBe(true);

    const session = store.findSession('s1')!;
    // New mode kept and non-permission fields still applied — no early throw.
    expect(session.permissionMode).toBe('bypassPermissions');
    expect(session.model).toBe('claude-sonnet-4');
  });

  it('auto-creates session for unknown sessionId', async () => {
    const result = await store.updateSession('new-s', { permissionMode: 'plan' });
    expect(result).toBe(true);
    expect(store.hasSession('new-s')).toBe(true);
    expect(store.findSession('new-s')!.permissionMode).toBe('plan');
  });
});

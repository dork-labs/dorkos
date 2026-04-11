import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionStore } from '../session-store.js';
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

  it('reverts permissionMode when setPermissionMode rejects', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const sdkError = new Error('SDK rejected mode change');
    const query = mockQuery({
      setPermissionMode: vi.fn().mockRejectedValue(sdkError),
    });
    store.findSession('s1')!.activeQuery = query;

    await expect(
      store.updateSession('s1', { permissionMode: 'bypassPermissions' })
    ).rejects.toThrow('SDK rejected mode change');

    // Permission mode reverted to original value
    expect(store.findSession('s1')!.permissionMode).toBe('default');
  });

  it('propagates the error from setPermissionMode', async () => {
    store.ensureSession('s1', { permissionMode: 'plan' });
    const sdkError = new Error('connection lost');
    const query = mockQuery({
      setPermissionMode: vi.fn().mockRejectedValue(sdkError),
    });
    store.findSession('s1')!.activeQuery = query;

    await expect(store.updateSession('s1', { permissionMode: 'auto' })).rejects.toBe(sdkError);
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

  it('does not apply non-permission fields when setPermissionMode rejects', async () => {
    store.ensureSession('s1', { permissionMode: 'default' });
    const query = mockQuery({
      setPermissionMode: vi.fn().mockRejectedValue(new Error('fail')),
    });
    store.findSession('s1')!.activeQuery = query;

    await expect(
      store.updateSession('s1', {
        permissionMode: 'bypassPermissions',
        model: 'claude-sonnet-4',
      })
    ).rejects.toThrow();

    const session = store.findSession('s1')!;
    // permissionMode reverted
    expect(session.permissionMode).toBe('default');
    // model was not applied because the error was thrown before reaching it
    expect(session.model).toBeUndefined();
  });

  it('auto-creates session for unknown sessionId', async () => {
    const result = await store.updateSession('new-s', { permissionMode: 'plan' });
    expect(result).toBe(true);
    expect(store.hasSession('new-s')).toBe(true);
    expect(store.findSession('new-s')!.permissionMode).toBe('plan');
  });
});

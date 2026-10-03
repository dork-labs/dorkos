/**
 * When DorkOS credits run another model than a session names, that model
 * becomes the session's own (DOR-2636), in memory and in the stored settings,
 * so the status line, the picker and the next turn show what really ran.
 */
import { describe, it, expect, vi } from 'vitest';
import { SessionStore } from '../session-store.js';

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ forkSession: vi.fn() }));
vi.mock('../../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('SessionStore.rememberModel', () => {
  it('makes the model the session’s own, in memory and in the stored settings', async () => {
    const store = new SessionStore();
    const saveSessionSettings = vi.fn(async () => {});
    store.configureSettings(
      {
        saveSessionSettings,
        getSessionSettings: vi.fn(async () => null),
        rekeySessionSettings: vi.fn(async () => {}),
      } as never,
      'default'
    );
    store.ensureSession('s1', { permissionMode: 'default', model: 'opus' });
    const session = store.findSession('s1')!;

    await store.rememberModel(session, 's1', 'md_suggested');

    expect(session.model).toBe('md_suggested');
    expect(saveSessionSettings).toHaveBeenCalledWith('s1', { model: 'md_suggested' });
  });

  it('still runs the model when the settings cannot be stored', async () => {
    const store = new SessionStore();
    store.configureSettings(
      {
        saveSessionSettings: vi.fn(async () => {
          throw new Error('locked');
        }),
      } as never,
      'default'
    );
    store.ensureSession('s1', { permissionMode: 'default' });
    const session = store.findSession('s1')!;

    await expect(store.rememberModel(session, 's1', 'md_suggested')).resolves.toBeUndefined();
    expect(session.model).toBe('md_suggested');
  });
});

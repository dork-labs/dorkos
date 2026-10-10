import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DoeSessionStore } from '../session-store.js';

it('persists metadata, immutable inference and full model records across restart', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-store-'));
  let store = new DoeSessionStore(directory);
  try {
    const record = store.ensure('test', { cwd: '/projects/alpha', model: 'local' });
    record.inference = { source: 'local', model: 'local' };
    store.save(record);
    store.update('test', { permissionMode: 'default' });
    store.setInference('test', { source: 'local', model: 'local', contextWindow: 8192 });
    record.inference = store.get('test')!.inference;
    expect(store.get('test')?.session.permissionMode).toBe('default');
    store.models.appendMessage('test', {
      role: 'assistant',
      content: 'Saved',
      reasoning: { signature: 'opaque' },
    });
    store.close();
    store = new DoeSessionStore(directory);
    expect(store.get('test')?.inference).toEqual(record.inference);
    expect(store.models.archive('test')[0]?.payload.reasoning).toEqual({ signature: 'opaque' });
    expect(store.ensure('test', { cwd: '/projects/beta', model: 'other' }).session.cwd).toBe(
      '/projects/alpha'
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('scopes project membership by path boundary and never invents unknown PATCH sessions', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-store-'));
  const store = new DoeSessionStore(directory);
  try {
    store.ensure('a', { cwd: '/projects/app/nested' });
    store.ensure('b', { cwd: '/projects/application' });
    expect(store.list('/projects/app').map((s) => s.id)).toEqual(['a']);
    expect(store.belongs('b', '/projects/app')).toBe(false);
    expect(store.update('unknown', { model: 'x' })).toBe(false);
    expect(store.get('unknown')).toBeNull();
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
it('closes parked inventory subscriptions without a process watcher', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-store-'));
  const store = new DoeSessionStore(directory);
  try {
    const subscription = store.subscribe();
    const pending = subscription.next();
    await subscription.return!();
    expect(await pending).toEqual({ done: true, value: undefined });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

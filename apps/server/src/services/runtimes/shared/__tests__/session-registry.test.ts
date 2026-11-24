import type { Session } from '@dorkos/shared/types';
import { expect, it } from 'vitest';
import { sessionMessagePreview, TrackedSessionRegistry } from '../session/session-registry.js';

const project = '/projects/tracked-registry';
const timestamp = '2026-01-01T00:00:00.000Z';

function row(id: string, patch: Partial<Session> = {}): Session {
  return {
    id,
    title: '',
    createdAt: timestamp,
    updatedAt: timestamp,
    permissionMode: 'default',
    runtime: 'example-runtime',
    ...patch,
  };
}

it('keeps settings patches distinct from first-message and title updates', async () => {
  const registry = new TrackedSessionRegistry({
    runtime: 'example-runtime',
    defaultPermissionMode: 'custom-default',
  });
  registry.register('draft');
  expect(registry.get('draft')).toMatchObject({
    runtime: 'example-runtime',
    permissionMode: 'custom-default',
  });
  const session = row('message', { cwd: project, model: 'stored', dorkosTools: 'back' });
  registry.set(session);
  session.model = 'later caller edit';
  registry.register('message', { model: undefined, fastMode: false });
  const stream = registry.subscribe();
  const display = registry.get('message')!;
  expect(display).toMatchObject({ model: 'stored', fastMode: false, updatedAt: timestamp });
  display.model = 'later reader edit';
  registry.recordMessage(
    'message',
    'First message\nSecond line',
    { title: 'Explicit title' },
    (next) => {
      if (next.dorkosTools === 'back') next.dorkosTools = null;
    }
  );
  registry.recordMessage('message', 'Follow-up', { title: 'Ignored later title' });
  expect(await stream.next()).toMatchObject({
    value: { type: 'session_upserted', session: { title: '', dorkosTools: 'back' } },
  });
  expect(await stream.next()).toMatchObject({
    value: {
      type: 'session_upserted',
      session: { title: 'Explicit title', lastMessagePreview: 'First message', dorkosTools: null },
    },
  });
  expect(await stream.next()).toMatchObject({
    value: {
      type: 'session_upserted',
      session: { title: 'Explicit title', lastMessagePreview: 'Follow-up' },
    },
  });
  expect(registry.get('message')).toMatchObject({ model: 'stored', createdAt: timestamp });
  expect(registry.get('message')?.updatedAt).not.toBe(timestamp);
  await stream.return?.();
});

it('retains the runtime title label and codepoint-safe preview conventions', () => {
  const registry = new TrackedSessionRegistry({
    runtime: 'replay-fixture',
    defaultPermissionMode: 'custom-default',
    labelTitle: (title) => title || 'Recorded title',
  });
  registry.recordMessage('recorded', 'Different first message');
  expect(registry.get('recorded')?.title).toBe('Recorded title');
  registry.rename('recorded', 'Explicit rename');
  expect(registry.get('recorded')?.title).toBe('Explicit rename');

  const preview = '🙂'.repeat(80);
  const content = `${preview}x\nOther line`;
  expect(sessionMessagePreview(content)).toBe(`${preview}…`);
  expect(sessionMessagePreview(content, '')).toBe(preview);
});

it('rekeys in memory order with one canonical upsert and no removal', async () => {
  const registry = new TrackedSessionRegistry({
    runtime: 'example-runtime',
    defaultPermissionMode: 'default',
  });
  registry.set(row('old', { cwd: `${project}/child`, title: 'Tracked' }));
  registry.set(row('sibling', { cwd: `${project}-unrelated` }));
  registry.set(row('draft'));
  expect(registry.list(project).map((value) => value.id)).toEqual(['old']);

  const stream = registry.subscribe();
  expect(await stream.next()).toMatchObject({ value: { session: { id: 'old' } } });
  expect(await stream.next()).toMatchObject({ value: { session: { id: 'sibling' } } });
  registry.rekey('old', 'canonical');
  expect(await stream.next()).toMatchObject({
    value: {
      type: 'session_upserted',
      session: { id: 'canonical', title: 'Tracked', createdAt: timestamp },
    },
  });
  expect(registry.has('old')).toBe(false);
  expect(registry.ids()).toEqual(['sibling', 'draft', 'canonical']);
  registry.reset();
  for (const sessionId of ['sibling', 'draft', 'canonical'])
    expect(await stream.next()).toEqual({
      value: { type: 'session_removed', sessionId },
      done: false,
    });
  registry.register('future', { cwd: project });
  expect(await stream.next()).toMatchObject({ value: { session: { id: 'future' } } });
  const parked = stream.next();
  await stream.return?.();
  expect(await parked).toEqual({ value: undefined, done: true });
});

it('reads an external source in its order and publishes only explicitly saved snapshots', async () => {
  const records = new Map([
    ['second', row('second', { cwd: project })],
    ['first', row('first', { cwd: project, title: 'First' })],
    ['draft', row('draft')],
  ]);
  const registry = new TrackedSessionRegistry({
    runtime: 'durable-fixture',
    defaultPermissionMode: 'default',
    source: records,
    display: (session) => ({ ...session, title: session.title || 'Draft title' }),
  });
  const stream = registry.subscribe();
  expect(await stream.next()).toMatchObject({
    value: { session: { id: 'second', title: 'Draft title' } },
  });
  expect(await stream.next()).toMatchObject({
    value: { session: { id: 'first', title: 'First' } },
  });
  expect(registry.get('second')?.title).toBe('Draft title');
  expect(records.get('second')?.title).toBe('');
  expect(() => registry.register('refused', { cwd: project })).toThrow('source owns its writes');
  expect(records.has('refused')).toBe(false);

  const saved = row('second', { cwd: project, title: 'Saved' });
  records.set(saved.id, saved);
  expect(registry.get(saved.id)?.title).toBe('Saved');
  registry.publishSaved(saved);
  saved.title = 'Changed again';
  expect(await stream.next()).toMatchObject({
    value: { type: 'session_upserted', session: { id: 'second', title: 'Saved' } },
  });

  const parked = stream.next();
  const buffered = registry.subscribe();
  registry.closeSubscribers();
  expect(await parked).toEqual({ value: undefined, done: true });
  expect(await buffered.next()).toEqual({ value: undefined, done: true });
});

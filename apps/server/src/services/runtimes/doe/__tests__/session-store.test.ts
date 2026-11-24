import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { renderChatMessage } from '../../../session/chat-messages/chat-message-fence.js';
import { deriveSessionTitle } from '../../shared/session/derive-title.js';
import { DoeSessionRuntime } from '../session-runtime.js';
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

it('keeps blank messages untitled and persists the first useful title', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-store-'));
  let store = new DoeSessionStore(directory);
  try {
    const emptyMessage = renderChatMessage(
      { agentName: 'Coordinator', agentId: null, chatId: 'source', chatTitle: null },
      'start',
      '',
      'abcdef12'
    ).text;
    const preview = 'Prepare the meeting notes';
    const previewOnly = [preview, emptyMessage].join('\n');
    expect(deriveSessionTitle(previewOnly)).toBe('');

    const chats = [
      { id: 'empty', content: '', expectedTitle: '' },
      { id: 'whitespace', content: ' \t \n  ', expectedTitle: '' },
      { id: 'preview', content: previewOnly, expectedTitle: preview },
      { id: 'blank-title', content: 'plan the day', title: ' \t ', expectedTitle: 'Plan the day' },
      { id: 'named', content: '', title: '  Project plan  ', expectedTitle: '  Project plan  ' },
    ];
    for (const { id, content, title } of chats) {
      store.ensure(id, { cwd: directory });
      store.message(id, content, directory, title);
    }
    store.message('named', 'Follow-up message', directory, 'A later title');

    store.close();
    store = new DoeSessionStore(directory);
    for (const { id, expectedTitle } of chats) {
      expect(store.get(id)?.session.title, id).toBe(expectedTitle);
    }
    expect(store.get('preview')?.session.lastMessagePreview).toBe(preview);
    expect(store.get('whitespace')?.session.lastMessagePreview).toBe(' \t ');
    expect(store.list(directory)).toHaveLength(chats.length);
    expect(store.getForDisplay('empty')?.title).toBe('New chat');
    expect(store.getForDisplay('whitespace')?.title).toBe('New chat');
    store.message('whitespace', 'Review the notes', directory);
    expect(store.get('whitespace')?.session.title).toBe('Review the notes');
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it('shows legacy and draft titles without setting a durable first-message title', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-store-'));
  let runtime = new DoeSessionRuntime({ directory });
  try {
    runtime.ensureSession('draft', { cwd: directory, permissionMode: 'default' });
    const legacy = runtime.sessions.ensure('legacy', { cwd: directory });
    legacy.session.title = ' \t ';
    legacy.session.lastMessagePreview = '  Earlier preview  ';
    runtime.sessions.save(legacy);
    runtime.sessions.close();
    runtime = new DoeSessionRuntime({ directory });

    const inventory = runtime.subscribeSessionList()[Symbol.asyncIterator]();
    const expected = [
      { id: 'draft', title: 'New chat' },
      { id: 'legacy', title: 'Earlier preview' },
    ];
    expect((await runtime.listSessions(directory)).map(({ id, title }) => ({ id, title }))).toEqual(
      expected
    );
    for (const session of expected) {
      await expect(runtime.getSession(directory, session.id)).resolves.toMatchObject(session);
      expect(await inventory.next()).toMatchObject({
        done: false,
        value: { type: 'session_upserted', session },
      });
    }
    await expect(runtime.getSession(path.join(directory, 'other'), 'legacy')).resolves.toBeNull();
    expect(runtime.sessions.get('legacy')).toEqual(legacy);
    expect(runtime.sessions.ensure('draft', { cwd: directory }).session.title).toBe('');

    legacy.session.lastMessagePreview = '  Updated preview  ';
    runtime.sessions.save(legacy);
    expect(await inventory.next()).toMatchObject({
      done: false,
      value: { type: 'session_upserted', session: { id: 'legacy', title: 'Updated preview' } },
    });
    expect(runtime.sessions.get('legacy')).toEqual(legacy);

    runtime.sessions.message('legacy', 'finish the meeting notes', directory);
    expect(runtime.sessions.get('legacy')?.session.title).toBe('Finish the meeting notes');
    await expect(runtime.getSession(directory, 'legacy')).resolves.toMatchObject({
      title: 'Finish the meeting notes',
    });
    expect(await inventory.next()).toMatchObject({
      done: false,
      value: {
        type: 'session_upserted',
        session: { id: 'legacy', title: 'Finish the meeting notes' },
      },
    });
  } finally {
    runtime.sessions.close();
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
it('keeps canonical membership for future child projects reached through an alias', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'doe-project-membership-'));
  const store = new DoeSessionStore(path.join(temp, 'store'));
  try {
    const directory = realpathSync(temp);
    const project = path.join(directory, 'app');
    const alias = path.join(directory, 'linked-app');
    mkdirSync(project);
    symlinkSync(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const futureRoot = path.join(alias, 'future');
    const cwd = path.join(project, 'future', 'nested');
    store.ensure('future', { cwd: path.join(futureRoot, 'nested') });
    store.ensure('sibling', { cwd: path.join(project, 'future-other') });
    store.ensure('unbound', {});

    expect(store.get('future')?.session.cwd).toBe(cwd);
    for (const requested of [futureRoot, path.join(project, 'future')]) {
      expect(store.list(requested)).toMatchObject([{ id: 'future', cwd }]);
      expect(store.belongs('future', requested)).toBe(true);
      expect(store.belongs('sibling', requested)).toBe(false);
      expect(store.belongs('unbound', requested)).toBe(true);
    }
    expect(store.get('future')?.session.cwd).toBe(cwd);
  } finally {
    store.close();
    rmSync(temp, { recursive: true, force: true });
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

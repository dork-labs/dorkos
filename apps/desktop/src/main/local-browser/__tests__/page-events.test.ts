import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

// The real link rule; only Electron itself is faked.
vi.mock('electron', () => import('../../__tests__/electron-mock'));

import { isGuestPageAction, watchGuestPage, type GuestPageState } from '../page-events';

// Every host here is made up.
function fakePage() {
  const events = new EventEmitter();
  const history = { canGoBack: vi.fn(() => true), goBack: vi.fn() };
  const contents = Object.assign(events, {
    stop: vi.fn(),
    reload: vi.fn(),
    loadURL: vi.fn(async () => undefined),
    isLoading: vi.fn(() => false),
    navigationHistory: history,
  });
  const published: GuestPageState[] = [];
  const watch = watchGuestPage('owned', contents as never, (state) => published.push(state));
  return { events, contents, history, published, watch };
}

describe('watchGuestPage', () => {
  it('reports a load starting and stopping', () => {
    const { events, published } = fakePage();
    events.emit('did-start-loading');
    events.emit('did-stop-loading');
    expect(published.map((state) => state.loading)).toEqual([true, false]);
    expect(published[0]?.connectionId).toBe('owned');
  });

  it('records a failed main-frame load with the browser’s own host and address', () => {
    const { events, watch } = fakePage();
    events.emit(
      'did-fail-load',
      {},
      -105,
      'ERR_NAME_NOT_RESOLVED',
      'https://northwind.example/pricing',
      true
    );
    expect(watch.read().failure).toEqual({
      code: 'ERR_NAME_NOT_RESOLVED',
      host: 'northwind.example',
      url: 'https://northwind.example/pricing',
    });
  });

  it.each([
    ['a frame inside the page', 'ERR_NAME_NOT_RESOLVED', 'https://northwind.example/', false],
    ['a cancelled load', 'ERR_ABORTED', 'https://northwind.example/', true],
    ['free text', 'something <b>else</b>', 'https://northwind.example/', true],
    ['a non-web address', 'ERR_FILE_NOT_FOUND', 'file:///etc/hosts', true],
  ])('ignores %s', (_what, description, url, mainFrame) => {
    const { events, published } = fakePage();
    events.emit('did-fail-load', {}, -1, description, url, mainFrame);
    expect(published).toEqual([]);
  });

  it('a page that commits clears the failure', () => {
    const { events, watch } = fakePage();
    events.emit(
      'did-fail-load',
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://northwind.example/',
      true
    );
    events.emit('did-navigate', {}, 'https://contoso.example/');
    expect(watch.read().failure).toBeNull();
  });

  it('a crash names the page it took down and stops the loading bar', () => {
    const { events, watch } = fakePage();
    events.emit('did-navigate', {}, 'https://northwind.example/app');
    events.emit('did-start-loading');
    events.emit('render-process-gone', {}, { reason: 'crashed' });
    expect(watch.read()).toEqual({
      connectionId: 'owned',
      loading: false,
      failure: { code: 'CRASHED', host: 'northwind.example', url: 'https://northwind.example/app' },
      refusal: null,
    });
  });

  it('Try again loads only the address the browser recorded', () => {
    const { events, contents, watch } = fakePage();
    watch.run('retry');
    expect(contents.loadURL).not.toHaveBeenCalled();
    events.emit('did-fail-load', {}, -7, 'ERR_TIMED_OUT', 'https://northwind.example/a?b=1', true);
    watch.run('retry');
    expect(contents.loadURL).toHaveBeenCalledWith('https://northwind.example/a?b=1');
  });

  it('Stop, Reload and Go back reach the page; Go back with no history opens an empty page', () => {
    const { contents, history, watch } = fakePage();
    watch.run('stop');
    watch.run('reload');
    watch.run('back');
    expect(contents.stop).toHaveBeenCalledOnce();
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(history.goBack).toHaveBeenCalledOnce();
    history.canGoBack.mockReturnValue(false);
    watch.run('back');
    expect(contents.loadURL).toHaveBeenCalledWith('about:blank');
  });

  it('stops listening once disposed', () => {
    const { events, published, watch } = fakePage();
    watch.dispose();
    events.emit('did-start-loading');
    expect(published).toEqual([]);
    expect(events.eventNames()).toEqual([]);
  });
});

describe('isGuestPageAction', () => {
  it('accepts only the five actions', () => {
    for (const action of ['read', 'stop', 'retry', 'back', 'reload'])
      expect(isGuestPageAction(action)).toBe(true);
    for (const other of ['navigate', '', 'constructor', 1, null])
      expect(isGuestPageAction(other)).toBe(false);
  });
});

// DOR-4097, DOR-4650: a site refusing this browser shows the person a way out,
// read from the address and title the browser already has, with nothing loaded.
describe('a refusal page', () => {
  it('reads a Google sign-in refusal from its address', () => {
    const { events, watch, published } = fakePage();
    events.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/rejected?made=up');
    expect(watch.read().refusal).toEqual({ kind: 'sign-in', host: 'accounts.google.com' });
    expect(published.at(-1)?.refusal).toEqual({ kind: 'sign-in', host: 'accounts.google.com' });
  });

  it('reads a bot check from its title, and names the host from the address', () => {
    const { events, watch } = fakePage();
    events.emit('did-navigate', {}, 'https://northwind.example/cart');
    expect(watch.read().refusal).toBeNull();
    events.emit('page-title-updated', {}, 'Just a moment...', true);
    expect(watch.read().refusal).toEqual({ kind: 'blocked', host: 'northwind.example' });
  });

  it('follows an in-page move to the refusal', () => {
    const { events, watch } = fakePage();
    events.emit('did-navigate', {}, 'https://accounts.google.com/v3/signin/identifier');
    events.emit('did-navigate-in-page', {}, 'https://accounts.google.com/v3/signin/rejected', true);
    expect(watch.read().refusal?.kind).toBe('sign-in');
  });

  it('clears once the page moves on', () => {
    const { events, watch } = fakePage();
    events.emit('did-navigate', {}, 'https://northwind.example/');
    events.emit('page-title-updated', {}, 'Access Denied', true);
    expect(watch.read().refusal?.kind).toBe('blocked');
    events.emit('did-navigate', {}, 'https://northwind.example/home');
    expect(watch.read().refusal).toBeNull();
  });

  it('ignores a frame inside the page', () => {
    const { events, watch } = fakePage();
    events.emit('did-navigate', {}, 'https://northwind.example/');
    events.emit('did-navigate-in-page', {}, 'https://accounts.google.com/signin/rejected', false);
    expect(watch.read().refusal).toBeNull();
  });

  it('stops listening once disposed', () => {
    const { events, watch } = fakePage();
    watch.dispose();
    expect(events.listenerCount('page-title-updated')).toBe(0);
    expect(events.listenerCount('did-navigate-in-page')).toBe(0);
  });
});

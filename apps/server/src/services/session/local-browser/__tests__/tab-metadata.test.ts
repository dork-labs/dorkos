import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import { LocalBrowserTabMetadata } from '../tab-metadata.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  let url = 'https://synthetic.example/';
  const events = new EventEmitter();
  const send = vi.fn(async () => ({ targetInfo: { title: 'Synthetic title' } }));
  const detach = vi.fn(async () => undefined);
  const newCDPSession = vi.fn(async () => ({ send, detach }));
  const title = vi.fn(async () => 'Activating title read');
  const evaluate = vi.fn();
  const mainFrame = {};
  const page = {
    on: events.on.bind(events),
    context: () => ({ newCDPSession }),
    mainFrame: () => mainFrame,
    url: () => url,
    isClosed: () => false,
    title,
    evaluate,
  } as unknown as Page;
  const metadata = new LocalBrowserTabMetadata();
  metadata.track(page, {
    active: () => true,
    selected: () => true,
    invalidate: vi.fn(),
    framesChanged: vi.fn(),
    closed: vi.fn(),
  });
  const label = () => metadata.describe([['synthetic-tab', page]])[0].title;
  return {
    metadata,
    page,
    events,
    mainFrame,
    send,
    detach,
    newCDPSession,
    title,
    evaluate,
    label,
    navigate: (next: string) => {
      url = next;
    },
  };
}

describe('tab metadata without page activation', () => {
  it('describes only cached admitted pages and retains labels during a same-document refresh', async () => {
    const f = fixture();
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.label()).toBe('Synthetic title'));
    f.send.mockClear();
    expect(f.metadata.describe([['selected', f.page]])).toEqual([
      { id: 'selected', url: 'https://synthetic.example/', title: 'Synthetic title' },
    ]);
    expect(f.send).not.toHaveBeenCalled();
    const pending = deferred<{ targetInfo: { title: string } }>();
    f.send.mockImplementationOnce(() => pending.promise);
    f.metadata.refresh(f.page);
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    expect(f.label()).toBe('Synthetic title');
    pending.resolve({ targetInfo: { title: 'Changed without navigation' } });
    await vi.waitFor(() => expect(f.label()).toBe('Changed without navigation'));
  });

  it.each(['framenavigated', 'domcontentloaded'])(
    'reads %s titles without running page JS',
    async (event) => {
      const f = fixture();
      f.events.emit(event, f.mainFrame);
      await vi.waitFor(() => expect(f.label()).toBe('Synthetic title'));
      expect(f.newCDPSession).toHaveBeenCalledWith(f.page);
      expect(f.send).toHaveBeenCalledExactlyOnceWith('Target.getTargetInfo', undefined, {
        timeout: 3000,
      });
      expect(f.detach).toHaveBeenCalledOnce();
      expect(f.title).not.toHaveBeenCalled();
      expect(f.evaluate).not.toHaveBeenCalled();
    }
  );

  it('deduplicates pending reads and fences an older document at the same URL', async () => {
    const f = fixture();
    let resolveOld!: (value: { targetInfo: { title: string } }) => void;
    f.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        })
    );
    f.metadata.refresh(f.page);
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.events.emit('domcontentloaded');
    await vi.waitFor(() => expect(f.label()).toBe('Synthetic title'));
    resolveOld({ targetInfo: { title: 'Old document' } });
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledTimes(2));
    expect(f.label()).toBe('Synthetic title');
  });

  it('detaches a failed read and allows the next refresh', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('Target closed'));
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledOnce());
    expect(f.label()).toBe('');
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.label()).toBe('Synthetic title'));
    expect(f.detach).toHaveBeenCalledTimes(2);
  });

  it('rejects old-document replies and never labels a new URL with the old title', async () => {
    const f = fixture();
    const old = deferred<{ targetInfo: { title: string } }>();
    f.send.mockImplementationOnce(() => old.promise);
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.navigate('https://synthetic.example/second');
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.label()).toBe('Synthetic title'));
    old.resolve({ targetInfo: { title: 'Old document' } });
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledTimes(2));
    expect(f.label()).toBe('Synthetic title');
    f.navigate('https://synthetic.example/third');
    expect(f.label()).toBe('');
  });

  it('fences pending replies from a disconnected browser connection', async () => {
    const f = fixture();
    const old = deferred<{ targetInfo: { title: string } }>();
    f.send.mockImplementationOnce(() => old.promise);
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.send).toHaveBeenCalledOnce());
    f.metadata.clear();
    f.metadata.refresh(f.page);
    await vi.waitFor(() => expect(f.label()).toBe('Synthetic title'));
    old.resolve({ targetInfo: { title: 'Old connection secret' } });
    await vi.waitFor(() => expect(f.detach).toHaveBeenCalledTimes(2));
    expect(f.label()).toBe('Synthetic title');
  });
});

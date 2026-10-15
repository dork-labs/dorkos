import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { LocalBrowserTabMetadata } from '../tab-metadata.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  let url = 'http://fixture.test/first';
  const page = { url: () => url, title: vi.fn(async () => 'Initial'), isClosed: () => false };
  return {
    page: page as unknown as Page,
    title: page.title,
    navigate: (next: string) => {
      url = next;
    },
  };
}

describe('event-refreshed local browser metadata', () => {
  it('describes only cached admitted pages without title evaluation', async () => {
    const { page, title } = fixture();
    const metadata = new LocalBrowserTabMetadata();
    metadata.refresh(page);
    await Promise.resolve();
    title.mockClear();
    expect(metadata.describe([['selected', page]])).toEqual([
      { id: 'selected', url: 'http://fixture.test/first', title: 'Initial' },
    ]);
    expect(title).not.toHaveBeenCalled();
  });
  it('preserves the cached title while deduplicating a pending same-document refresh', async () => {
    const { page, title } = fixture();
    const metadata = new LocalBrowserTabMetadata();
    metadata.refresh(page);
    await Promise.resolve();
    title.mockClear();
    const pending = deferred<string>();
    title.mockImplementationOnce(() => pending.promise);
    metadata.refresh(page);
    metadata.refresh(page);
    metadata.refresh(page);
    expect(title).toHaveBeenCalledOnce();
    expect(metadata.describe([['selected', page]])[0].title).toBe('Initial');
    pending.resolve('Changed without navigation');
    await Promise.resolve();
    expect(metadata.describe([['selected', page]])[0].title).toBe('Changed without navigation');
  });
  it('replaces a pending old-document read even when navigation keeps the same address', async () => {
    const { page, title } = fixture();
    const metadata = new LocalBrowserTabMetadata();
    const old = deferred<string>();
    title
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce('New same-address document');
    metadata.refresh(page);
    metadata.refresh(page, { newDocument: true });
    await Promise.resolve();
    old.resolve('Old document');
    await Promise.resolve();
    expect(metadata.describe([['selected', page]])[0].title).toBe('New same-address document');
  });
  it('rejects old-document replies and never labels a new address with the old title', async () => {
    const { page, title, navigate } = fixture();
    const metadata = new LocalBrowserTabMetadata();
    const first = deferred<string>();
    const second = deferred<string>();
    title.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    metadata.refresh(page);
    navigate('http://fixture.test/second');
    metadata.refresh(page);
    second.resolve('New document');
    await Promise.resolve();
    first.resolve('Old document');
    await Promise.resolve();
    expect(metadata.describe([['selected', page]])[0]).toEqual({
      id: 'selected',
      url: 'http://fixture.test/second',
      title: 'New document',
    });
    navigate('http://fixture.test/third');
    expect(metadata.describe([['selected', page]])[0].title).toBe('');
  });
  it('fences pending replies from a disconnected browser connection', async () => {
    const { page, title } = fixture();
    const metadata = new LocalBrowserTabMetadata();
    const old = deferred<string>();
    title.mockImplementationOnce(() => old.promise);
    metadata.refresh(page);
    metadata.clear();
    metadata.refresh(page);
    await Promise.resolve();
    old.resolve('Old connection secret');
    await Promise.resolve();
    expect(metadata.describe([['selected', page]])[0].title).toBe('Initial');
  });
});

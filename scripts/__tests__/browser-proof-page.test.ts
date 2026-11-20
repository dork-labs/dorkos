import { expect, it, vi } from 'vitest';
import { browserProofPage } from '../../apps/desktop/scripts/local-browser-ci/proof-page.js';

type Connection = NonNullable<Parameters<typeof browserProofPage>[0]>;
type Page = Awaited<ReturnType<typeof browserProofPage>>;

function fixture() {
  const initial = { isClosed: () => false } as Page;
  let closed = false;
  const owned = { isClosed: () => closed } as Page;
  const connection = {
    pages: vi.fn(() => [initial, owned]),
    newPage: vi.fn(async () => owned),
  } satisfies Connection & { pages: () => Page[] };
  return { owned, connection, closeOwned: () => (closed = true) };
}

it('refuses a missing chat page handle', async () => {
  await expect(browserProofPage(undefined)).rejects.toThrow('no live chat page');
});

it('uses the exact registered chat page while leaving existing pages alone', async () => {
  const f = fixture();
  expect(await browserProofPage(f.connection)).toBe(f.owned);
  expect(f.connection.newPage).toHaveBeenCalledExactlyOnceWith();
  expect(f.connection.pages).not.toHaveBeenCalled();
});

it('does not fall back to an existing page when the chat page closes', async () => {
  const f = fixture();
  f.closeOwned();
  await expect(browserProofPage(f.connection)).rejects.toThrow('no live chat page');
  expect(f.connection.pages).not.toHaveBeenCalled();
});

it('reads the new scoped handle when Chrome reopens', async () => {
  const a = fixture();
  const b = fixture();
  expect(await browserProofPage(a.connection)).toBe(a.owned);
  expect(await browserProofPage(b.connection)).toBe(b.owned);
  expect(a.connection.pages).not.toHaveBeenCalled();
  expect(b.connection.pages).not.toHaveBeenCalled();
});

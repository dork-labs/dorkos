import { expect, it, vi } from 'vitest';
import type { BrowserContext } from 'playwright-core';
import { prepareAgentLaunch } from '../connection/agent-launch.js';
import { fakeLeasePage } from './page-leases-fixture.js';

function windowFixture() {
  const pages: ReturnType<typeof fakeLeasePage>[] = [];
  const context = {
    pages: () => pages.filter(({ page }) => !page.isClosed()).map(({ page }) => page),
    newPage: vi.fn(async () => add().page),
  } as unknown as BrowserContext;
  function add(url = 'about:blank') {
    const next = fakeLeasePage(() => context, `tab-${pages.length}`);
    next.navigate(url);
    pages.push(next);
    return next;
  }
  return { context, pages, add };
}

it('creates the chat page before closing the sole startup page once', async () => {
  const f = windowFixture();
  const startup = f.add();
  const admit = vi.fn();
  const keys = Reflect.ownKeys(f.context);
  expect(await prepareAgentLaunch(f.context, admit)).toBeUndefined();
  expect(Reflect.ownKeys(f.context)).toEqual(keys);
  expect(startup.page.close).not.toHaveBeenCalled();
  const owned = await f.context.newPage();
  expect(owned).not.toBe(startup.page);
  expect(f.context.pages()).toEqual([owned]);
  expect(startup.page.close).toHaveBeenCalledTimes(1);
  expect(admit).toHaveBeenCalled();
  await f.context.newPage();
  expect(startup.page.close).toHaveBeenCalledTimes(1);
});

it.each(['restored', 'opener', 'multiple'])('retains an ambiguous %s startup', async (kind) => {
  const f = windowFixture();
  const startup = f.add(kind === 'restored' ? 'https://restored.example.test/' : 'about:blank');
  if (kind === 'opener')
    vi.mocked(startup.page.opener).mockResolvedValue(fakeLeasePage(() => f.context, 'opener').page);
  if (kind === 'multiple') f.add();
  const initial = [...f.context.pages()];
  await prepareAgentLaunch(f.context, () => undefined);
  const owned = await f.context.newPage();
  expect(initial).not.toContain(owned);
  for (const page of initial) expect(page.close).not.toHaveBeenCalled();
});

it.each(['navigated', 'closed', 'replaced'])(
  'retains later pages when the candidate is %s',
  async (kind) => {
    const f = windowFixture();
    const startup = f.add();
    await prepareAgentLaunch(f.context, () => undefined);
    if (kind === 'navigated') startup.navigate('https://person.example.test/');
    if (kind === 'closed' || kind === 'replaced') await startup.page.close();
    const person = f.add();
    const popup = f.add();
    vi.mocked(popup.page.opener).mockResolvedValue(person.page);
    await f.context.newPage();
    expect(startup.page.close).toHaveBeenCalledTimes(kind === 'navigated' ? 0 : 1);
    expect(person.page.close).not.toHaveBeenCalled();
    expect(popup.page.close).not.toHaveBeenCalled();
  }
);

it('closes only the captured identity when later blank pages exist', async () => {
  const f = windowFixture();
  const startup = f.add();
  await prepareAgentLaunch(f.context, () => undefined);
  const later = f.add();
  const owned = await f.context.newPage();
  expect(startup.page.close).toHaveBeenCalledTimes(1);
  expect(later.page.close).not.toHaveBeenCalled();
  expect(owned.close).not.toHaveBeenCalled();
});

it('rechecks admission at close dispatch and consumes a refused candidate', async () => {
  const f = windowFixture();
  const startup = f.add();
  let held = false;
  const admit = vi.fn(() => {
    if (held) throw new Error('held');
  });
  await prepareAgentLaunch(f.context, admit);
  held = true;
  await expect(f.context.newPage()).rejects.toThrow('held');
  expect(startup.page.close).not.toHaveBeenCalled();
  admit.mockImplementation(() => undefined);
  await f.context.newPage();
  expect(startup.page.close).not.toHaveBeenCalled();
});

it('keeps a captured page when its context identity changes', async () => {
  const f = windowFixture();
  const startup = f.add();
  await prepareAgentLaunch(f.context, () => undefined);
  startup.page.context = () => windowFixture().context;
  await f.context.newPage();
  expect(startup.page.close).not.toHaveBeenCalled();
});

it('captures before a theme probe and cleans up only after the chat page exists', async () => {
  const f = windowFixture();
  const startup = f.add();
  await prepareAgentLaunch(
    f.context,
    () => undefined,
    async (context) => {
      const probe = await context.newPage();
      expect(startup.page.close).not.toHaveBeenCalled();
      await probe.close();
    }
  );
  expect(startup.page.close).not.toHaveBeenCalled();
  const owned = await f.context.newPage();
  expect(f.context.pages()).toEqual([owned]);
});

it('consumes the startup identity once during concurrent page creation', async () => {
  const f = windowFixture();
  const startup = f.add();
  await prepareAgentLaunch(f.context, () => undefined);
  const owned = await Promise.all([f.context.newPage(), f.context.newPage()]);
  expect(f.context.pages()).toEqual(owned);
  expect(startup.page.close).toHaveBeenCalledTimes(1);
});

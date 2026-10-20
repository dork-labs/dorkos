import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { JSHandle, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { observationNodes, type ObservedPageNodes } from '../observation-nodes.js';
import { performPageAction } from '../page-action.js';
import { LocalBrowserError } from '../errors.js';

interface FixtureElement {
  localName: string;
  isConnected: boolean;
  shadowRoot: FixtureRoot | null;
}
interface FixtureRoot {
  activeElement: FixtureElement | null;
  querySelectorAll(): FixtureElement[];
}
const element = (localName = 'input'): FixtureElement => ({
  localName,
  isConnected: true,
  shadowRoot: null,
});

/** Exercise the actual serialized observation callback, including keepNames transport. */
async function capture(document: FixtureRoot) {
  let callback!: () => unknown;
  await observationNodes({
    evaluateHandle: async (evaluate: () => unknown) => {
      callback = evaluate;
    },
  } as unknown as Page);
  const transformed = transformSync('globalThis.capture = ' + callback.toString() + ';', {
    keepNames: true,
    loader: 'ts',
    target: 'es2022',
  }).code;
  const host: { capture?: () => unknown } = {};
  runInNewContext(transformed, host);
  return runInNewContext('(' + host.capture!.toString() + ')()', { document }) as ObservedPageNodes;
}

async function fixture() {
  const body = element('body'),
    first = element(),
    second = element();
  const document: FixtureRoot = {
    activeElement: first,
    querySelectorAll: () => [body, first, second],
  };
  const nodes = await capture(document);
  const keyEffect = vi.fn();
  const snapshot = '- textbox "First"\n- textbox "Second"';
  const page = {
    url: () => 'http://fixture.test/',
    locator: () => ({
      ariaSnapshot: async () => snapshot,
      elementHandle: async () => ({ dispose: async () => undefined }),
    }),
    keyboard: {
      press: vi.fn(async () => {
        let target = document.activeElement;
        while (target?.shadowRoot?.activeElement) target = target.shadowRoot.activeElement;
        keyEffect(target);
      }),
    },
  } as unknown as Page;
  // The body handle is the same observed DOM identity, not an inferred accessible match.
  vi.spyOn(page, 'locator').mockReturnValue({
    ariaSnapshot: async () => snapshot,
    elementHandle: async () => body,
  } as unknown as ReturnType<Page['locator']>);
  Object.assign(body, { dispose: vi.fn(async () => undefined) });
  const handle = {
    evaluate: async (
      evaluate: (nodes: ObservedPageNodes, value: unknown) => unknown,
      value: unknown
    ) => runInNewContext('(' + evaluate.toString() + ')(nodes, value)', { nodes, value, document }),
  } as unknown as JSHandle<ObservedPageNodes>;
  const dispatched = vi.fn();
  const press = () =>
    performPageAction(
      page,
      { snapshot, revision: 1, url: page.url(), tabId: 'tab' },
      handle,
      { kind: 'press', key: 'Enter', revision: 1 },
      () => undefined,
      dispatched,
      () => new LocalBrowserError('stale_page', 'Read the page again.')
    );
  return { body, first, second, document, nodes, page, keyEffect, dispatched, press };
}

describe('observed key focus admission', () => {
  it('refuses an old Enter after focus moves without any DOM or snapshot change', async () => {
    const f = await fixture();
    expect(f.nodes.focusedElement).toBe(f.first);
    f.document.activeElement = f.second;
    await expect(f.press()).rejects.toMatchObject({ code: 'stale_page' });
    expect(f.page.keyboard.press).not.toHaveBeenCalled();
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.keyEffect).not.toHaveBeenCalled();
  });
  it('refuses Enter when the observation could not attest a focus target', async () => {
    const f = await fixture();
    f.nodes.focusedElement = null;
    await expect(f.press()).rejects.toMatchObject({ code: 'stale_page' });
    expect(f.dispatched).not.toHaveBeenCalled();
    expect(f.keyEffect).not.toHaveBeenCalled();
  });
  it('allows Enter on the same connected observed target', async () => {
    const f = await fixture();
    await f.press();
    expect(f.keyEffect).toHaveBeenCalledExactlyOnceWith(f.first);
  });
  it('refuses a removed focused node even if activeElement still refers to it', async () => {
    const f = await fixture();
    f.first.isConnected = false;
    await expect(f.press()).rejects.toMatchObject({ code: 'stale_page' });
    expect(f.dispatched).not.toHaveBeenCalled();
  });
  it('follows nested open shadow focus and refuses an inner focus move', async () => {
    const f = await fixture(),
      host = element('open-field'),
      nested = element('nested-field');
    nested.shadowRoot = { activeElement: f.first, querySelectorAll: () => [f.first, f.second] };
    host.shadowRoot = { activeElement: nested, querySelectorAll: () => [nested] };
    f.document.activeElement = host;
    f.document.querySelectorAll = () => [f.body, host];
    const observed = await capture(f.document);
    expect(observed.focusedElement).toBe(f.first);
    f.nodes.focusedElement = observed.focusedElement;
    await f.press();
    expect(f.keyEffect).toHaveBeenCalledExactlyOnceWith(f.first);
    f.keyEffect.mockClear();
    nested.shadowRoot.activeElement = f.second;
    await expect(f.press()).rejects.toMatchObject({ code: 'stale_page' });
    expect(f.keyEffect).not.toHaveBeenCalled();
  });
  it.each(['iframe', 'frame', 'object', 'embed', 'opaque-field', 'div', 'span', 'article', 'body'])(
    'does not attest focus inside %s',
    async (name) => {
      const target = element(name);
      const nodes = await capture({ activeElement: target, querySelectorAll: () => [target] });
      expect(nodes.focusedElement).toBeNull();
    }
  );
  it('does not attest a missing active target', async () => {
    expect(
      (await capture({ activeElement: null, querySelectorAll: () => [] })).focusedElement
    ).toBeNull();
  });
});

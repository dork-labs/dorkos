import { runInNewContext } from 'node:vm';
import { transformSync } from 'esbuild';
import type { ElementHandle, JSHandle, Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { isInertFillTarget } from '../inert-target.js';
import { performPageAction } from '../page-action.js';
import type { ObservedPageNodes } from '../observation-nodes.js';
import { LocalBrowserError } from '../errors.js';

class FixtureShadowRoot {
  constructor(readonly host: FixtureElement) {}
}

class FixtureElement {
  assignedSlot: FixtureElement | null = null;
  parentElement: FixtureElement | null = null;
  root: FixtureShadowRoot | object = {};

  constructor(readonly inert = false) {}

  hasAttribute(name: string) {
    return name === 'inert' && this.inert;
  }

  getRootNode() {
    return this.root;
  }
}

/** Serialize the actual browser callback independently of the host's tsx helpers. */
async function inspect(element: FixtureElement) {
  let callback!: (element: Element) => boolean;
  const handle = {
    evaluate: vi.fn(async (evaluate: typeof callback) => {
      callback = evaluate;
      return false;
    }),
  } as unknown as ElementHandle<Element>;
  await isInertFillTarget(handle);
  const transformed = transformSync(`globalThis.inspect = ${callback.toString()};`, {
    keepNames: true,
    loader: 'ts',
    target: 'es2022',
  }).code;
  const host: { inspect?: (element: Element) => boolean } = {};
  runInNewContext(transformed, host);
  return runInNewContext(`(${host.inspect!.toString()})(element)`, {
    element,
    ShadowRoot: FixtureShadowRoot,
  });
}

describe('inert fill admission', () => {
  it('refuses inert targets and ancestors, including slotted and shadow-root ancestry', async () => {
    expect(await inspect(new FixtureElement())).toBe(false);
    expect(await inspect(new FixtureElement(true))).toBe(true);
    const nested = new FixtureElement();
    nested.parentElement = new FixtureElement(true);
    expect(await inspect(nested)).toBe(true);
    const slotted = new FixtureElement();
    slotted.assignedSlot = new FixtureElement(true);
    expect(await inspect(slotted)).toBe(true);
    const shadowChild = new FixtureElement();
    shadowChild.root = new FixtureShadowRoot(new FixtureElement(true));
    expect(await inspect(shadowChild)).toBe(true);
    const slottedShadowChild = new FixtureElement();
    slottedShadowChild.assignedSlot = new FixtureElement();
    slottedShadowChild.assignedSlot.root = new FixtureShadowRoot(new FixtureElement(true));
    expect(await inspect(slottedShadowChild)).toBe(true);
  });

  it('rechecks inert after the final snapshot and refuses before dispatch or fill', async () => {
    let inert = false;
    const fill = vi.fn();
    const handle = {
      isEditable: vi.fn(async () => true),
      evaluate: vi.fn(async () => inert),
      fill,
      dispose: vi.fn(async () => undefined),
    };
    const snapshot = vi
      .fn()
      .mockResolvedValueOnce('- textbox "Name"')
      .mockImplementationOnce(async () => {
        inert = true;
        return '- textbox "Name"';
      });
    const page = {
      url: () => 'http://fixture.test/',
      locator: () => ({ ariaSnapshot: snapshot }),
      getByRole: () => ({ count: async () => 1, elementHandle: async () => handle }),
    } as unknown as Page;
    const dispatched = vi.fn();
    await expect(
      performPageAction(
        page,
        { snapshot: '- textbox "Name"', url: 'http://fixture.test/', revision: 1, tabId: 'tab' },
        { evaluate: async () => true } as unknown as JSHandle<ObservedPageNodes>,
        { kind: 'fill', role: 'textbox', name: 'Name', text: 'replacement', revision: 1 },
        () => undefined,
        dispatched,
        () => new LocalBrowserError('stale_page', 'stale')
      )
    ).rejects.toMatchObject({ code: 'not_editable' });
    expect(dispatched).not.toHaveBeenCalled();
    expect(fill).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
});

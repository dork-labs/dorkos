import type { ElementHandle } from 'playwright-core';

/** Read explicit inert state through the target's composed ancestors without changing focus. */
export function isInertFillTarget(handle: ElementHandle<Element>): Promise<boolean> {
  return handle.evaluate((element) => {
    let current: Element | null = element;
    while (current) {
      if (current.hasAttribute('inert')) return true;
      const root = current.getRootNode();
      current =
        current.assignedSlot ??
        current.parentElement ??
        (root instanceof ShadowRoot ? root.host : null);
    }
    return false;
  });
}

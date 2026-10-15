import type { JSHandle, Page } from 'playwright-core';

/** Internal observation identity; key presses also retain the exact focused DOM target. */
export interface ObservedPageNodes extends Set<Element> {
  focusedElement: Element | null;
}

/** Record DOM and deep-focus identity, including open shadow roots, before observation. */
export function observationNodes(page: Page): Promise<JSHandle<ObservedPageNodes>> {
  return page.evaluateHandle(() => {
    const nodes = new Set<Element>();
    const roots: (Document | ShadowRoot)[] = [document];
    while (roots.length) {
      const root = roots.pop()!;
      for (const element of root.querySelectorAll('*')) {
        nodes.add(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    let focusedElement = document.activeElement;
    while (focusedElement?.shadowRoot?.activeElement)
      focusedElement = focusedElement.shadowRoot.activeElement;
    // Ordinary div/span/body hosts can hide closed shadow focus too. Only native controls
    // that cannot host an author shadow root provide an attestable keyboard target.
    if (focusedElement && !/^(input|textarea|select|button|a)$/.test(focusedElement.localName))
      focusedElement = null;
    return Object.assign(nodes, { focusedElement });
  });
}

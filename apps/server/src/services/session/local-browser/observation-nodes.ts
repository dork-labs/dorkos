import type { JSHandle, Page } from 'playwright-core';

/** Record DOM identity, including open shadow roots, before taking a page observation. */
export function observationNodes(page: Page): Promise<JSHandle<Set<Element>>> {
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
    return nodes;
  });
}

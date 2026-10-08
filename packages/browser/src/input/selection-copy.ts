import type { CDPSession } from 'playwright-core';
import { originalSelectionPhases } from './selection-phase.js';

/** Fixed refusal metadata, never secret field contents. */
export type SelectionCopy = Readonly<
  | { outcome: 'selected'; text: string }
  | { outcome: 'refused'; reason: 'secret' | 'selection' | 'unsupported' | 'capacity' }
>;
/** Runs only in the captured root document's isolated world. No clipboard or network access. */
export function inspectOriginalSelection(doc: Document): SelectionCopy {
  const refuse = (reason: 'secret' | 'selection' | 'unsupported' | 'capacity'): SelectionCopy => ({
    outcome: 'refused',
    reason,
  });
  if (!doc.hasFocus()) return refuse('selection');
  let active = doc.activeElement;
  for (let depth = 0; depth < 32 && active?.shadowRoot?.activeElement; depth++)
    active = active.shadowRoot.activeElement;
  if (!active || !active.isConnected || active.ownerDocument !== doc) return refuse('selection');
  const sensitive = (element: Element): boolean => {
    const type = element.getAttribute('type')?.toLowerCase() ?? 'text';
    const auto = (element.getAttribute('autocomplete') ?? '').toLowerCase().split(/\s+/u);
    return (
      (element.localName === 'input' &&
        !['text', 'search', 'email', 'tel', 'url'].includes(type)) ||
      auto.some(
        (token) =>
          ['current-password', 'new-password', 'one-time-code'].includes(token) ||
          token.startsWith('cc-')
      ) ||
      element.getAttribute('data-sensitive') === 'true' ||
      element.getAttribute('aria-secret') === 'true'
    );
  };
  const seen = new Set<Element>();
  let ancestor: Element | null = active;
  for (let depth = 0; ancestor; depth++) {
    if (depth > 32 || seen.has(ancestor)) return refuse('capacity');
    seen.add(ancestor);
    if (sensitive(ancestor)) return refuse('secret');
    if (ancestor.parentElement) {
      ancestor = ancestor.parentElement;
      continue;
    }
    const root: Node = ancestor.getRootNode();
    if (root === doc) {
      ancestor = null;
      continue;
    }
    if (root.nodeType !== 11 || !('host' in root)) return refuse('unsupported');
    const host: Element = (root as ShadowRoot).host;
    if (!host || host.ownerDocument !== doc || !host.isConnected) return refuse('unsupported');
    ancestor = host;
  }
  const bounded = (text: string): SelectionCopy => {
    if (!text) return refuse('selection');
    if (
      text.length > 2048 ||
      new TextEncoder().encode(text).length > 2048 ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
    )
      return refuse('capacity');
    return { outcome: 'selected', text };
  };
  if (active.localName === 'input' || active.localName === 'textarea') {
    // Secret classification precedes every original selection/value getter.
    const field = active as HTMLInputElement | HTMLTextAreaElement;
    const start = field.selectionStart,
      end = field.selectionEnd;
    if (
      start === null ||
      end === null ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start ||
      end - start > 2048
    )
      return refuse('selection');
    const value = field.value;
    if (value.length > 2048 || new TextEncoder().encode(value).length > 2048)
      return refuse('capacity');
    if (end > value.length) return refuse('selection');
    return bounded(value.slice(start, end));
  }
  // Editable and subframe selections require a separately qualified inspector.
  if (active.localName === 'iframe' || (active as HTMLElement).isContentEditable)
    return refuse('unsupported');
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) return refuse('selection');
  const range = selection.getRangeAt(0);
  if (range.startContainer.ownerDocument !== doc || range.endContainer.ownerDocument !== doc)
    return refuse('selection');
  let rangeAncestor: Node | null = range.commonAncestorContainer;
  for (let depth = 0; rangeAncestor; depth++, rangeAncestor = rangeAncestor.parentNode) {
    if (depth > 32) return refuse('capacity');
    if (
      rangeAncestor.nodeType === 1 &&
      (sensitive(rangeAncestor as Element) || (rangeAncestor as HTMLElement).isContentEditable)
    )
      return refuse('secret');
  }
  if (range.commonAncestorContainer.getRootNode() !== doc) return refuse('unsupported');
  const stack: Node[] = [range.commonAncestorContainer];
  let count = 0;
  while (stack.length) {
    if (++count > 2048) return refuse('capacity');
    const node = stack.pop()!;
    if (
      node.nodeType === 1 &&
      range.intersectsNode(node) &&
      (sensitive(node as Element) || (node as HTMLElement).isContentEditable)
    )
      return refuse('secret');
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (stack.length + count >= 2048) return refuse('capacity');
      stack.push(child);
    }
  }
  return bounded(selection.toString());
}
/** One fixed root-document read through the existing lifetime-owned input session. */
export async function readOriginalSelection(
  session: Pick<CDPSession, 'send'>,
  guard: () => void
): Promise<SelectionCopy> {
  const check = () => {
    const finish = originalSelectionPhases.begin('authority');
    try {
      guard();
      finish('settled');
    } catch (value) {
      finish('failed');
      throw value;
    }
  };
  const send = session.send.bind(session);
  check();
  const initial = await originalSelectionPhases.observe(
    'initial-tree',
    async () => (await send('Page.getFrameTree')).frameTree.frame
  );
  check();
  const frameId = initial.id,
    loaderId = initial.loaderId;
  originalSelectionPhases.observeSync('initial-tree', () => {
    if (
      typeof frameId !== 'string' ||
      typeof loaderId !== 'string' ||
      !frameId ||
      !loaderId ||
      frameId.length > 1024 ||
      loaderId.length > 1024
    )
      throw new Error('COPY_DOCUMENT_REFUSED');
  });
  const world = await originalSelectionPhases.observe('world', async () => {
    const original = await send('Page.createIsolatedWorld', {
      frameId,
      worldName: 'dork-owner-selection-copy-v1',
      grantUniveralAccess: false,
    });
    check();
    if (!Number.isSafeInteger(original.executionContextId) || original.executionContextId <= 0)
      throw new Error('COPY_DOCUMENT_REFUSED');
    return original;
  });
  const result = await originalSelectionPhases.observe('read', () =>
    send('Runtime.evaluate', {
      contextId: world.executionContextId,
      expression: `(${inspectOriginalSelection.toString()})(document)`,
      returnByValue: true,
      awaitPromise: false,
    })
  );
  check();
  const final = await originalSelectionPhases.observe(
    'final-tree',
    async () => (await send('Page.getFrameTree')).frameTree.frame
  );
  check();
  return originalSelectionPhases.observe('result', async () => {
    if (final.id !== frameId || final.loaderId !== loaderId || result.exceptionDetails)
      throw new Error('COPY_DOCUMENT_REFUSED');
    if (result.result.type !== 'object') throw new Error('COPY_RESULT_REFUSED');
    const value: unknown = result.result.value;
    if (!value || typeof value !== 'object') throw new Error('COPY_RESULT_REFUSED');
    const row = value as Record<string, unknown>;
    if (
      row.outcome === 'selected' &&
      Object.keys(row).sort().join(',') === 'outcome,text' &&
      typeof row.text === 'string' &&
      row.text.length > 0 &&
      row.text.length <= 2048 &&
      Buffer.byteLength(row.text) <= 2048 &&
      !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(row.text)
    )
      return Object.freeze({ outcome: 'selected', text: row.text });
    if (
      row.outcome === 'refused' &&
      Object.keys(row).sort().join(',') === 'outcome,reason' &&
      typeof row.reason === 'string' &&
      ['secret', 'selection', 'unsupported', 'capacity'].includes(row.reason)
    )
      return Object.freeze({
        outcome: 'refused',
        reason: row.reason as 'secret' | 'selection' | 'unsupported' | 'capacity',
      });
    throw new Error('COPY_RESULT_REFUSED');
  });
}

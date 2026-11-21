import type { CDPSession } from 'playwright-core';
import { classifyRefusal } from '@dorkos/shared/local-browser-refusal';

// Security 49fe52b2: fixed isolated-world expression; caps mean unknown, never a partial safe read.
export const PERSON_SAFETY_EXPRESSION = `(() => {
  const title = document.title;
  if (title.length > 2048 || document.documentElement === null) return null;
  const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
  let text = '';
  let count = 0;
  let node;
  while ((node = walker.nextNode()) !== null) {
    if (++count > 4096) return null;
    const part = node.nodeValue ?? '';
    if (part.length > 16384 - text.length) return null;
    text += part;
  }
  return { title, text };
})()`;

/** A host-only verdict; page strings never escape this function. */
export async function readPersonSafety(
  cdp: Pick<CDPSession, 'send'>,
  assertCurrent: () => void,
  url: string
): Promise<'safe' | 'refused' | 'unknown'> {
  try {
    assertCurrent();
    const tree = await cdp.send('Page.getFrameTree');
    assertCurrent();
    const frameId = tree?.frameTree?.frame?.id;
    if (typeof frameId !== 'string' || !frameId) return 'unknown';
    const world = await cdp.send('Page.createIsolatedWorld', {
      frameId,
      worldName: 'dorkos-person-safety',
      grantUniveralAccess: false,
    });
    assertCurrent();
    if (!Number.isSafeInteger(world?.executionContextId) || world.executionContextId <= 0)
      return 'unknown';
    const answer = await cdp.send('Runtime.evaluate', {
      expression: PERSON_SAFETY_EXPRESSION,
      contextId: world.executionContextId,
      returnByValue: true,
      awaitPromise: false,
      timeout: 500,
    });
    assertCurrent();
    const value: unknown = answer?.result?.value;
    if (answer.exceptionDetails || !value || typeof value !== 'object' || Array.isArray(value))
      return 'unknown';
    const record = value as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, 'title') ||
      !Object.hasOwn(record, 'text') ||
      typeof record.title !== 'string' ||
      typeof record.text !== 'string' ||
      record.title.length > 2048 ||
      record.text.length > 16384
    )
      return 'unknown';
    return classifyRefusal({ url, title: record.title, text: record.text }) ? 'refused' : 'safe';
  } catch {
    return 'unknown';
  }
}

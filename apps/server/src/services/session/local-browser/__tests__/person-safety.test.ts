import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { CDPSession } from 'playwright-core';
import {
  PERSON_SAFETY_EXPRESSION,
  readPersonSafety,
} from '../leases/viewer-control/person-safety.js';

// Independent copy of the expression Security approved at 49fe52b2, not a self-comparison.
const approved = `(() => {
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
function fixture(value: unknown = { title: 'Page', text: 'Ordinary page' }) {
  const send = vi.fn(async (method: string) => {
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
    return { result: { value } };
  });
  return { send, cdp: { send } as unknown as Pick<CDPSession, 'send'> };
}
const url = 'https://example.com';
describe('the fixed held-page safety read', () => {
  it('uses only approved methods and the exact constant in a new isolated world per read', async () => {
    const f = fixture();
    for (let read = 0; read < 2; read++)
      expect(await readPersonSafety(f.cdp, () => undefined, url)).toBe('safe');
    const census = [
      ['Page.getFrameTree'],
      [
        'Page.createIsolatedWorld',
        { frameId: 'main', worldName: 'dorkos-person-safety', grantUniveralAccess: false },
      ],
      [
        'Runtime.evaluate',
        {
          expression: approved,
          contextId: 7,
          returnByValue: true,
          awaitPromise: false,
          timeout: 500,
        },
      ],
    ];
    expect(f.send.mock.calls).toEqual([...census, ...census]);
  });
  it.each([
    null,
    false,
    [],
    { title: 'Page' },
    { title: 1, text: '' },
    { title: '', text: '', extra: true },
    { title: '', text: 1 },
    { title: 'a'.repeat(2049), text: '' },
    { title: '', text: 'a'.repeat(16385) },
  ])('refuses unknown result shapes and bounds: %#', async (value) => {
    expect(await readPersonSafety(fixture(value).cdp, () => undefined, url)).toBe('unknown');
  });
  it('imports the existing refusal policy without returning page content', async () => {
    const f = fixture({ title: 'Couldn’t sign you in', text: '' });
    expect(await readPersonSafety(f.cdp, () => undefined, 'https://accounts.google.com')).toBe(
      'refused'
    );
  });
  it.each([1, 2, 3])(
    'checks the captured generation after await %i before the next method',
    async (at) => {
      const f = fixture();
      const current = () => {
        if (f.send.mock.calls.length >= at) throw Error('navigation');
      };
      expect(await readPersonSafety(f.cdp, current, url)).toBe('unknown');
      expect(f.send).toHaveBeenCalledTimes(at);
    }
  );
  it.each([0, -1, 1.5, '7', undefined])(
    'rejects an unusable isolated context: %s',
    async (executionContextId) => {
      const f = fixture();
      f.send.mockImplementation(async (method) => {
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
        return { executionContextId } as never;
      });
      expect(await readPersonSafety(f.cdp, () => undefined, url)).toBe('unknown');
      expect(f.send).toHaveBeenCalledTimes(2);
    }
  );
  it('drops exceptions even when a plausible value accompanies them', async () => {
    const f = fixture();
    f.send
      .mockResolvedValueOnce({ frameTree: { frame: { id: 'main' } } } as never)
      .mockResolvedValueOnce({ executionContextId: 7 } as never)
      .mockResolvedValueOnce({
        result: { value: { title: '', text: '' } },
        exceptionDetails: {},
      } as never);
    expect(await readPersonSafety(f.cdp, () => undefined, url)).toBe('unknown');
  });
  it.each([
    ['a'.repeat(2049), ['ok']],
    ['', ['a'.repeat(16385)]],
    ['', Array.from({ length: 4097 }, () => '')],
    ['', ['a'.repeat(16384), 'b']],
  ])(
    'returns null rather than truncated content when DOM bounds are exceeded: %#',
    (title, parts) => {
      expect(execute(title, parts)).toBeNull();
    }
  );
  it('accepts the exact UTF-16 and node boundaries', () => {
    const parts = ['a'.repeat(16384), ...Array.from({ length: 4095 }, () => '')];
    expect(execute('a'.repeat(2048), parts)).toEqual({
      title: 'a'.repeat(2048),
      text: 'a'.repeat(16384),
    });
  });
});
function execute(title: string, parts: string[]) {
  let index = 0;
  return runInNewContext(
    PERSON_SAFETY_EXPRESSION,
    {
      document: {
        title,
        documentElement: {},
        createTreeWalker: () => ({
          nextNode: () => (index < parts.length ? { nodeValue: parts[index++] } : null),
        }),
      },
      NodeFilter: { SHOW_TEXT: 4 },
    },
    { timeout: 100 }
  );
}

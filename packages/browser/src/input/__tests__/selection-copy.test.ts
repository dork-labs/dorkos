import { expect, it, vi } from 'vitest';
import type { CDPSession } from 'playwright-core';
import { inspectOriginalSelection, readOriginalSelection } from '../selection-copy.js';
// Controlled DOM getter ports prove inspector ordering; they are not native/clipboard evidence.
function documentField(
  type = 'text',
  auto = 'off',
  value = 'ordinary selection',
  start = 0,
  end = 8
) {
  const getters = { value: vi.fn(() => value), start: vi.fn(() => start), end: vi.fn(() => end) };
  const doc = { hasFocus: () => true } as unknown as Document;
  const field = {
    localName: 'input',
    isConnected: true,
    ownerDocument: doc,
    parentElement: null,
    shadowRoot: null,
    getRootNode: () => doc,
    getAttribute: (name: string) =>
      name === 'type' ? type : name === 'autocomplete' ? auto : null,
  };
  Object.defineProperties(field, {
    value: { get: getters.value },
    selectionStart: { get: getters.start },
    selectionEnd: { get: getters.end },
  });
  Object.defineProperty(doc, 'activeElement', { value: field });
  return { doc, field, getters };
}
it.each([
  { type: 'password', auto: 'off' },
  { type: 'text', auto: 'one-time-code' },
  { type: 'text', auto: 'section-a cc-number' },
  { type: 'file', auto: 'off' },
])('refuses $type/$auto before all original selected/value getters', ({ type, auto }) => {
  const f = documentField(type, auto);
  for (const getter of Object.values(f.getters))
    getter.mockImplementation(() => {
      throw new Error('secret getter invoked');
    });
  expect(inspectOriginalSelection(f.doc)).toEqual({ outcome: 'refused', reason: 'secret' });
  for (const getter of Object.values(f.getters)) expect(getter).not.toHaveBeenCalled();
});
it('returns only the actual bounded selected substring', () => {
  const f = documentField('text', 'off', 'ordinary selection', 9, 18);
  expect(inspectOriginalSelection(f.doc)).toEqual({ outcome: 'selected', text: 'selection' });
  expect(f.getters.value).toHaveBeenCalledTimes(1);
});
it('refuses secret ancestor before original selected/value getters', () => {
  const f = documentField();
  Object.defineProperty(f.field, 'parentElement', {
    value: {
      localName: 'section',
      parentElement: null,
      getAttribute: (name: string) => (name === 'data-sensitive' ? 'true' : null),
    },
  });
  expect(inspectOriginalSelection(f.doc)).toEqual({ outcome: 'refused', reason: 'secret' });
  expect(f.getters.value).not.toHaveBeenCalled();
  expect(f.getters.start).not.toHaveBeenCalled();
});
it('bounds original value bytes without truncation', () => {
  const f = documentField('text', 'off', '😀'.repeat(1025), 0, 2);
  expect(inspectOriginalSelection(f.doc)).toEqual({ outcome: 'refused', reason: 'capacity' });
});
function wire(
  result: unknown = { outcome: 'selected', text: 'ordinary' },
  loader = 'original-document'
) {
  let frames = 0;
  const send = vi.fn(async (method: string, _params?: unknown): Promise<unknown> => {
    if (method === 'Page.getFrameTree')
      return {
        frameTree: {
          frame: { id: 'original-frame', loaderId: ++frames === 1 ? 'original-document' : loader },
        },
      };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 31 };
    return { result: { type: 'object', value: result } };
  });
  return { send, session: { send } as unknown as Pick<CDPSession, 'send'> };
}
it('uses only fixed root-owned commands and original isolated result', async () => {
  const f = wire();
  expect(await readOriginalSelection(f.session, () => undefined)).toEqual({
    outcome: 'selected',
    text: 'ordinary',
  });
  expect(f.send.mock.calls.map((row) => row[0])).toEqual([
    'Page.getFrameTree',
    'Page.createIsolatedWorld',
    'Runtime.evaluate',
    'Page.getFrameTree',
  ]);
  expect(f.send.mock.calls[1][1]).toEqual({
    frameId: 'original-frame',
    worldName: 'dork-owner-selection-copy-v1',
    grantUniveralAccess: false,
  });
});
it('refuses a replaced original document even after successful selection read', async () => {
  const f = wire(undefined, 'replacement');
  await expect(readOriginalSelection(f.session, () => undefined)).rejects.toThrow(
    'COPY_DOCUMENT_REFUSED'
  );
});
it.each([false, undefined])(
  'retains original falsy revocation after held native read: %s',
  async (cause) => {
    const f = wire();
    let release!: (value: unknown) => void;
    const held = new Promise<unknown>((resolve) => {
      release = resolve;
    });
    let entered!: (value: void) => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method) => {
      if (method === 'Runtime.evaluate') {
        entered();
        return held;
      }
      return original(method);
    });
    let current = true;
    const operation = readOriginalSelection(f.session, () => {
      if (!current) throw cause;
    });
    void operation.catch(() => undefined);
    try {
      await ready;
      current = false;
      release({ result: { type: 'object', value: { outcome: 'selected', text: 'ordinary' } } });
      await expect(operation).rejects.toBe(cause);
      expect(f.send.mock.calls.filter((row) => row[0] === 'Page.getFrameTree')).toHaveLength(1);
    } finally {
      release({ result: { type: 'object', value: { outcome: 'refused', reason: 'selection' } } });
      await Promise.allSettled([operation]);
    }
  }
);
it.each([
  { outcome: 'selected', text: '', extra: true },
  { outcome: 'selected', text: 'x'.repeat(2049) },
  { outcome: 'refused', reason: 'invented' },
])('rejects malformed original result %#', async (result) => {
  const f = wire(result);
  await expect(readOriginalSelection(f.session, () => undefined)).rejects.toThrow(
    'COPY_RESULT_REFUSED'
  );
});

it('refuses a secret composed shadow host before original field value/selection getters', () => {
  const f = documentField();
  const host = {
    localName: 'section',
    parentElement: null,
    ownerDocument: f.doc,
    isConnected: true,
    getRootNode: () => f.doc,
    getAttribute: (name: string) => (name === 'data-sensitive' ? 'true' : null),
  };
  Object.defineProperty(f.field, 'getRootNode', { value: () => ({ nodeType: 11, host }) });
  expect(inspectOriginalSelection(f.doc)).toEqual({ outcome: 'refused', reason: 'secret' });
  for (const getter of Object.values(f.getters)) expect(getter).not.toHaveBeenCalled();
});
it('refuses a cyclic composed shadow host before original field value/selection getters', () => {
  const f = documentField();
  Object.defineProperty(f.field, 'getRootNode', { value: () => ({ nodeType: 11, host: f.field }) });
  expect(inspectOriginalSelection(f.doc)).toEqual({ outcome: 'refused', reason: 'capacity' });
  for (const getter of Object.values(f.getters)) expect(getter).not.toHaveBeenCalled();
});

it.each([0, -1, undefined, NaN])(
  'missing/invalid isolated context never falls back to page world: %s',
  async (executionContextId) => {
    const f = wire(),
      original = f.send.getMockImplementation()!;
    f.send.mockImplementation(async (method, params) =>
      method === 'Page.createIsolatedWorld' ? { executionContextId } : original(method, params)
    );
    await expect(readOriginalSelection(f.session, () => undefined)).rejects.toThrow(
      'COPY_DOCUMENT_REFUSED'
    );
    expect(f.send.mock.calls.some((row) => row[0] === 'Runtime.evaluate')).toBe(false);
  }
);

import { describe, expect, it, vi } from 'vitest';
import { dispatchViewerInput } from '../input-dispatch.js';

// Protocol projection only. Broker admission is tested against its real export later.
const allowed = new Set([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.insertText',
  'Input.imeSetComposition',
]);
const events = [
  { kind: 'pointer', type: 'mousePressed', x: 10, y: 20, button: 'left', clickCount: 1 },
  { kind: 'pointer', type: 'mouseReleased', x: 10, y: 20, button: 'left', clickCount: 1 },
  { kind: 'wheel', x: 10, y: 20, deltaX: 0, deltaY: 40 },
  { kind: 'key', type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0 },
  { kind: 'key', type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 },
  { kind: 'touch', type: 'touchStart', points: [{ x: 10, y: 20, id: 1 }] },
  { kind: 'touch', type: 'touchEnd', points: [] },
  { kind: 'text', text: 'made-up text' },
  { kind: 'composition', text: '仮', selectionStart: 1, selectionEnd: 1 },
  { kind: 'composition', text: '', selectionStart: 0, selectionEnd: 0 },
];

describe('fixed viewer input protocol (P1)', () => {
  it('uses only the closed input method list, including release and composition cleanup', async () => {
    const send = vi.fn(async (_method: string, _params: unknown) => ({}));
    for (const event of events) await dispatchViewerInput({ send }, event);
    expect(send).toHaveBeenCalledTimes(events.length);
    expect(new Set(send.mock.calls.map(([method]) => method))).toEqual(allowed);
    for (const [method] of send.mock.calls) expect(allowed.has(method)).toBe(true);
  });

  it.each(['Runtime.evaluate', 'Page.navigate', 'Browser.close', 'DOM.setFileInputFiles'])(
    'refuses a client method name %s before dispatch',
    async (method) => {
      const send = vi.fn(async (_method: string, _params: unknown) => ({}));
      await expect(
        dispatchViewerInput({ send }, { kind: 'cdp', method, params: {} })
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it.each(['method', 'expression', 'functionDeclaration', 'objectId', 'sessionId'])(
    'rejects client %s fields rather than forwarding them to CDP',
    async (field) => {
      const send = vi.fn(async (_method: string, _params: unknown) => ({}));
      await expect(
        dispatchViewerInput({ send }, { kind: 'text', text: 'fixture', [field]: 'PAGE_CANARY' })
      ).rejects.toThrow();
      expect(send).not.toHaveBeenCalled();
    }
  );

  it('treats code-looking insertText content only as data', async () => {
    const send = vi.fn(async (_method: string, _params: unknown) => ({}));
    const text = '"; globalThis.PAGE_CANARY = true; //';
    await dispatchViewerInput({ send }, { kind: 'text', text });
    expect(send).toHaveBeenCalledExactlyOnceWith('Input.insertText', { text });
  });
});

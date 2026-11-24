import { describe, expect, it, vi } from 'vitest';
import { readViewerSelection, selectionExpression } from '../selection-copy.js';
import { runInNewContext } from 'node:vm';

// Protocol unit tests; assertPersonControl must be wired to the real reviewed broker.
function fixture() {
  const readFixedExpression = vi.fn(async (_contextId: number): Promise<unknown> => ({
    result: { value: { text: 'MADE_UP_SELECTION_CANARY', password: false } },
  }));
  const assertPersonControl = vi.fn(() => undefined);
  return { readFixedExpression, assertPersonControl, contextId: 1 };
}

describe('person-only selection copy (P1/P5)', () => {
  it('keeps page-world getter overrides out of the isolated password check', async () => {
    class UtilityInput {
      get type() {
        return 'password';
      }
      get value() {
        return 'PASSWORD_CANARY';
      }
      get selectionStart() {
        return 0;
      }
      get selectionEnd() {
        return 15;
      }
    }
    const active = new UtilityInput();
    class UtilityDocument {
      get activeElement() {
        return active;
      }
    }
    class UtilityWindow {
      getSelection = () => ({ toString: () => 'PASSWORD_CANARY' });
    }
    const mainWorld = {
      getSelection: () => 'PASSWORD_CANARY',
      activeElement: { type: 'text', value: 'PASSWORD_CANARY' },
    };
    const readFixedExpression = vi.fn(async (contextId: number) => {
      const value =
        contextId === 73
          ? runInNewContext(selectionExpression, {
              Document: UtilityDocument,
              document: new UtilityDocument(),
              Window: UtilityWindow,
              window: new UtilityWindow(),
              HTMLInputElement: UtilityInput,
              HTMLTextAreaElement: class {},
              HTMLIFrameElement: class {},
              TextEncoder,
              TextDecoder,
            })
          : { password: false, text: mainWorld.getSelection() };
      return { result: { value } };
    });
    await expect(
      readViewerSelection({ contextId: 73, readFixedExpression, assertPersonControl() {} })
    ).rejects.toThrow('viewer_denied');
    expect(readFixedExpression).toHaveBeenCalledWith(73);
  });

  it('cuts multi-byte text inside the isolated realm before transfer', async () => {
    class UtilityWindow {
      getSelection = () => ({ toString: () => '仮'.repeat(100_000) });
    }
    class UtilityDocument {
      get activeElement() {
        return {};
      }
    }
    let transferred = '';
    const readFixedExpression = vi.fn(async (_contextId: number) => {
      const value = runInNewContext(selectionExpression, {
        Document: UtilityDocument,
        document: new UtilityDocument(),
        Window: UtilityWindow,
        window: new UtilityWindow(),
        HTMLInputElement: class {},
        HTMLTextAreaElement: class {},
        HTMLIFrameElement: class {},
        TextEncoder,
        TextDecoder,
      });
      transferred = value.text;
      return { result: { value } };
    });
    const result = await readViewerSelection({
      contextId: 73,
      readFixedExpression,
      assertPersonControl() {},
    });
    expect(result).toBe('仮'.repeat(21_845));
    expect(Buffer.byteLength(transferred)).toBeLessThanOrEqual(65_536);
    expect(transferred).not.toContain('�');
  });
  it('refuses while the agent holds the page, before a selection read', async () => {
    const f = fixture();
    f.assertPersonControl.mockImplementation(() => {
      throw Error('agent_holds_page');
    });
    await expect(readViewerSelection(f)).rejects.toThrow('agent_holds_page');
    expect(f.readFixedExpression).not.toHaveBeenCalled();
  });

  it('uses one fixed selection expression and returns only the bounded text', async () => {
    const f = fixture();
    expect(await readViewerSelection(f)).toBe('MADE_UP_SELECTION_CANARY');
    expect(f.readFixedExpression).toHaveBeenCalledTimes(1);
    expect(f.readFixedExpression).toHaveBeenCalledExactlyOnceWith(1);
    expect(selectionExpression).not.toContain('MADE_UP_SELECTION_CANARY');
    expect(f.assertPersonControl).toHaveBeenCalledTimes(2);
  });

  it('drops a selection if control changes during the read', async () => {
    const f = fixture();
    f.readFixedExpression.mockImplementation(async () => {
      f.assertPersonControl.mockImplementation(() => {
        throw Error('stale_control');
      });
      return { result: { value: { text: 'MADE_UP_SELECTION_CANARY', password: false } } };
    });
    await expect(readViewerSelection(f)).rejects.toThrow('stale_control');
  });

  it.each([
    ['password focus', { text: 'MADE_UP_PASSWORD', password: true }],
    ['uncertain focus', { text: 'MADE_UP_UNKNOWN_FOCUS', password: null }],
    ['oversized ASCII', { text: 'x'.repeat(65_537), password: false }],
    ['oversized UTF-8', { text: '仮'.repeat(21_846), password: false }],
  ] as const)('refuses %s', async (_label, value) => {
    const f = fixture();
    f.readFixedExpression.mockResolvedValue({ result: { value } });
    await expect(readViewerSelection(f)).rejects.toThrow();
  });
});

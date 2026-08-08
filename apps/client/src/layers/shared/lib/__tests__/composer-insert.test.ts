import { describe, it, expect, vi } from 'vitest';
import { registerComposerInsert, requestComposerInsert } from '../composer-insert';

describe('composer-insert bridge', () => {
  it('reports failure when no composer is mounted', () => {
    expect(requestComposerInsert('@README.md ')).toBe(false);
  });

  it('delivers the text to the registered handler', () => {
    const handler = vi.fn();
    const unregister = registerComposerInsert(handler);

    expect(requestComposerInsert('@README.md ')).toBe(true);
    expect(handler).toHaveBeenCalledWith('@README.md ');

    unregister();
  });

  it('stops delivering after the composer unmounts', () => {
    const handler = vi.fn();
    registerComposerInsert(handler)();

    expect(requestComposerInsert('@README.md ')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps the newest handler when an older one unregisters late', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerComposerInsert(first);
    registerComposerInsert(second);

    // A stale unregister must not tear down the composer that replaced it.
    unregisterFirst();

    expect(requestComposerInsert('@a.ts ')).toBe(true);
    expect(second).toHaveBeenCalledWith('@a.ts ');
    expect(first).not.toHaveBeenCalled();
  });
});

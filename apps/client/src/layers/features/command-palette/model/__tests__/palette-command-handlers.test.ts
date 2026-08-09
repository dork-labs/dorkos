import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  registerPaletteCommandHandler,
  unregisterPaletteCommandHandler,
  runPaletteCommandHandler,
} from '../palette-command-handlers';

/**
 * The registry an extension's `registerCommand()` writes into and the palette
 * reads out of. It was a map nothing read: extensions registered handlers, the
 * palette rendered their rows, and pressing one closed the dialog and did
 * nothing (DOR-1051).
 */
describe('palette command handlers', () => {
  beforeEach(() => {
    // Module-level map; each case cleans up after the ids it claims.
    unregisterPaletteCommandHandler('ext:demo:do-thing');
    unregisterPaletteCommandHandler('ext:demo:other');
  });

  it('runs the handler registered under an action id', () => {
    const handler = vi.fn();
    registerPaletteCommandHandler('ext:demo:do-thing', handler);

    expect(runPaletteCommandHandler('ext:demo:do-thing')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('reports that nothing claimed an unknown action, rather than throwing', () => {
    // The caller needs to tell "an extension handled it" from "nobody did", so
    // the palette can say so instead of failing silently.
    expect(runPaletteCommandHandler('ext:nobody:home')).toBe(false);
  });

  it('stops running a handler once its extension unregisters it', () => {
    const handler = vi.fn();
    registerPaletteCommandHandler('ext:demo:do-thing', handler);
    unregisterPaletteCommandHandler('ext:demo:do-thing');

    expect(runPaletteCommandHandler('ext:demo:do-thing')).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });

  it('keeps one handler per action id — a re-register replaces, never stacks', () => {
    // Extension hot-reload re-registers the same ids. Stacking would run the
    // dead copy from the previous load beside the live one.
    const first = vi.fn();
    const second = vi.fn();
    registerPaletteCommandHandler('ext:demo:do-thing', first);
    registerPaletteCommandHandler('ext:demo:do-thing', second);

    runPaletteCommandHandler('ext:demo:do-thing');

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('keeps different action ids apart', () => {
    const one = vi.fn();
    const two = vi.fn();
    registerPaletteCommandHandler('ext:demo:do-thing', one);
    registerPaletteCommandHandler('ext:demo:other', two);

    runPaletteCommandHandler('ext:demo:other');

    expect(one).not.toHaveBeenCalled();
    expect(two).toHaveBeenCalledTimes(1);
  });
});

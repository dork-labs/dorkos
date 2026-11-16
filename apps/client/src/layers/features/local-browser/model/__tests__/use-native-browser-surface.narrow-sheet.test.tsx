/**
 * @vitest-environment jsdom
 */
// QA's probe: the right panel is a Sheet below 1024px (RightPanelContainer
// overlayOnly), and the page must still show inside it.
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/layers/shared/ui';
import { useNativeBrowserSurface } from '../use-native-browser-surface';

const WINDOW = { x: 0, y: 0, width: 900, height: 800 };
const PANEL = { x: 500, y: 0, width: 400, height: 800 };
const noop = () => {};
let setBounds: ReturnType<typeof vi.fn>;

function Surface() {
  const ref = useRef<HTMLDivElement | null>(null);
  useNativeBrowserSurface(ref, 'conn-1', true, noop);
  return <div ref={ref} data-testid="surface" />;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'setTimeout'] });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  setBounds = vi.fn(() => Promise.resolve());
  (window as unknown as { electronAPI: unknown }).electronAPI = { localBrowser: { setBounds } };
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const box = this.matches('[data-slot$="-overlay"]')
      ? WINDOW
      : this.closest('[role="dialog"]') || this.dataset.testid === 'surface'
        ? PANEL
        : WINDOW;
    return {
      ...box,
      top: box.y,
      left: box.x,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => box,
    } as DOMRect;
  });
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (
    this: HTMLElement
  ) {
    return [this.getBoundingClientRect()] as unknown as DOMRectList;
  });
});

it('shows the page when the browser panel itself is in the narrow-window Sheet', async () => {
  render(
    <Sheet open>
      <SheetContent>
        <SheetTitle>Panel</SheetTitle>
        <SheetDescription>Right panel content.</SheetDescription>
        <Surface />
      </SheetContent>
    </Sheet>
  );
  await act(async () => {
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(16 * 10);
  });
  expect(document.querySelector('[data-slot="sheet-overlay"]')).not.toBeNull();
  expect(setBounds).toHaveBeenLastCalledWith(expect.objectContaining({ visible: true }));
});

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { BrowserPixelPresentation } from '@/layers/entities/browser';
import type { BrowserViewer } from '@dorkos/shared/browser-schemas';
import { ManagedBrowserPointer } from '../ui/ManagedBrowserPointer';

const viewer: BrowserViewer = {
  viewerId: 'viewer_fixture_000000000001',
  binding: {
    browserId: 'browser_fixture_000000001',
    browserGeneration: 1,
    tabId: 'tab_fixture_00000000000001',
    navigationGeneration: 0,
    viewportVersion: 0,
    epoch: 0,
    inputGeneration: 0,
  },
  expiresAt: '2099-01-01T00:00:00.000Z',
};
const presentation = (scale = 2): BrowserPixelPresentation => ({
  frame: {
    viewerId: viewer.viewerId,
    binding: { ...viewer.binding },
    frameId: 'frame_fixture_000000000001',
    sequence: 0,
    width: 1280,
    height: 720,
    format: 'jpeg',
    byteLength: 3,
  },
  geometry: {
    cssViewport: { width: 1280, height: 720 },
    raster: { width: 1280 * scale, height: 720 * scale, format: 'jpeg' },
    scaleX: scale,
    scaleY: scale,
  },
  pointer: { x: 320, y: 360, revision: 7 },
  rasterPointer: { x: 320 * scale, y: 360 * scale, revision: 7 },
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each([1, 2])(
  'places the canonical CSS marker proportionally at %sx without using raster coordinates',
  (scale) => {
    const original = presentation(scale);
    render(<ManagedBrowserPointer presentation={original} viewer={viewer} />);
    const marker = screen.getByTestId('managed-browser-pointer');
    expect(marker.style.left).toBe('25%');
    expect(marker.style.top).toBe('50%');
    expect(marker.parentElement?.getAttribute('aria-hidden')).toBe('true');
    expect(original.pointer).toEqual({ x: 320, y: 360, revision: 7 });
  }
);
it('removes the existing marker on null pointer, missing presentation or lost viewer', () => {
  const original = presentation();
  const { rerender } = render(<ManagedBrowserPointer presentation={original} viewer={viewer} />);
  expect(screen.queryByTestId('managed-browser-pointer')).not.toBeNull();
  for (const props of [
    { presentation: { ...original, pointer: null }, viewer },
    { presentation: undefined, viewer },
    { presentation: original, viewer: undefined },
  ]) {
    rerender(<ManagedBrowserPointer {...props} />);
    expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
  }
});
it('clears queued old metadata for a successor viewer or binding', () => {
  const original = presentation();
  const { rerender } = render(<ManagedBrowserPointer presentation={original} viewer={viewer} />);
  for (const successor of [
    { ...viewer, viewerId: 'viewer_successor_000000001' },
    {
      ...viewer,
      binding: { ...viewer.binding, browserId: 'browser_successor_000000001' },
    },
    { ...viewer, binding: { ...viewer.binding, browserGeneration: 2 } },
    {
      ...viewer,
      binding: { ...viewer.binding, tabId: 'tab_successor_000000000001' },
    },
    { ...viewer, binding: { ...viewer.binding, viewportVersion: 1 } },
    { ...viewer, binding: { ...viewer.binding, inputGeneration: 1 } },
    { ...viewer, binding: { ...viewer.binding, epoch: 1 } },
    { ...viewer, binding: { ...viewer.binding, navigationGeneration: 1 } },
  ]) {
    rerender(<ManagedBrowserPointer presentation={original} viewer={successor} />);
    expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
  }
});
it('refuses an out-of-bounds canonical CSS marker and mismatched geometry', () => {
  const original = presentation();
  const { rerender } = render(<ManagedBrowserPointer presentation={original} viewer={viewer} />);
  for (const invalid of [
    { ...original, pointer: { x: 1280, y: 360, revision: 7 } },
    { ...original, geometry: { ...original.geometry, scaleX: 1 } },
  ]) {
    rerender(<ManagedBrowserPointer presentation={invalid} viewer={viewer} />);
    expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
  }
});
it('clears at original viewer expiry even without a new frame or parent update', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
  render(
    <ManagedBrowserPointer
      presentation={presentation()}
      viewer={{ ...viewer, expiresAt: '2026-10-05T12:00:01.000Z' }}
    />
  );
  expect(screen.queryByTestId('managed-browser-pointer')).not.toBeNull();
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
});

it('clears a marker when expiry passes between render and the passive effect', () => {
  const expires = Date.parse('2026-10-05T12:00:01.000Z');
  let now = expires - 1;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  function ExpireAfterPointerRender() {
    now = expires;
    return null;
  }
  render(
    <>
      <ManagedBrowserPointer
        presentation={presentation()}
        viewer={{ ...viewer, expiresAt: '2026-10-05T12:00:01.000Z' }}
      />
      <ExpireAfterPointerRender />
    </>
  );
  expect(screen.queryByTestId('managed-browser-pointer')).toBeNull();
});

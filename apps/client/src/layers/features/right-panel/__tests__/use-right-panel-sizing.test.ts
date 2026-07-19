/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
  minSizePctFor,
  useRightPanelSizing,
  RIGHT_PANEL_GROUP_ID,
  RIGHT_PANEL_DEFAULT_PCT,
} from '../model/use-right-panel-sizing';

describe('minSizePctFor', () => {
  it('converts the 320px floor into a percentage of the group width', () => {
    // 320 / 1184 ≈ 27.027 → rounded to one decimal
    expect(minSizePctFor(1184)).toBe(27);
    expect(minSizePctFor(1600)).toBe(20);
  });

  it('shrinks the percentage on wide groups — the floor stays 320px', () => {
    expect(minSizePctFor(2400)).toBe(13.3);
  });

  it('caps the minimum at 50% so small windows keep a resize range', () => {
    // 320 / 512 = 62.5% — capped
    expect(minSizePctFor(512)).toBe(50);
    expect(minSizePctFor(640)).toBe(50);
  });

  it('falls back to 20% for an unmeasured group', () => {
    expect(minSizePctFor(0)).toBe(20);
    expect(minSizePctFor(-1)).toBe(20);
  });
});

describe('useRightPanelSizing', () => {
  afterEach(() => {
    document.getElementById('panel-group-fixture')?.remove();
  });

  function mountGroupFixture(width: number) {
    const el = document.createElement('div');
    el.id = 'panel-group-fixture';
    el.setAttribute('data-panel-group-id', RIGHT_PANEL_GROUP_ID);
    Object.defineProperty(el, 'offsetWidth', { value: width });
    document.body.appendChild(el);
    return el;
  }

  it('measures the panel group and derives the pixel-floor minimum', () => {
    mountGroupFixture(1184);

    const { result } = renderHook(() => useRightPanelSizing());

    expect(result.current.minPct).toBe(27);
    expect(result.current.defaultPct).toBe(RIGHT_PANEL_DEFAULT_PCT);
  });

  it('raises the default to the minimum when the floor exceeds it', () => {
    // 320 / 640 = 50% > the 40% default — defaultPct must track the floor so
    // the Panel never receives defaultSize < minSize.
    mountGroupFixture(640);

    const { result } = renderHook(() => useRightPanelSizing());

    expect(result.current.minPct).toBe(50);
    expect(result.current.defaultPct).toBe(50);
  });

  it('keeps the fallback minimum when no panel group exists', () => {
    const { result } = renderHook(() => useRightPanelSizing());

    expect(result.current.minPct).toBe(20);
    expect(result.current.defaultPct).toBe(RIGHT_PANEL_DEFAULT_PCT);
  });
});

// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ComposerOverlayLane } from '../ui/ComposerOverlayLane';

afterEach(cleanup);

/** The lane's own classes, which anchor it to `Composer.Root`'s `relative`. */
const LANE_CLASSES = ['absolute', 'right-0', 'bottom-full', 'left-0', 'mb-2'];

describe('ComposerOverlayLane', () => {
  it('carries exactly the classes that anchor it above the card', () => {
    render(
      <ComposerOverlayLane>
        <span data-testid="child">hi</span>
      </ComposerOverlayLane>
    );

    const lane = screen.getByTestId('child').parentElement!;
    expect([...lane.classList].sort()).toEqual([...LANE_CLASSES].sort());
  });

  it('keeps its own classes and adds the caller class', () => {
    render(
      <ComposerOverlayLane className="lane-extra">
        <span data-testid="child">hi</span>
      </ComposerOverlayLane>
    );

    const lane = screen.getByTestId('child').parentElement!;
    expect([...lane.classList].sort()).toEqual([...LANE_CLASSES, 'lane-extra'].sort());
  });

  it('renders nothing but the lane div — no wrapper, no stacking machinery', () => {
    const { container } = render(
      <ComposerOverlayLane>
        <span data-testid="child">hi</span>
      </ComposerOverlayLane>
    );

    expect(container.childElementCount).toBe(1);
    const lane = container.firstElementChild!;
    expect(lane.tagName).toBe('DIV');
    expect(lane.childElementCount).toBe(1);
  });

  it('stacks children in source order, because source order IS stacking order', () => {
    // The contract both hosts rely on: palettes first, ClearArmedHint last, so
    // the armed-clear pill sits below an open palette rather than across it.
    render(
      <ComposerOverlayLane>
        <span data-testid="palette">palette</span>
        <span data-testid="hint">hint</span>
      </ComposerOverlayLane>
    );

    const palette = screen.getByTestId('palette');
    const hint = screen.getByTestId('hint');

    expect(palette.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hint.compareDocumentPosition(palette) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  });
});

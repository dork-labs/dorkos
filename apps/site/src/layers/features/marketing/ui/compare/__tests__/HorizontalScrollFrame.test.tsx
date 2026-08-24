/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { HorizontalScrollFrame } from '../HorizontalScrollFrame';

const FADE = '[data-testid="comparison-table-fade-end"]';

/** Give jsdom the scroll geometry it never computes on its own. */
function setGeometry(el: Element, { scrollWidth = 0, clientWidth = 0, scrollLeft = 0 }) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollLeft', {
    value: scrollLeft,
    configurable: true,
    writable: true,
  });
}

describe('HorizontalScrollFrame', () => {
  it('shows no cue when everything already fits', () => {
    const { container } = render(
      <HorizontalScrollFrame className="overflow-x-auto">
        <div>fits</div>
      </HorizontalScrollFrame>
    );
    const scroller = container.querySelector('.overflow-x-auto')!;
    setGeometry(scroller, { scrollWidth: 400, clientWidth: 400 });
    fireEvent.scroll(scroller);
    // A cue over content that cannot be reached is worse than no cue (ADR 260725-004456).
    expect(container.querySelector(FADE)).toBeNull();
  });

  it('fades the right edge while content is still hidden there', () => {
    const { container } = render(
      <HorizontalScrollFrame className="overflow-x-auto">
        <div>wide</div>
      </HorizontalScrollFrame>
    );
    const scroller = container.querySelector('.overflow-x-auto')!;
    setGeometry(scroller, { scrollWidth: 736, clientWidth: 340 });
    fireEvent.scroll(scroller);
    expect(container.querySelector(FADE)).toBeTruthy();
  });

  it('drops the cue once the reader reaches the far edge', () => {
    const { container } = render(
      <HorizontalScrollFrame className="overflow-x-auto">
        <div>wide</div>
      </HorizontalScrollFrame>
    );
    const scroller = container.querySelector('.overflow-x-auto')!;
    setGeometry(scroller, { scrollWidth: 736, clientWidth: 340 });
    fireEvent.scroll(scroller);
    expect(container.querySelector(FADE)).toBeTruthy();

    setGeometry(scroller, { scrollWidth: 736, clientWidth: 340, scrollLeft: 396 });
    fireEvent.scroll(scroller);
    expect(container.querySelector(FADE)).toBeNull();
  });

  it('never lets the cue swallow a click meant for the table', () => {
    const { container } = render(
      <HorizontalScrollFrame className="overflow-x-auto">
        <div>wide</div>
      </HorizontalScrollFrame>
    );
    const scroller = container.querySelector('.overflow-x-auto')!;
    setGeometry(scroller, { scrollWidth: 736, clientWidth: 340 });
    fireEvent.scroll(scroller);
    const fade = container.querySelector(FADE)!;
    expect(fade.className).toContain('pointer-events-none');
    expect(fade.getAttribute('aria-hidden')).toBe('true');
  });
});

/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { ScrollThumb } from '../ui/ScrollThumb';

describe('ScrollThumb', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gets a hover treatment on its draggable thumb (batch 06, finding 6.7)', () => {
    // The thumb only ever answered scroll activity with opacity — a pointer
    // moving toward it to grab it got no cue distinguishing it from decorative
    // scroll-position chrome.
    const scrollRef = { current: null };
    const { container } = render(<ScrollThumb scrollRef={scrollRef} />);

    const thumb = container.querySelector('.bg-border');
    expect(thumb).not.toBeNull();
    expect(thumb!.className).toContain('hover:bg-foreground/40');
  });

  it('wakes on pointer enter, resting at opacity 0 until then', () => {
    // A colour class on a fully transparent element is not an affordance —
    // this proves the thumb actually becomes reachable, not just styled.
    //
    // `pointerOver`, not `pointerEnter`: React synthesizes enter/leave from
    // the bubbling over/out pair (see `SidebarZones.damping-seam.test.tsx`),
    // so dispatching the non-bubbling pair directly is a test that would pass
    // against no handler at all.
    const scrollRef = { current: null };
    const { container } = render(<ScrollThumb scrollRef={scrollRef} />);
    const track = container.querySelector('[role="presentation"]');
    const thumb = container.querySelector('.bg-border') as HTMLElement;
    expect(track).not.toBeNull();
    expect(thumb.style.opacity).toBe('0');

    fireEvent.pointerOver(track!, { relatedTarget: document.body });

    expect(thumb.style.opacity).toBe('1');
  });

  it('stays visible while the pointer holds over the track past the fade delay', () => {
    vi.useFakeTimers();
    const scrollRef = { current: null };
    const { container } = render(<ScrollThumb scrollRef={scrollRef} />);
    const track = container.querySelector('[role="presentation"]')!;
    const thumb = container.querySelector('.bg-border') as HTMLElement;

    fireEvent.pointerOver(track, { relatedTarget: document.body });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    // Held past FADE_DELAY_MS (800ms) because the pointer never left — the
    // exact scenario 6.7 was filed for: someone who moved to grab the thumb
    // and is still hovering it a second later.
    expect(thumb.style.opacity).toBe('1');
  });

  it('fades after the pointer leaves the track', () => {
    vi.useFakeTimers();
    const scrollRef = { current: null };
    const { container } = render(<ScrollThumb scrollRef={scrollRef} />);
    const track = container.querySelector('[role="presentation"]')!;
    const thumb = container.querySelector('.bg-border') as HTMLElement;

    fireEvent.pointerOver(track, { relatedTarget: document.body });
    fireEvent.pointerOut(track, { relatedTarget: document.body });
    // Fake timers advance virtual time synchronously, outside any React
    // event or promise — without `act()` the resulting `setVisible(false)`
    // is not guaranteed to have flushed to the DOM before the assertion
    // below reads it.
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(thumb.style.opacity).toBe('0');
  });
});

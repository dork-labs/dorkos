/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ScrollThumb } from '../ui/ScrollThumb';

describe('ScrollThumb', () => {
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
});

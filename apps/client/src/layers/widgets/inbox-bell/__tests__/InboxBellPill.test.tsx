// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { InboxBellPill } from '../ui/InboxBellPill';

afterEach(cleanup);

describe('InboxBellPill', () => {
  // jsdom lays nothing out, so this pins the rule; `chat-mock.spec.ts` measures
  // the badge's box against the bar at 390px.
  it('keeps the phone count inside the 44px square, where the viewport cannot cut it', () => {
    const { container } = render(
      <InboxBellPill tone="neutral" glyph="unread" count={4} label="4 unread" text="unread" />
    );
    const count = container.querySelector('[data-slot="inbox-bell-count"]');
    expect(count).toHaveTextContent('4');
    expect(count).toHaveClass('max-md:top-0.5', 'max-md:right-0.5', 'lg:hidden');
  });
});

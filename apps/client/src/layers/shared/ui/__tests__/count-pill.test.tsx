/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ROOM_MENTION_COUNT_CAP } from '@dorkos/shared/room-schemas';
import { CountPill as SharedCountPill } from '@dork-labs/ui/count-pill';
import { CountPill, MENTION_COUNT_CAP, formatPillCount } from '../count-pill';

// The pill itself is tested in packages/ui. This file holds what only the app knows.
afterEach(cleanup);

describe('the app count pill', () => {
  it('is the shared package pill, not a copy', () => {
    expect(CountPill).toBe(SharedCountPill);
  });

  // The server's "10" means "10 or more", so the honest drawing is 9+.
  it('caps mentions one under where the server stops counting', () => {
    expect(MENTION_COUNT_CAP).toBe(ROOM_MENTION_COUNT_CAP - 1);
    expect(formatPillCount(ROOM_MENTION_COUNT_CAP, MENTION_COUNT_CAP)).toBe('9+');
  });

  it('reads the real number out where it draws the mention cap', () => {
    render(<CountPill count={12} cap={MENTION_COUNT_CAP} label="More than 9 mentions" />);
    expect(screen.getByLabelText('More than 9 mentions')).toHaveTextContent('9+');
  });
});

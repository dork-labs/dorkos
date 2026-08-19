// @vitest-environment jsdom
/**
 * The two sentences a receipt says about somebody ELSE's answer.
 *
 * The named one is the whole of DOR-1355: the server now says who answered, and
 * a card in another window has to use it. The unnamed one is what every install
 * that never learned a name still gets, and it must not regress into a blank or
 * into a guess.
 *
 * Seeded defects, each run and each red before the fix:
 *
 * - Drop the `receipt.resolvedBy` branch from `AskReceiptLine` → the named case
 *   goes red on "Already answered by Ada at", and the unnamed case stays green,
 *   which is exactly the pair that tells the two sentences apart.
 * - Print the name on a receipt this window wrote → "You allowed this" goes red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { AskReceiptLine } from '../ui/AskReceiptLine';

/** 10:02 UTC, printed in whatever locale the test machine runs. */
const RESOLVED_AT = '2026-08-18T10:02:00.000Z';

/** The clock time the component prints for {@link RESOLVED_AT}. */
const CLOCK = new Date(RESOLVED_AT).toLocaleTimeString(undefined, {
  hour: 'numeric',
  minute: '2-digit',
});

afterEach(cleanup);

describe('AskReceiptLine', () => {
  it('names the person the server named', () => {
    render(
      <AskReceiptLine
        receipt={{
          outcome: 'answered',
          resolvedAt: RESOLVED_AT,
          resolvedBy: 'Ada',
          byThisWindow: false,
        }}
      />
    );

    expect(screen.getByRole('status').textContent).toBe(`Already answered by Ada at ${CLOCK}`);
  });

  it('says answered rather than allowed, because the event does not say which', () => {
    // A deny and an allow both arrive as `answered` on the fleet-wide event, so
    // a green "Already allowed by Ada" would be a coin flip printed as a fact.
    render(
      <AskReceiptLine
        receipt={{
          outcome: 'answered',
          resolvedAt: RESOLVED_AT,
          resolvedBy: 'Ada',
          byThisWindow: false,
        }}
      />
    );

    const line = screen.getByRole('status');
    expect(line.textContent).not.toContain('allowed');
    expect(line.dataset.tone).toBe('neutral');
  });

  it('leaves the name out when the server sent none', () => {
    render(
      <AskReceiptLine
        receipt={{ outcome: 'answered', resolvedAt: RESOLVED_AT, byThisWindow: false }}
      />
    );

    expect(screen.getByRole('status').textContent).toBe(`Already answered at ${CLOCK}`);
  });

  it('keeps saying "You allowed this" in the window that answered', () => {
    // The name rides the event to EVERY window, this one included. The window
    // that made the choice knows more than the event does, and says so.
    render(
      <AskReceiptLine
        receipt={{
          outcome: 'answered',
          resolvedAt: RESOLVED_AT,
          resolvedBy: 'Ada',
          byThisWindow: true,
          decision: 'allowed',
        }}
      />
    );

    expect(screen.getByRole('status').textContent).toBe('You allowed this');
  });
});

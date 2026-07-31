// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { feedArticleProps } from '@/layers/shared/model';
import { Feed } from '../feed';

afterEach(cleanup);

/**
 * A feed of nothing in particular.
 *
 * Deliberately not a room: the room timeline is the first adopter of this
 * pattern and is meant not to be the last, so the contract the next one relies
 * on is pinned here, away from anything that knows what a message is.
 */
function Plain({ count = 3, busy }: { count?: number; busy?: boolean }) {
  return (
    <>
      <button type="button">above</button>
      <Feed label="Things" busy={busy}>
        {Array.from({ length: count }, (_, i) => (
          <article key={i} {...feedArticleProps({ index: i + 1, total: count })}>
            thing {i + 1}
          </article>
        ))}
      </Feed>
      <button type="button">below</button>
    </>
  );
}

describe('Feed', () => {
  it('is a named feed', () => {
    render(<Plain />);
    expect(screen.getByRole('feed', { name: 'Things' })).toBeInTheDocument();
  });

  it('says whether it is busy either way, never only when it is', () => {
    render(<Plain busy />);
    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'true');

    cleanup();
    render(<Plain />);
    expect(screen.getByRole('feed')).toHaveAttribute('aria-busy', 'false');
  });

  it('gives every article its place in the set', () => {
    render(<Plain />);

    expect(
      screen.getAllByRole('article').map((a) => [a.ariaPosInSet, a.ariaSetSize, a.tabIndex])
    ).toEqual([
      ['1', '3', 0],
      ['2', '3', 0],
      ['3', '3', 0],
    ]);
  });

  it('moves article to article on Page Down and Page Up, stopping at the ends', () => {
    render(<Plain />);
    const [first, second, third] = screen.getAllByRole('article');

    first!.focus();
    fireEvent.keyDown(first!, { key: 'PageDown' });
    expect(second).toHaveFocus();

    fireEvent.keyDown(second!, { key: 'PageDown' });
    expect(third).toHaveFocus();

    fireEvent.keyDown(third!, { key: 'PageDown' });
    expect(third).toHaveFocus();

    fireEvent.keyDown(third!, { key: 'PageUp' });
    expect(second).toHaveFocus();
  });

  it('leaves the feed for the tab stops around it on Ctrl+End and Ctrl+Home', () => {
    render(<Plain />);
    const middle = screen.getAllByRole('article')[1]!;

    middle.focus();
    fireEvent.keyDown(middle, { key: 'End', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'below' })).toHaveFocus();

    middle.focus();
    fireEvent.keyDown(middle, { key: 'Home', ctrlKey: true });
    expect(screen.getByRole('button', { name: 'above' })).toHaveFocus();
  });

  it('leaves an unmodified Home or End to whatever else wants it', () => {
    // Bare Home and End belong to the surface — a roving group inside an
    // article uses them for its own ends — and only the modified press is a
    // feed command.
    render(<Plain />);
    const middle = screen.getAllByRole('article')[1]!;

    middle.focus();
    expect(fireEvent.keyDown(middle, { key: 'End' })).toBe(true);
    expect(middle).toHaveFocus();
  });
});

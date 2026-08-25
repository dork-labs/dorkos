/**
 * @vitest-environment jsdom
 *
 * An excerpt is TEXT, and this is the file that proves it stays that way
 * (`specs/message-search` §8; `SearchHitSchema.excerpt`'s own contract).
 *
 * `snippet()` wraps matches in `<mark>` and leaves everything else exactly as
 * it was typed. People paste error messages, HTML and half-written tags into
 * chat constantly, so "everything else" routinely contains angle brackets. The
 * one wrong move — assigning the excerpt to `innerHTML` so the marks render
 * without any splitting work — turns every message anybody ever sent into
 * markup this cockpit executes.
 *
 * So the assertions here are about the DOM rather than about the string: no
 * element was created that the excerpt merely described. And the last test
 * plants the defect and watches the same assertion go red, because an
 * assertion that cannot fail proves nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SearchExcerpt } from '../SearchExcerpt';

afterEach(cleanup);

/** A message somebody could really have sent, carrying two attack shapes. */
const HOSTILE = 'I pasted <script>alert(1)</script> and <img src=x onerror=alert(2)> into the room';

describe('rendering a search excerpt', () => {
  it('draws the matched words as marks and the rest as text', () => {
    const { container } = render(<SearchExcerpt excerpt="a pack of <mark>dogs</mark> ran past" />);

    expect(container.textContent).toBe('a pack of dogs ran past');
    const marks = container.querySelectorAll('mark');
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe('dogs');
  });

  it('renders script and image tags in a message as characters, creating no elements', () => {
    const { container } = render(<SearchExcerpt excerpt={`${HOSTILE} <mark>room</mark>`} />);

    // Nothing was built out of the text.
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    // And the person still sees what they wrote, character for character.
    expect(container.textContent).toContain('<script>alert(1)</script>');
    expect(container.textContent).toContain('<img src=x onerror=alert(2)>');
    // The one element that IS built is the highlight, from the marks.
    expect(container.querySelectorAll('mark')).toHaveLength(1);
  });

  it('does not let a hostile excerpt swallow the highlight either', () => {
    // Half-open markup around a mark is the shape most likely to confuse a
    // hand-rolled parser into consuming the marker it was looking for.
    render(<SearchExcerpt excerpt={'<div onclick="x"><mark>needle</mark></div'} />);
    expect(screen.getByText('needle').tagName).toBe('MARK');
  });

  it('seeded defect: the same assertions go red when the excerpt is treated as HTML', () => {
    // The proof that the two tests above discriminate. This is the wrong
    // implementation — one line, and the one somebody reaches for when the
    // marks "just need to render" — rendered against the same input.
    const { container } = render(
      <span dangerouslySetInnerHTML={{ __html: `${HOSTILE} <mark>room</mark>` }} />
    );

    // Both of the checks that pass above now fail: the browser built elements
    // out of a message. (The script does not EXECUTE via innerHTML, which is
    // exactly why this defect is easy to ship — it looks fine on screen.)
    expect(container.querySelector('script')).not.toBeNull();
    expect(container.querySelector('img')).not.toBeNull();
    // And the characters the person typed are gone from the text.
    expect(container.textContent).not.toContain('<script>');
  });
});

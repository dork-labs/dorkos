/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StreamdownMarkdown } from '../StreamdownMarkdown';

/**
 * A README fragment carrying the link shapes a package author can actually
 * write: an ordinary https link, a bare autolink, a `mailto:`, and the three
 * dangerous schemes streamdown's sanitizer is expected to strip.
 *
 * These tests render REAL streamdown (no mock), so they pin the thing that
 * regressed in DOR-1296: `linkSafety` defaults to `{ enabled: true }` inside
 * streamdown, and with it on, streamdown's bundled `a` renders an hrefless
 * `<button>`. Should a streamdown upgrade re-introduce that default path —
 * or should the `a` override ever be dropped from `readmeComponents` — every
 * assertion for a real `<a href>` below fails.
 */
const readme = [
  '[Read the docs](https://example.com/docs)',
  '',
  '<https://autolink.example.com/>',
  '',
  '[Email us](mailto:hi@example.com)',
  '',
  '[js](javascript:alert(1))',
  '',
  '[data](data:text/html;base64,PHNjcmlwdD4=)',
  '',
  '[vb](vbscript:msgbox(1))',
].join('\n');

describe('StreamdownMarkdown links', () => {
  it('renders a README link as a real <a href>, never streamdown’s hrefless <button>', () => {
    const { container } = render(<StreamdownMarkdown content={readme} />);

    const link = container.querySelector('a[href="https://example.com/docs"]');
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe('Read the docs');
    // streamdown's linkSafety default renders `<button type="button">` in the
    // anchor's place; a single one of those means the fix is gone.
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('gives every link a new-tab target and a safe, non-endorsing rel', () => {
    const { container } = render(<StreamdownMarkdown content={readme} />);

    const links = container.querySelectorAll('a');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.getAttribute('target')).toBe('_blank');
      const rel = link.getAttribute('rel') ?? '';
      expect(rel).toContain('noopener');
      expect(rel).toContain('noreferrer');
      // A README is fetched from the package author's own repository, so its
      // links are third-party user content and must not pass dorkos.ai's
      // ranking along.
      expect(rel).toContain('nofollow');
      expect(rel).toContain('ugc');
    }
  });

  it('renders an autolink and a mailto: link as real anchors too', () => {
    const { container } = render(<StreamdownMarkdown content={readme} />);

    expect(container.querySelector('a[href="https://autolink.example.com/"]')).toBeTruthy();
    expect(container.querySelector('a[href="mailto:hi@example.com"]')).toBeTruthy();
  });

  it('still lets streamdown’s sanitizer strip javascript:, data: and vbscript:', () => {
    const { container } = render(<StreamdownMarkdown content={readme} />);

    // The override renders the anchors streamdown hands it; it does not
    // decide which hrefs survive. streamdown sanitizes these away before any
    // component mounts, leaving inert text — asserted, not assumed, because
    // "the sanitizer handles it" is exactly the claim a link-rendering change
    // must not take on faith.
    for (const href of ['javascript:', 'data:', 'vbscript:']) {
      expect(container.querySelector(`a[href^="${href}"]`)).toBeNull();
    }
    expect(container.innerHTML).not.toContain('javascript:alert');
    expect(container.innerHTML).not.toContain('vbscript:msgbox');
    expect(container.innerHTML).not.toContain('base64,PHNjcmlwdD4=');
    // The labels survive as plain text, so the reader still sees what the
    // README said.
    expect(container.textContent).toContain('js');
  });
});

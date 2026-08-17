// @vitest-environment jsdom
/**
 * Links inside a streamed chat answer, drawn by the REAL `streamdown`
 * package rather than the prop-inspecting mock `StreamingText.test.tsx` uses
 * for its own, unrelated assertions. `StreamingText` renders every link
 * through the shared `MarkdownLink` (DOR-1272), same as `MarkdownContent`, so
 * this is the one place chat's actual anchor-vs-button behaviour gets
 * exercised end to end.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { StreamingText } from '../ui/message/StreamingText';

afterEach(() => cleanup());

describe('StreamingText — links stay real anchors under link safety (DOR-1272)', () => {
  it('renders a markdown link as a real `<a href>`, not a button', () => {
    render(<StreamingText content="See [the docs](https://dorkos.ai/docs)" />);

    const link = screen.getByRole('link', { name: 'the docs' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://dorkos.ai/docs');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.queryByRole('button', { name: 'the docs' })).not.toBeInTheDocument();
  });

  it('an unmodified left click opens the safety confirmation before navigating', () => {
    render(<StreamingText content="See [the docs](https://dorkos.ai/docs)" />);
    const link = screen.getByRole('link', { name: 'the docs' });

    const notPrevented = fireEvent.click(link);

    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
  });

  it('a cmd/ctrl-clicked http(s) link is left to the browser', () => {
    render(<StreamingText content="See [the docs](https://dorkos.ai/docs)" />);
    const link = screen.getByRole('link', { name: 'the docs' });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a synthetic middle-click (button 1) on an http(s) link is left to the browser', () => {
    // `event.button !== 0` is the guard's belt-and-braces path, not a real
    // middle-click: browsers fire `auxclick`, not `click`, for a non-primary
    // button, so React's onClick never observes button 1 from an actual
    // middle click. This exercises the synthetic-event guard directly
    // (`fireEvent.click(el, { button: 1 })`) — the only way jsdom can reach
    // it — not real browser `auxclick` dispatch. The full scheme-aware
    // behaviour (http(s) bypasses, everything else still confirms) has its
    // primary coverage in `markdown-content.test.tsx`, which exercises the
    // same shared `MarkdownLink`.
    render(<StreamingText content="See [the docs](https://dorkos.ai/docs)" />);
    const link = screen.getByRole('link', { name: 'the docs' });

    const notPrevented = fireEvent.click(link, { button: 1 });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

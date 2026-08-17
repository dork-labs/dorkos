// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MarkdownContent } from '../markdown-content';

describe('MarkdownContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders markdown text content', () => {
    render(<MarkdownContent content="Hello **world**" />);
    expect(screen.getByText(/world/)).toBeTruthy();
  });

  it('handles empty string gracefully', () => {
    const { container } = render(<MarkdownContent content="" />);
    expect(container.firstElementChild).toBeTruthy();
  });

  it('applies className prop to the container', () => {
    const { container } = render(
      <MarkdownContent content="test" className="text-xs text-blue-800" />
    );
    const host = container.firstElementChild!;
    expect(host.className).toContain('text-xs');
    expect(host.className).toContain('text-blue-800');
  });

  it('carries no `prose` classes, because there is no plugin to make them mean anything', () => {
    // `@tailwindcss/typography` is not a dependency of this app, so `prose`,
    // `prose-sm` and `dark:prose-invert` sat here for a long time generating no
    // CSS at all. Streamdown styles its own output. Pinned so they cannot drift
    // back in on the assumption that they do something.
    const { container } = render(<MarkdownContent content="# Title" />);

    expect(container.querySelector('[class*="prose"]')).toBeNull();
  });

  it('renders links in markdown', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);
    expect(screen.getByText('Slack')).toBeTruthy();
  });

  it('renders code blocks in markdown', () => {
    render(<MarkdownContent content="Run `npm install`" />);
    expect(screen.getByText('npm install')).toBeTruthy();
  });

  it('degrades to the error fallback when the markdown render throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Mimic Streamdown's lazy code-block chunk failing to load: the render
    // throws, and MarkdownContent's boundary must catch it in place.
    vi.doMock('streamdown', () => ({
      Streamdown: () => {
        throw new Error('Failed to fetch dynamically imported module');
      },
    }));
    vi.resetModules();
    const { MarkdownContent: Fresh } = await import('../markdown-content');

    render(
      <Fresh
        content="```ts\nconst x = 1;\n```"
        errorFallback={<p>This README couldn’t be displayed.</p>}
      />
    );
    expect(screen.getByText(/This README couldn/i)).toBeTruthy();
  });
});

describe('MarkdownContent — linkSafety links stay real anchors (DOR-1272)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a real `<a href>`, not a button, when linkSafety is on', () => {
    // Before the fix, Streamdown's own `linkSafety` handling rendered a
    // `<button>` here instead — no `href`, so no hover preview, no
    // cmd/middle-click into a tab, no native "Copy Link Address".
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" linkSafety />);

    const link = screen.getByRole('link', { name: 'Slack' });
    expect(link.tagName).toBe('A');
    // Streamdown's URL transform canonicalizes to a trailing slash.
    expect(link).toHaveAttribute('href', 'https://slack.com/');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.queryByRole('button', { name: 'Slack' })).not.toBeInTheDocument();
  });

  it('an unmodified left click is intercepted for the safety confirmation', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" linkSafety />);
    const link = screen.getByRole('link', { name: 'Slack' });

    // fireEvent.click returns false when a handler called preventDefault.
    const notPrevented = fireEvent.click(link);

    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
  });

  it('a modifier-clicked link is left to the browser — no confirm, no preventDefault', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" linkSafety />);
    const link = screen.getByRole('link', { name: 'Slack' });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a middle-clicked link is left to the browser — no confirm, no preventDefault', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" linkSafety />);
    const link = screen.getByRole('link', { name: 'Slack' });

    // Middle click reports as button 1 on the click event.
    const notPrevented = fireEvent.click(link, { button: 1 });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

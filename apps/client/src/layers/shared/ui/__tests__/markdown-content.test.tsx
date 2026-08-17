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

  it('renders a link with no props beyond content as a real `<a href>`', () => {
    // The default, no-flag call — every `MarkdownContent` caller that never
    // mentions link safety at all (setup guides, config help text) still
    // renders through `MarkdownLink` (DOR-1272 round 2): Streamdown's OWN
    // `linkSafety` defaults to `{ enabled: true }`, so leaving it unmentioned
    // does not opt a caller out of Streamdown's hrefless `<button>` — only
    // `MarkdownLink` does, and it is wired in unconditionally.
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);

    const link = screen.getByRole('link', { name: 'Slack' });
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://slack.com/');
    expect(screen.queryByRole('button', { name: 'Slack' })).not.toBeInTheDocument();
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

describe('MarkdownContent — links stay real anchors, unconditionally (DOR-1272)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders a real `<a href>`, not a button', () => {
    // Before the fix, Streamdown's own `linkSafety` handling rendered a
    // `<button>` here instead — no `href`, so no hover preview, no
    // cmd/middle-click into a tab, no native "Copy Link Address".
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);

    const link = screen.getByRole('link', { name: 'Slack' });
    expect(link.tagName).toBe('A');
    // Streamdown's URL transform canonicalizes to a trailing slash.
    expect(link).toHaveAttribute('href', 'https://slack.com/');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(link.getAttribute('rel')).toContain('noreferrer');
    expect(screen.queryByRole('button', { name: 'Slack' })).not.toBeInTheDocument();
  });

  it('an unmodified left click is intercepted for the safety confirmation', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);
    const link = screen.getByRole('link', { name: 'Slack' });

    // fireEvent.click returns false when a handler called preventDefault.
    const notPrevented = fireEvent.click(link);

    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
  });

  it('confirming closes the modal, not just opens the link', () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);
    const link = screen.getByRole('link', { name: 'Slack' });

    fireEvent.click(link);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /open link/i }));

    expect(openSpy).toHaveBeenCalledWith('https://slack.com/', '_blank', 'noopener,noreferrer');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a modifier-clicked http(s) link is left to the browser — no confirm, no preventDefault', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);
    const link = screen.getByRole('link', { name: 'Slack' });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a middle-clicked http(s) link is left to the browser — no confirm, no preventDefault', () => {
    // `event.button !== 0` is the guard's belt-and-braces path, not a real
    // middle-click: browsers fire `auxclick`, not `click`, for a non-primary
    // button, so React's onClick never observes button 1 from an actual
    // middle click. This exercises the synthetic-event guard directly
    // (`fireEvent.click(el, { button: 1 })`), which is the only way jsdom can
    // reach it — it does not exercise real browser `auxclick` dispatch.
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);
    const link = screen.getByRole('link', { name: 'Slack' });

    const notPrevented = fireEvent.click(link, { button: 1 });

    expect(notPrevented).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('a modifier-clicked non-http(s) link still confirms — no OS handoff with zero warning', () => {
    // `tel:` is one of the schemes Streamdown's own sanitizer still allows
    // through as a real link (`contributing/link-dispatch-policy.md`'s DOR-547
    // section), so it reaches `MarkdownLink` same as an `https:` link would.
    // A cmd-click on it must not skip confirmation: unlike a new browser tab,
    // it would reach the OS's phone-dialer handler with no warning at all.
    render(<MarkdownContent content="Call [support](tel:+15551234567)" />);
    const link = screen.getByRole('link', { name: 'support' });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
  });

  it('a modifier-clicked relative link still confirms — never resolved against the page', () => {
    // A relative or protocol-relative href is exactly what a browser WOULD
    // resolve to same-origin (or a different origin, for `//host/path`) —
    // resolving it here to decide "is this http(s)" would make it look safe
    // to bypass confirmation on. It stays unresolved, so it always confirms.
    render(<MarkdownContent content="See [the page](/relative/path)" />);
    const link = screen.getByRole('link', { name: 'the page' });

    const notPrevented = fireEvent.click(link, { metaKey: true });

    expect(notPrevented).toBe(false);
    expect(screen.getByRole('dialog', { name: /open external link/i })).toBeInTheDocument();
  });
});

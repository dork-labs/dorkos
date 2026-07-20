// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownContent } from '../markdown-content';

describe('MarkdownContent', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders markdown text content', () => {
    render(<MarkdownContent content="Hello **world**" />);
    expect(screen.getByText(/world/)).toBeTruthy();
  });

  it('handles empty string gracefully', () => {
    const { container } = render(<MarkdownContent content="" />);
    expect(container.querySelector('.prose')).toBeTruthy();
  });

  it('applies className prop to the container', () => {
    const { container } = render(
      <MarkdownContent content="test" className="text-xs text-blue-800" />
    );
    const prose = container.querySelector('.prose');
    expect(prose).toBeTruthy();
    expect(prose!.className).toContain('text-xs');
    expect(prose!.className).toContain('text-blue-800');
  });

  it('renders links in markdown', () => {
    render(<MarkdownContent content="Visit [Slack](https://slack.com)" />);
    // streamdown renders links as buttons with data-streamdown="link"
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

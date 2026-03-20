// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MarkdownContent } from '../markdown-content';

describe('MarkdownContent', () => {
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
});

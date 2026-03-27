/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { CanvasUrlContent, isAllowedCanvasUrl } from '../ui/CanvasUrlContent';

afterEach(cleanup);

describe('isAllowedCanvasUrl', () => {
  it('allows https URLs', () => {
    expect(isAllowedCanvasUrl('https://example.com')).toBe(true);
  });

  it('allows http URLs', () => {
    expect(isAllowedCanvasUrl('http://localhost:3000')).toBe(true);
  });

  it('blocks javascript: protocol', () => {
    expect(isAllowedCanvasUrl('javascript:alert(1)')).toBe(false);
  });

  it('blocks data: protocol', () => {
    expect(isAllowedCanvasUrl('data:text/html,<h1>XSS</h1>')).toBe(false);
  });

  it('blocks file: protocol', () => {
    expect(isAllowedCanvasUrl('file:///etc/passwd')).toBe(false);
  });

  it('blocks blob: protocol', () => {
    expect(isAllowedCanvasUrl('blob:http://example.com/abc')).toBe(false);
  });

  it('rejects invalid URLs', () => {
    expect(isAllowedCanvasUrl('not-a-url')).toBe(false);
  });
});

describe('CanvasUrlContent', () => {
  it('renders iframe for an allowed https URL', () => {
    render(
      <CanvasUrlContent content={{ type: 'url', url: 'https://example.com', title: 'Test' }} />
    );
    const iframe = document.querySelector('iframe');
    expect(iframe).toBeInTheDocument();
    expect(iframe).toHaveAttribute('src', 'https://example.com');
    expect(iframe).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-same-origin allow-popups allow-forms'
    );
  });

  it('shows security message for blocked javascript: URL', () => {
    render(<CanvasUrlContent content={{ type: 'url', url: 'javascript:alert(1)' }} />);
    expect(screen.getByText(/cannot be displayed for security reasons/)).toBeInTheDocument();
  });

  it('shows security message for blocked data: URL', () => {
    render(<CanvasUrlContent content={{ type: 'url', url: 'data:text/html,<h1>x</h1>' }} />);
    expect(screen.getByText(/cannot be displayed for security reasons/)).toBeInTheDocument();
  });

  it('uses the custom sandbox attribute when provided', () => {
    render(
      <CanvasUrlContent
        content={{ type: 'url', url: 'https://example.com', sandbox: 'allow-scripts' }}
      />
    );
    const iframe = document.querySelector('iframe');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
  });

  it('uses the title as the iframe title attribute', () => {
    render(
      <CanvasUrlContent content={{ type: 'url', url: 'https://example.com', title: 'My Page' }} />
    );
    const iframe = document.querySelector('iframe');
    expect(iframe).toHaveAttribute('title', 'My Page');
  });

  it('falls back to default iframe title when no title provided', () => {
    render(<CanvasUrlContent content={{ type: 'url', url: 'https://example.com' }} />);
    const iframe = document.querySelector('iframe');
    expect(iframe).toHaveAttribute('title', 'Canvas content');
  });
});

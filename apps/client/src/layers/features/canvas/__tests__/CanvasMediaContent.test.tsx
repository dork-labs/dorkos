/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// Mutable mock store + transport: the media components read selectedCwd via a
// selector and call transport.mediaUrl to resolve local paths.
const mockState = { selectedCwd: '/work' as string | null };
const mediaUrl = vi.fn(
  (cwd: string, p: string): string | null => `/api/files/raw?cwd=${cwd}&path=${p}`
);

vi.mock('@/layers/shared/model', () => {
  const useAppStore = (selector: (s: typeof mockState) => unknown) => selector(mockState);
  return { useAppStore, useTransport: () => ({ mediaUrl }) };
});

import { CanvasImageContent } from '../ui/CanvasImageContent';
import { CanvasPdfContent } from '../ui/CanvasPdfContent';

beforeEach(() => {
  mockState.selectedCwd = '/work';
  mediaUrl.mockClear();
});
afterEach(cleanup);

describe('CanvasImageContent', () => {
  it('renders an https image with alt text and a full-size link', () => {
    render(
      <CanvasImageContent
        content={{ type: 'image', src: 'https://example.com/a.png', alt: 'A picture' }}
      />
    );
    const img = screen.getByRole('img', { name: 'A picture' });
    expect(img).toHaveAttribute('src', 'https://example.com/a.png');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', 'https://example.com/a.png');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('resolves a local path through the transport media URL', () => {
    render(<CanvasImageContent content={{ type: 'image', src: 'assets/logo.png' }} />);
    expect(mediaUrl).toHaveBeenCalledWith('/work', 'assets/logo.png');
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', '/api/files/raw?cwd=/work&path=assets/logo.png');
  });

  it('falls back to the title, then a default, for alt text', () => {
    const { rerender } = render(
      <CanvasImageContent content={{ type: 'image', src: 'https://x/a.png', title: 'Titled' }} />
    );
    expect(screen.getByRole('img', { name: 'Titled' })).toBeInTheDocument();
    rerender(<CanvasImageContent content={{ type: 'image', src: 'https://x/a.png' }} />);
    expect(screen.getByRole('img', { name: 'Canvas image' })).toBeInTheDocument();
  });

  it('shows a security message for a blocked source', () => {
    render(<CanvasImageContent content={{ type: 'image', src: 'javascript:alert(1)' }} />);
    expect(screen.getByText(/can't be displayed for security reasons/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows an error state when the image fails to load', () => {
    render(<CanvasImageContent content={{ type: 'image', src: 'https://x/broken.png' }} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText(/couldn.t be loaded/i)).toBeInTheDocument();
  });

  it('reports local files as unavailable when the transport cannot serve them', () => {
    mediaUrl.mockReturnValueOnce(null);
    render(<CanvasImageContent content={{ type: 'image', src: 'assets/logo.png' }} />);
    expect(screen.getByText(/local image files can't be displayed here/i)).toBeInTheDocument();
  });
});

describe('CanvasPdfContent', () => {
  it('renders the native viewer object for an https PDF', () => {
    render(
      <CanvasPdfContent content={{ type: 'pdf', src: 'https://x/doc.pdf', title: 'Report' }} />
    );
    const obj = document.querySelector('object');
    expect(obj).toHaveAttribute('data', 'https://x/doc.pdf');
    expect(obj).toHaveAttribute('type', 'application/pdf');
    // Fallback open link for viewers that can't render inline.
    expect(screen.getByRole('link', { name: /open report in a new tab/i })).toHaveAttribute(
      'href',
      'https://x/doc.pdf'
    );
  });

  it('resolves a local PDF path through the transport media URL', () => {
    render(<CanvasPdfContent content={{ type: 'pdf', src: 'docs/spec.pdf' }} />);
    expect(mediaUrl).toHaveBeenCalledWith('/work', 'docs/spec.pdf');
    expect(document.querySelector('object')).toHaveAttribute(
      'data',
      '/api/files/raw?cwd=/work&path=docs/spec.pdf'
    );
  });

  it('rejects a non-pdf data URI', () => {
    render(<CanvasPdfContent content={{ type: 'pdf', src: 'data:text/html,<h1>x</h1>' }} />);
    expect(screen.getByText(/isn.t a valid pdf source/i)).toBeInTheDocument();
    expect(document.querySelector('object')).not.toBeInTheDocument();
  });
});

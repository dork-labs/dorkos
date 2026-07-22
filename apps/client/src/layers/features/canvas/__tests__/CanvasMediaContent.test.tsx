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
import { CanvasAudioContent } from '../ui/CanvasAudioContent';
import { CanvasVideoContent } from '../ui/CanvasVideoContent';

beforeEach(() => {
  mockState.selectedCwd = '/work';
  mediaUrl.mockClear();
});
afterEach(cleanup);

describe('CanvasImageContent', () => {
  it('renders an https image with alt text inside a zoom/pan surface', () => {
    render(
      <CanvasImageContent
        content={{ type: 'image', src: 'https://example.com/a.png', alt: 'A picture' }}
      />
    );
    const img = screen.getByRole('img', { name: 'A picture' });
    expect(img).toHaveAttribute('src', 'https://example.com/a.png');
    // In-canvas zoom/pan replaces the old open-in-new-tab link.
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /reset zoom/i })).toBeInTheDocument();
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

  it('renders an SVG data URI inline', () => {
    const svgUri = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>';
    render(<CanvasImageContent content={{ type: 'image', src: svgUri, alt: 'Vector' }} />);
    expect(screen.getByRole('img', { name: 'Vector' })).toHaveAttribute('src', svgUri);
  });

  it('shows an error state when the image fails to load', () => {
    render(<CanvasImageContent content={{ type: 'image', src: 'https://x/broken.png' }} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText(/couldn.t be loaded/i)).toBeInTheDocument();
  });

  it('recovers from an error when update_canvas swaps in a new src', () => {
    const { rerender } = render(
      <CanvasImageContent content={{ type: 'image', src: 'https://x/broken.png' }} />
    );
    fireEvent.error(screen.getByRole('img'));
    expect(screen.getByText(/couldn.t be loaded/i)).toBeInTheDocument();

    // Same component instance (not keyed by src) receives a valid replacement.
    rerender(<CanvasImageContent content={{ type: 'image', src: 'https://x/fixed.png' }} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('src', 'https://x/fixed.png');
    expect(screen.queryByText(/couldn.t be loaded/i)).not.toBeInTheDocument();
    expect(screen.getByText(/loading image/i)).toBeInTheDocument();

    fireEvent.load(img);
    expect(img).toHaveClass('opacity-100');
    expect(screen.queryByText(/loading image/i)).not.toBeInTheDocument();
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

describe('CanvasAudioContent', () => {
  it('renders a native audio player with controls and a label', () => {
    render(
      <CanvasAudioContent content={{ type: 'audio', src: 'https://x/theme.mp3', title: 'Theme' }} />
    );
    const audio = document.querySelector('audio');
    expect(audio).toHaveAttribute('src', 'https://x/theme.mp3');
    expect(audio).toHaveAttribute('controls');
    expect(audio).toHaveAttribute('aria-label', 'Theme');
  });

  it('resolves a local audio path through the transport media URL', () => {
    render(<CanvasAudioContent content={{ type: 'audio', src: 'sounds/beep.wav' }} />);
    expect(mediaUrl).toHaveBeenCalledWith('/work', 'sounds/beep.wav');
    expect(document.querySelector('audio')).toHaveAttribute(
      'src',
      '/api/files/raw?cwd=/work&path=sounds/beep.wav'
    );
  });

  it('falls back to a default label when no title', () => {
    render(<CanvasAudioContent content={{ type: 'audio', src: 'https://x/a.mp3' }} />);
    expect(document.querySelector('audio')).toHaveAttribute('aria-label', 'Canvas audio');
  });

  it('shows a graceful message for a blocked source', () => {
    render(<CanvasAudioContent content={{ type: 'audio', src: 'javascript:alert(1)' }} />);
    expect(screen.getByText(/can.t be played here/i)).toBeInTheDocument();
    expect(document.querySelector('audio')).not.toBeInTheDocument();
  });

  it('shows a graceful message when the transport cannot serve a local file', () => {
    mediaUrl.mockReturnValueOnce(null);
    render(<CanvasAudioContent content={{ type: 'audio', src: 'sounds/beep.wav' }} />);
    expect(screen.getByText(/can.t be played here/i)).toBeInTheDocument();
    expect(document.querySelector('audio')).not.toBeInTheDocument();
  });
});

describe('CanvasVideoContent', () => {
  it('renders a native video player with controls and a label', () => {
    render(
      <CanvasVideoContent content={{ type: 'video', src: 'https://x/demo.mp4', title: 'Demo' }} />
    );
    const video = document.querySelector('video');
    expect(video).toHaveAttribute('src', 'https://x/demo.mp4');
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('aria-label', 'Demo');
  });

  it('resolves a local video path through the transport media URL', () => {
    render(<CanvasVideoContent content={{ type: 'video', src: 'clips/demo.webm' }} />);
    expect(mediaUrl).toHaveBeenCalledWith('/work', 'clips/demo.webm');
    expect(document.querySelector('video')).toHaveAttribute(
      'src',
      '/api/files/raw?cwd=/work&path=clips/demo.webm'
    );
  });

  it('falls back to a default label when no title', () => {
    render(<CanvasVideoContent content={{ type: 'video', src: 'https://x/v.mp4' }} />);
    expect(document.querySelector('video')).toHaveAttribute('aria-label', 'Canvas video');
  });

  it('shows a graceful message for a blocked source', () => {
    render(<CanvasVideoContent content={{ type: 'video', src: 'file:///etc/passwd' }} />);
    expect(screen.getByText(/can.t be played here/i)).toBeInTheDocument();
    expect(document.querySelector('video')).not.toBeInTheDocument();
  });
});

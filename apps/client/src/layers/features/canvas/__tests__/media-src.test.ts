import { describe, it, expect } from 'vitest';
import { resolveCanvasMediaSrc, canvasMediaErrorMessage } from '../lib/media-src';

/** A local-URL builder that always succeeds, tagging the path it was given. */
const served = (p: string) => `/api/files/raw?cwd=/w&path=${p}`;
/** A local-URL builder standing in for a transport that can't serve local files. */
const unavailable = () => null;

describe('resolveCanvasMediaSrc', () => {
  it('passes through https and http URLs unchanged', () => {
    expect(resolveCanvasMediaSrc('https://example.com/a.png', 'image', served)).toEqual({
      url: 'https://example.com/a.png',
      error: null,
    });
    expect(resolveCanvasMediaSrc('http://localhost/a.png', 'image', served).url).toBe(
      'http://localhost/a.png'
    );
  });

  it('allows an image data URI for the image kind', () => {
    const src = 'data:image/png;base64,AAAA';
    expect(resolveCanvasMediaSrc(src, 'image', served)).toEqual({ url: src, error: null });
  });

  it('allows a pdf data URI for the pdf kind', () => {
    const src = 'data:application/pdf;base64,AAAA';
    expect(resolveCanvasMediaSrc(src, 'pdf', served)).toEqual({ url: src, error: null });
  });

  it('rejects a mismatched data URI (html in a pdf frame)', () => {
    const res = resolveCanvasMediaSrc('data:text/html,<h1>x</h1>', 'pdf', served);
    expect(res).toEqual({ url: null, error: 'unsupported-data' });
  });

  it('rejects an html data URI for the image kind', () => {
    const res = resolveCanvasMediaSrc('data:text/html,<script>1</script>', 'image', served);
    expect(res.error).toBe('unsupported-data');
  });

  it('blocks dangerous schemes', () => {
    for (const src of ['javascript:alert(1)', 'file:///etc/passwd', 'blob:http://x/abc']) {
      expect(resolveCanvasMediaSrc(src, 'image', served)).toEqual({ url: null, error: 'blocked' });
    }
  });

  it('serves a scheme-less local path through the confined route', () => {
    expect(resolveCanvasMediaSrc('assets/logo.png', 'image', served)).toEqual({
      url: '/api/files/raw?cwd=/w&path=assets/logo.png',
      error: null,
    });
  });

  it('treats a Windows drive path as local, not a URL scheme', () => {
    const res = resolveCanvasMediaSrc('C:\\Users\\me\\pic.png', 'image', served);
    expect(res.url).toBe('/api/files/raw?cwd=/w&path=C:\\Users\\me\\pic.png');
    expect(res.error).toBeNull();
  });

  it('reports local-unavailable when the transport cannot serve local files', () => {
    expect(resolveCanvasMediaSrc('assets/logo.png', 'image', unavailable)).toEqual({
      url: null,
      error: 'local-unavailable',
    });
  });
});

describe('canvasMediaErrorMessage', () => {
  it('produces a kind-specific message for each error', () => {
    expect(canvasMediaErrorMessage('blocked', 'pdf')).toMatch(/pdf source/i);
    expect(canvasMediaErrorMessage('unsupported-data', 'image')).toMatch(/data uri/i);
    expect(canvasMediaErrorMessage('local-unavailable', 'image')).toMatch(/local image/i);
  });
});

/**
 * The resolver behind the canvas viewers that stream or fetch their bytes —
 * video, audio, CSV, 3D. Its `src` is agent-supplied.
 *
 * The video and audio viewers put the resolved URL in an `<a href>` (the
 * `<video>`/`<audio>` fallback "Download" link) as well as on the element, so
 * they pass a media-kind `data:` prefix the way `media-src.ts` does for images
 * and PDFs. A `data:text/html` source is a legitimate thing for a `<video>` to
 * fail to play; it is not a thing to offer as a link (DOR-924).
 */
import { describe, it, expect } from 'vitest';
import { resolveCanvasFetchUrl } from '../lib/fetch-src';

const toLocal = (p: string) => `/api/media?path=${encodeURIComponent(p)}`;

describe('resolveCanvasFetchUrl', () => {
  it('passes remote http(s) sources straight through', () => {
    expect(resolveCanvasFetchUrl('https://cdn.example/clip.mp4', toLocal).url).toBe(
      'https://cdn.example/clip.mp4'
    );
  });

  it('routes a bare path through the cwd-confined media URL', () => {
    expect(resolveCanvasFetchUrl('clips/demo.mp4', toLocal).url).toBe(
      '/api/media?path=clips%2Fdemo.mp4'
    );
  });

  it.each(['javascript:alert(1)', 'file:///etc/passwd', 'blob:http://localhost/9f', 'vbscript:x'])(
    'rejects the explicit scheme %s',
    (src) => {
      expect(resolveCanvasFetchUrl(src, toLocal).url).toBeNull();
    }
  );

  it('accepts any data: URI when no media kind is named', () => {
    // The CSV and 3D viewers fetch the bytes and never build an anchor.
    expect(resolveCanvasFetchUrl('data:text/csv,a%2Cb', toLocal).url).toBe('data:text/csv,a%2Cb');
  });

  it('accepts a data: URI matching the media kind that asked for one', () => {
    expect(resolveCanvasFetchUrl('data:video/mp4;base64,AAAA', toLocal, 'data:video/').url).toBe(
      'data:video/mp4;base64,AAAA'
    );
    expect(resolveCanvasFetchUrl('data:audio/mpeg;base64,AAAA', toLocal, 'data:audio/').url).toBe(
      'data:audio/mpeg;base64,AAAA'
    );
  });

  it('refuses a data: URI of the wrong kind, which is the one that reaches an href', () => {
    expect(
      resolveCanvasFetchUrl('data:text/html,<script>alert(1)</script>', toLocal, 'data:video/').url
    ).toBeNull();
    expect(
      resolveCanvasFetchUrl('data:text/html,<script>alert(1)</script>', toLocal, 'data:audio/').url
    ).toBeNull();
  });
});

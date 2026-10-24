/**
 * The injector's self-check on its own scripts (DOR-3131): a `<!--` or a
 * `</script` in the fixed source could swallow the page's own end tag, so such
 * a build refuses every page rather than corrupt one.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../canvas/doc-frame-shim.js', () => ({
  DOC_FRAME_SHIM_SCRIPT: 'window.a = 1; // <!-- an opener in our own source',
}));

import { injectFrameScripts } from '../frame-inject.js';

describe('a fixed script that fails its self-check', () => {
  it('refuses with fixed-source and keeps the page as it was', () => {
    const raw = Buffer.from('<html><head></head><body></body></html>');
    const result = injectFrameScripts(raw, {
      contentType: 'text/html; charset=utf-8',
      enforcingPolicies: [],
    });
    expect(result.reason).toBe('fixed-source');
    expect(result.instrumented).toBe(false);
    expect(result.bytes).toBe(raw);
  });
});

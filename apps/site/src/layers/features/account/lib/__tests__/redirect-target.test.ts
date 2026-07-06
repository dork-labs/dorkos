import { describe, expect, it } from 'vitest';

import { DEFAULT_RETURN_TO, safeReturnTo } from '../redirect-target';

describe('safeReturnTo', () => {
  it('keeps a same-origin absolute path', () => {
    expect(safeReturnTo('/account/instances')).toBe('/account/instances');
  });

  it('falls back to the default when the value is missing', () => {
    expect(safeReturnTo(undefined)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo(null)).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('')).toBe(DEFAULT_RETURN_TO);
  });

  it('rejects open-redirect targets (absolute URLs and protocol-relative paths)', () => {
    expect(safeReturnTo('https://evil.example/steal')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('//evil.example')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('javascript:alert(1)')).toBe(DEFAULT_RETURN_TO);
  });

  it('rejects backslash and control-char open-redirect tricks', () => {
    // WHATWG URL treats `\` as `/` and strips tab/newline, so these would resolve
    // cross-origin (e.g. `new URL('/\\evil.example', base).origin === evil).
    expect(safeReturnTo('/\\evil.example')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/\t/evil.example')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/\\/evil.example')).toBe(DEFAULT_RETURN_TO);
    expect(safeReturnTo('/\r\nSet-Cookie:x')).toBe(DEFAULT_RETURN_TO);
  });

  it('preserves query and hash on a same-origin path', () => {
    expect(safeReturnTo('/account/instances?tab=linked#top')).toBe(
      '/account/instances?tab=linked#top'
    );
  });
});

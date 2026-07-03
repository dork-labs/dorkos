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
});

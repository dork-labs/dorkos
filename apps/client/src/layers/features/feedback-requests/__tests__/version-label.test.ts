import { describe, expect, it } from 'vitest';

import { formatShippedVersionLabel } from '../lib/version-label';

describe('formatShippedVersionLabel', () => {
  it('prefixes v for a bare version', () => {
    expect(formatShippedVersionLabel('0.56.3')).toBe('v0.56.3');
    expect(formatShippedVersionLabel('1.2')).toBe('v1.2');
    expect(formatShippedVersionLabel('12.0.1-beta')).toBe('v12.0.1-beta');
  });

  it('renders a milestone/cycle name verbatim, no v prefix', () => {
    expect(formatShippedVersionLabel('Cycle 12')).toBe('Cycle 12');
    expect(formatShippedVersionLabel('Q3 push')).toBe('Q3 push');
  });

  it('does not prefix a value that merely contains digits without the major.minor shape', () => {
    expect(formatShippedVersionLabel('Sprint 4')).toBe('Sprint 4');
  });
});

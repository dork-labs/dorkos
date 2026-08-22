import { describe, expect, it } from 'vitest';
import { basename } from '../basename';

describe('basename', () => {
  it('reads a basename on either separator', () => {
    expect(basename('/repos/dorkos')).toBe('dorkos');
    expect(basename('C:\\code\\dorkos')).toBe('dorkos');
    expect(basename('/repos/dorkos//')).toBe('dorkos');
    expect(basename('dorkos')).toBe('dorkos');
  });

  it('leaves a path with no segment to take alone', () => {
    expect(basename('')).toBe('');
    expect(basename('/')).toBe('');
  });
});

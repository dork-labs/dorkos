import { describe, it, expect } from 'vitest';
import { cn } from '../utils';

describe('cn', () => {
  it('treats text-control as a font size: it keeps the colour and replaces the old size', () => {
    expect(cn('text-muted-foreground text-xs', 'text-control')).toBe(
      'text-muted-foreground text-control'
    );
    expect(cn('text-control', 'text-sm')).toBe('text-sm');
  });

  it('still resolves colours against colours', () => {
    expect(cn('text-control text-muted-foreground', 'text-brand-text')).toBe(
      'text-control text-brand-text'
    );
  });
});

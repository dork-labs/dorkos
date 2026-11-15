// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Kbd } from '../kbd';

describe('Kbd', () => {
  it('renders as a kbd element', () => {
    render(<Kbd>Esc</Kbd>);
    const el = screen.getByText('Esc');
    expect(el.tagName).toBe('KBD');
  });

  it('has hidden md:inline-flex classes by default', () => {
    render(<Kbd>X</Kbd>);
    const el = screen.getByText('X');
    expect(el.className).toContain('hidden');
    expect(el.className).toContain('md:inline-flex');
  });
});

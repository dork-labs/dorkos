// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Kbd } from '../kbd';

describe('Kbd', () => {
  it('renders children text', () => {
    render(<Kbd>Enter</Kbd>);
    expect(screen.getByText('Enter')).toBeTruthy();
  });

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

  it('merges custom className', () => {
    render(<Kbd className="text-red-500">K</Kbd>);
    const el = screen.getByText('K');
    expect(el.className).toContain('text-red-500');
    expect(el.className).toContain('font-mono');
  });

  it('passes through data attributes', () => {
    render(<Kbd data-testid="my-kbd">Tab</Kbd>);
    expect(screen.getByTestId('my-kbd')).toBeTruthy();
  });
});

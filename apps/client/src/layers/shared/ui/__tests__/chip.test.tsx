/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createRef } from 'react';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Filter } from 'lucide-react';
import '@testing-library/jest-dom/vitest';
import { Chip } from '../chip';

afterEach(cleanup);

describe('Chip', () => {
  it('is a button that does what it says', async () => {
    const onClick = vi.fn();
    render(<Chip onClick={onClick}>Retry</Chip>);
    const chip = screen.getByRole('button', { name: 'Retry' });
    expect(chip).toHaveAttribute('type', 'button');
    await userEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  // A Radix trigger needs the ref.
  it('forwards its ref', () => {
    const ref = createRef<HTMLButtonElement>();
    render(<Chip ref={ref}>Open</Chip>);
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Open' }));
  });

  it('rests on the tint and steps to 11% on hover', () => {
    render(<Chip>Rest</Chip>);
    const chip = screen.getByRole('button', { name: 'Rest' });
    expect(chip).toHaveClass('bg-foreground/7', 'text-muted-foreground', 'hover:bg-foreground/11');
    expect(chip).toHaveClass('rounded-full', 'focus-ring');
    // An action chip has no state to announce.
    expect(chip).not.toHaveAttribute('aria-pressed');
  });

  // Inverted, not a darker tint, so selection is never colour-only.
  it('inverts when pressed and announces it', () => {
    const { rerender } = render(<Chip pressed={false}>Failing</Chip>);
    const chip = screen.getByRole('button', { name: 'Failing' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    rerender(<Chip pressed>Failing</Chip>);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(chip).toHaveClass('bg-foreground', 'text-background');
    expect(chip).not.toHaveClass('bg-foreground/7');
  });

  it('presses with the chip step, only when motion is welcome', () => {
    render(<Chip>Press</Chip>);
    expect(screen.getByRole('button', { name: 'Press' })).toHaveClass(
      'motion-safe:active:scale-[0.98]'
    );
  });

  it('is 24px on a desktop and 40 with a 44px hit area on a phone at sm; 32 and 44 at md', () => {
    render(
      <>
        <Chip>Small</Chip>
        <Chip size="md">Medium</Chip>
      </>
    );
    const sm = screen.getByRole('button', { name: 'Small' });
    expect(sm).toHaveClass('h-6', 'max-md:h-10', 'max-md:after:-inset-y-0.5');
    const md = screen.getByRole('button', { name: 'Medium' });
    expect(md).toHaveClass('h-8', 'max-md:h-11');
  });

  it('draws its glyph hidden from a screen reader and truncates long words', () => {
    render(
      <Chip icon={Filter} iconClassName="text-status-error-fg">
        A very long filter name
      </Chip>
    );
    const chip = screen.getByRole('button', { name: 'A very long filter name' });
    const icon = chip.querySelector('svg');
    expect(icon).toHaveAttribute('aria-hidden', 'true');
    expect(icon).toHaveClass('text-status-error-fg');
    expect(screen.getByText('A very long filter name')).toHaveClass('truncate', 'max-w-56');
  });
});

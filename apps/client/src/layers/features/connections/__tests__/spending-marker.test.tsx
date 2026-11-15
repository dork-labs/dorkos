/**
 * The "Spends money" marker and the Spending bar (DOR-4204 spec 1.0 §6, §10,
 * §11): fail-first #11, the marker is words and an icon, never colour alone,
 * and the chip's lone icon has a name; and #13, the bar never animates its
 * first paint and never moves under reduced motion.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { PaidActionMarker } from '@/layers/entities/connectors';
import { SpendingBar } from '../ui/spending/SpendingBar';

afterEach(cleanup);

describe('the Spends money marker (fail-first #11)', () => {
  it('says it in words beside an icon, in a muted tone', () => {
    const { container } = render(<PaidActionMarker />);
    const marker = container.querySelector('[data-slot="paid-action-marker"]');
    expect(marker).toHaveTextContent('Spends money');
    expect(marker?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(marker?.className).toContain('text-muted-foreground');
    expect(marker?.className).not.toMatch(/warning|destructive|orange|red/);
  });

  it('names its icon when the icon stands alone on a chip', () => {
    render(<PaidActionMarker variant="icon" />);
    expect(screen.getByRole('img', { name: 'spends money' })).toBeInTheDocument();
  });

  it('carries the legend line in words', () => {
    render(<PaidActionMarker variant="line" label="Actions marked with coins spend money." />);
    expect(screen.getByText('Actions marked with coins spend money.')).toBeVisible();
  });
});

describe('the Spending bar (fail-first #13)', () => {
  it('arrives drawn, and moves only once its value changes, never under reduced motion', () => {
    const { rerender } = render(<SpendingBar percent={31} valueText="$12.40 of $40.00 used" />);
    const fill = () => document.querySelector('[data-slot="spending-bar-fill"]');
    expect(fill()?.className).not.toContain('transition');
    expect(fill()).toHaveStyle({ transform: 'scaleX(0.31)' });
    rerender(<SpendingBar percent={50} valueText="$20.00 of $40.00 used" />);
    expect(fill()?.className).toContain('transition-transform');
    expect(fill()?.className).toContain('motion-reduce:transition-none');
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '$20.00 of $40.00 used'
    );
  });
});

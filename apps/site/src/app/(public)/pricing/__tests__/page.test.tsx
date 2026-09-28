/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import PricingPage from '../page';

const TAX_LINE =
  'Prices are in US dollars. Sales tax or VAT is added at checkout where it applies.';

describe('the pricing page says what the price does not include', () => {
  it('says it beside the plan cards, under the price note', () => {
    render(<PricingPage />);
    const plans = screen.getByRole('region', { name: 'Plans' });
    const note = within(plans).getByText(/^Every price on this page applies from/);
    expect(note.textContent).toContain(TAX_LINE);
  });

  it('answers it in the questions', () => {
    const { container } = render(<PricingPage />);
    const faq = container.querySelector('#faq');
    expect(faq).not.toBeNull();
    const question = within(faq as HTMLElement).getByText('Is tax included?');
    expect(question.nextElementSibling?.textContent).toBe(TAX_LINE);
  });
});

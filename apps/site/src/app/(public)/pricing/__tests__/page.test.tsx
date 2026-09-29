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

const ELIGIBILITY_LINE =
  'Paid plans and communities we host for you are for people in the United States who are 18 or older. The free, open-source app is open to everyone, wherever they live, and so is running DorkOS or a community on your own computer or server.';

describe('the pricing page says who can buy', () => {
  // Fails if the line moves away from the plans, drops that the free app is open to everyone, or the
  // question and the note stop saying the same thing.
  it('says it beside the plan cards', () => {
    render(<PricingPage />);
    const plans = screen.getByRole('region', { name: 'Plans' });
    expect(within(plans).getByText(ELIGIBILITY_LINE)).toBeTruthy();
  });

  it('answers it in the questions', () => {
    const { container } = render(<PricingPage />);
    const faq = container.querySelector('#faq');
    expect(faq).not.toBeNull();
    const question = within(faq as HTMLElement).getByText('Who can buy a plan?');
    expect(question.nextElementSibling?.textContent).toBe(ELIGIBILITY_LINE);
  });
});

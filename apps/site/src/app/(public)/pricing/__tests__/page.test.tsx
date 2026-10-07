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
  'Paid plans and hosted spaces are for people in the United States, 18 or older. The free app is open to everyone, and so is running DorkOS or a space yourself.';

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

describe('the plan buttons', () => {
  // Fails if a paid plan's button stops asking for early access, or the free plan's button changes.
  it('asks for early access on every paid plan', () => {
    render(<PricingPage />);
    const plans = screen.getByRole('region', { name: 'Plans' });
    const paid = within(plans).getAllByRole('link', { name: 'Request early access' });
    expect(paid).toHaveLength(3);
    for (const link of paid) expect(link.getAttribute('href')).toBe('/early-access');
    expect(within(plans).queryByRole('link', { name: 'Create your account' })).toBeNull();
  });

  it('leaves the free plan pointing at the install page', () => {
    render(<PricingPage />);
    const plans = screen.getByRole('region', { name: 'Plans' });
    const free = within(plans).getByRole('link', { name: 'Get DorkOS' });
    expect(free.getAttribute('href')).toBe('/install');
  });
});

describe('coming soon marks on cloud agents', () => {
  // Cloud agents aren't built yet. Fails if the badge goes missing, or if it starts changing the
  // text beside it rather than sitting next to it.
  it('badges the hosted space on Free and the cloud agents on Pro and Max', () => {
    render(<PricingPage />);
    const plans = screen.getByRole('region', { name: 'Plans' });

    const freeBenefit = within(plans).getByText(
      'One space we run for you, for up to 50 people, with 1 GB of storage (United States, 18 or older)'
    );
    expect(within(freeBenefit.closest('li') as HTMLElement).getByText('Coming soon')).toBeTruthy();

    const proBenefit = within(plans).getByText(
      'Room for 3 agents in the cloud, each with its own email address'
    );
    expect(within(proBenefit.closest('li') as HTMLElement).getByText('Coming soon')).toBeTruthy();

    const maxBenefit = within(plans).getByText('Room for 10 agents in the cloud');
    expect(within(maxBenefit.closest('li') as HTMLElement).getByText('Coming soon')).toBeTruthy();
  });

  it('badges the extra agent add-on and the comparison table’s "In the cloud" row', () => {
    const { container } = render(<PricingPage />);

    const extraDetail = screen.getByText(
      'One more agent in the cloud, with its own email address. On any paid plan.'
    );
    expect(within(extraDetail.closest('li') as HTMLElement).getByText('Coming soon')).toBeTruthy();

    const compare = container.querySelector('#compare') as HTMLElement;
    const row = within(compare).getByText('In the cloud').closest('tr') as HTMLElement;
    expect(within(row).getAllByText('Coming soon')).toHaveLength(4);
  });
});

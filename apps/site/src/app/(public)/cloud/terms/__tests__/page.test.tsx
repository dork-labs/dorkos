/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import CloudTermsPage from '../page';

describe('the Terms for DorkOS Cloud page', () => {
  // Independent literals on purpose: if the company module changes, this test
  // asks someone to confirm the published legal page should change with it.
  it('names the company, its address and the governing state', () => {
    const { container } = render(<CloudTermsPage />);
    const text = container.textContent ?? '';
    expect(text).toContain('DorkOS is made by 144 Studio, LLC.');
    expect(text).toContain('defend and indemnify 144 Studio, LLC against claims');
    expect(text).toContain('governed by the law of Texas, without regard');
    expect(text).toContain('144 Studio, LLC, 6028 Toscana Ave, Austin, TX 78724, United States.');
  });

  it('leaves no draft placeholder behind', () => {
    const { container } = render(<CloudTermsPage />);
    expect(container.textContent).not.toMatch(/\[operator|Before this is published/i);
  });

  it('sends questions to the support address', () => {
    const { container } = render(<CloudTermsPage />);
    const mail = container.querySelector('a[href^="mailto:"]');
    expect(mail?.getAttribute('href')).toBe('mailto:support@dorkos.ai');
  });

  it('links the pricing page and the website terms', () => {
    const { container } = render(<CloudTermsPage />);
    const hrefs = [...container.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('/pricing');
    expect(hrefs).toContain('/terms');
  });
});

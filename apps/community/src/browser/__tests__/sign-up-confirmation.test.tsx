// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { CommunityWireAuthOptions } from '@dorkos/shared/community-wire';
import { SignUpConfirmation, signUpRules } from '../sign-up/SignUpConfirmation.js';
import { countryList } from '../sign-up/country-names.js';

const base: CommunityWireAuthOptions = {
  google: false,
  github: false,
  oidc: null,
  minimumAge: null,
  allowedCountries: null,
  emailLinks: false,
};

afterEach(cleanup);

/** The rule line and the box's label, as a person reads them. */
function shown(rules: NonNullable<ReturnType<typeof signUpRules>>) {
  render(<SignUpConfirmation id="rules" rules={rules} confirmed={false} onChange={() => {}} />);
  const box = screen.getByRole('checkbox');
  return {
    rule: document.getElementById('rules-rule')?.textContent,
    box: box.closest('label')?.textContent,
  };
}

describe('the sign-up rules a page asks for', () => {
  it('asks nothing when the host set no rule, including an older server that sends no list', () => {
    // Purpose: fails if an unset setting shows a box, or a pre-countries server breaks the page.
    expect(signUpRules(base)).toBeNull();
    const older = { ...base } as Partial<CommunityWireAuthOptions>;
    delete older.allowedCountries;
    expect(signUpRules(older as CommunityWireAuthOptions)).toBeNull();
  });

  it('keeps the minimum-age wording exactly as it was when only the age is set', () => {
    // Purpose: fails if adding countries changed what an age-only host shows.
    expect(shown(signUpRules({ ...base, minimumAge: 18 })!)).toEqual({
      rule: 'You must be at least 18 to join.',
      box: 'I am at least 18 years old.',
    });
  });

  it('names the allowed countries in plain English, alone or beside the age', () => {
    // Purpose: fails if the box shows raw codes, drops "the" where English needs it, or asks for
    // the countries and the age in two different places.
    expect(shown(signUpRules({ ...base, allowedCountries: ['US'] })!)).toEqual({
      rule: 'Open to people who live in the United States.',
      box: 'I live in the United States.',
    });
    cleanup();
    expect(
      shown(signUpRules({ ...base, minimumAge: 16, allowedCountries: ['US', 'CA'] })!)
    ).toEqual({
      rule: 'You must be at least 16 and live in the United States or Canada to join.',
      box: 'I am at least 16 years old and live in the United States or Canada.',
    });
  });

  it('lists several countries with "or", and falls back to the code for one it cannot name', () => {
    expect(countryList(['FR', 'DE', 'GB'])).toBe('France, Germany, or the United Kingdom');
    expect(countryList(['QM'])).toBe('QM');
  });
});

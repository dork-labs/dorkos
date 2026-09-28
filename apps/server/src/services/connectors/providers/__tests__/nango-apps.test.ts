import { describe, expect, it } from 'vitest';
import { BUILT_IN_APPS } from '../../resources/built-in-apps.js';
import type { NangoIntegration } from '../nango-client.js';
import { NANGO_TEMPLATE_SERVICES, nangoServiceIds } from '../nango-apps.js';

function integration(uniqueKey: string, provider: string, displayName?: string): NangoIntegration {
  return { uniqueKey, provider, ...(displayName && { displayName }) };
}

describe('NANGO_TEMPLATE_SERVICES', () => {
  it('maps only onto popular apps a person signs in to', () => {
    const accountApps = new Set(
      BUILT_IN_APPS.filter((app) => app.account).map((app) => app.serviceSlug)
    );
    for (const [template, serviceSlug] of Object.entries(NANGO_TEMPLATE_SERVICES)) {
      expect(accountApps.has(serviceSlug), `${template} → ${serviceSlug}`).toBe(true);
    }
  });
});

describe('nangoServiceIds', () => {
  it('lists an integration of a popular app under the app’s id, whatever the person named it', () => {
    const ids = nangoServiceIds([integration('google-mail', 'google-mail', 'Gmail')]);

    expect(ids.entries.map((entry) => [entry.serviceSlug, entry.displayName])).toEqual([
      ['gmail', 'Gmail'],
    ]);
    expect(ids.serviceSlugOf('google-mail')).toBe('gmail');
    expect(ids.integrationFor('gmail')?.uniqueKey).toBe('google-mail');
    expect(ids.integrationFor('google-mail')).toBeUndefined();
  });

  it('keeps an unknown template under the integration’s own key', () => {
    const ids = nangoServiceIds([integration('acme-crm', 'acme', 'Acme')]);

    expect(ids.entries.map((entry) => [entry.serviceSlug, entry.displayName])).toEqual([
      ['acme-crm', 'Acme'],
    ]);
    expect(ids.integrationFor('acme-crm')?.uniqueKey).toBe('acme-crm');
  });

  it('gives an app’s id to one integration only, and names the other by its key', () => {
    // Listed out of key order: the choice must not depend on Nango's order.
    const ids = nangoServiceIds([
      integration('mail-work', 'google-mail', 'Gmail'),
      integration('mail-home', 'google-mail', 'Gmail'),
    ]);

    expect(ids.entries.map((entry) => [entry.serviceSlug, entry.displayName])).toEqual([
      ['mail-work', 'Gmail (mail-work)'],
      ['gmail', 'Gmail'],
    ]);
    expect(ids.integrationFor('gmail')?.uniqueKey).toBe('mail-home');
    expect(ids.integrationFor('mail-work')?.uniqueKey).toBe('mail-work');
  });

  it('never takes an id another integration already goes by', () => {
    const ids = nangoServiceIds([
      integration('mail-extra', 'google-mail', 'Gmail'),
      integration('gmail', 'google-mail', 'Gmail'),
    ]);

    const slugs = ids.entries.map((entry) => entry.serviceSlug);
    expect(slugs).toEqual(['mail-extra', 'gmail']);
    expect(ids.integrationFor('gmail')?.uniqueKey).toBe('gmail');
  });

  it('gives the app’s id to the integration set up first, so a later one never takes it', () => {
    const ids = nangoServiceIds(
      [
        { uniqueKey: 'a-gmail', provider: 'google-mail', createdAt: '2026-09-01T00:00:00Z' },
        { uniqueKey: 'mail-home', provider: 'google-mail', createdAt: '2026-01-01T00:00:00Z' },
        // No set-up date sorts after every dated one, even with accounts.
        { uniqueKey: 'a-undated', provider: 'google-mail' },
      ],
      new Set(['a-undated'])
    );

    expect(ids.integrationFor('gmail')?.uniqueKey).toBe('mail-home');
    expect(ids.renames).toEqual(new Map([['mail-home', 'gmail']]));
  });

  it('without set-up dates, gives the app’s id to the integration holding accounts', () => {
    const integrations = [
      integration('a-empty', 'google-mail'),
      integration('b-used', 'google-mail'),
    ];

    expect(nangoServiceIds(integrations).integrationFor('gmail')?.uniqueKey).toBe('a-empty');
    expect(
      nangoServiceIds(integrations, new Set(['b-used'])).integrationFor('gmail')?.uniqueKey
    ).toBe('b-used');
  });

  it('keeps an account of an integration Nango no longer lists under its key', () => {
    expect(nangoServiceIds([]).serviceSlugOf('google-mail')).toBe('google-mail');
  });
});

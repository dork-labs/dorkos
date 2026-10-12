import { describe, expect, it } from 'vitest';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';

import { INTENT_CATEGORY_KEYWORDS, matchServicesToIntent } from '../intent-match.js';
import { BUILT_IN_APPS } from '../../resources/built-in-apps.js';

/** The popular apps as the catalog lists them, plus a few live ones with no shelf. */
const CATALOG: ConnectorCatalogService[] = [
  ...BUILT_IN_APPS.map((app) => ({
    serviceSlug: app.serviceSlug,
    displayName: app.displayName,
    iconKey: app.serviceSlug,
    intents: [{ kind: 'account' as const, routes: [] }],
    category: app.category,
  })),
  {
    serviceSlug: 'microsoft_teams',
    displayName: 'Microsoft Teams',
    iconKey: 'microsoft_teams',
    intents: [{ kind: 'account' as const, routes: [] }],
  },
  {
    serviceSlug: 'deployhq',
    displayName: 'DeployHQ',
    iconKey: 'deployhq',
    intents: [{ kind: 'account' as const, routes: [] }],
  },
] as unknown as ConnectorCatalogService[];

const slugs = (intent: string, limit = 5) =>
  matchServicesToIntent(intent, CATALOG, limit).map((match) => match.service.serviceSlug);

describe('matchServicesToIntent', () => {
  it('points "let the team know the deploy is done" at chat apps', () => {
    const found = matchServicesToIntent('let the team know the deploy is done', CATALOG, 5);
    expect(found.map((match) => match.service.serviceSlug)).toEqual([
      // Named by a whole word of its name ("Teams"), so it leads.
      'microsoft_teams',
      'slack',
      'telegram',
    ]);
    expect(found.find((match) => match.service.serviceSlug === 'slack')?.matchedBy).toEqual([
      'category',
    ]);
  });

  it('points "message the team" at chat apps', () => {
    expect(slugs('message the team')).toEqual(expect.arrayContaining(['slack', 'telegram']));
  });

  it('points "summarise my inbox" at email apps', () => {
    expect(slugs('summarise my inbox')).toEqual(['gmail', 'outlook']);
  });

  it('returns nothing, never a padded guess, when nothing fits', () => {
    expect(slugs('water the plants on the balcony')).toEqual([]);
    expect(slugs('the and of to')).toEqual([]);
  });

  it('puts an app the description names ahead of its shelf-mates', () => {
    expect(slugs('send an email with outlook')[0]).toBe('outlook');
    expect(slugs('add the meeting to google calendar')[0]).toBe('googlecalendar');
  });

  it('matches whole words of a name, never part of one', () => {
    // "deploy" is a piece of "DeployHQ", not a word of it.
    expect(slugs('deploy the site')).toEqual([]);
  });

  it('returns at most the limit, best first', () => {
    expect(slugs('add a task to the project backlog', 2)).toEqual(['linear', 'jira']);
  });

  it('maps every keyword to exactly one shelf', () => {
    const seen = new Map<string, string>();
    for (const [category, keywords] of Object.entries(INTENT_CATEGORY_KEYWORDS)) {
      for (const keyword of keywords) {
        expect(seen.get(keyword), `${keyword} is on ${seen.get(keyword)} too`).toBeUndefined();
        seen.set(keyword, category);
      }
    }
  });
});

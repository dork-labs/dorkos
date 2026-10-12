import { describe, expect, it } from 'vitest';
import type { ConnectorCatalogService } from '@dorkos/shared/connector-resource-schemas';

import {
  INTENT_CATEGORY_KEYWORDS,
  INTENT_WEAK_CATEGORY_KEYWORDS,
  matchServicesToIntent,
} from '../intent-match.js';
import { BUILT_IN_APPS } from '../../resources/built-in-apps.js';

const live = (serviceSlug: string, displayName: string) => ({
  serviceSlug,
  displayName,
  iconKey: serviceSlug,
  intents: [{ kind: 'account' as const, routes: [] }],
});

/**
 * The popular apps as the catalog lists them, then live apps with no shelf —
 * several of them deliberately named after everyday words. The live apps come
 * FIRST in catalog order here, so a popular app winning a tie proves the
 * popularity tie-break rather than catalog order.
 */
const CATALOG = [
  live('agent_mail', 'Agent Mail'),
  live('zoho_mail', 'Zoho Mail'),
  live('monday', 'monday.com'),
  live('close', 'Close'),
  live('helpscout', 'Help Scout'),
  live('microsoft_teams', 'Microsoft Teams'),
  live('deployhq', 'DeployHQ'),
  live('salesforce', 'Salesforce'),
  ...BUILT_IN_APPS.map((app) => ({
    ...live(app.serviceSlug, app.displayName),
    category: app.category,
    popular: true,
  })),
] as unknown as ConnectorCatalogService[];

const slugs = (intent: string, limit = 5, preferred?: string[]) =>
  matchServicesToIntent(intent, CATALOG, limit, {
    ...(preferred && { preferred: new Set(preferred) }),
  }).map((match) => match.service.serviceSlug);

describe('matchServicesToIntent', () => {
  it.each([
    ['let the team know the deploy is done', ['slack', 'telegram']],
    ['message the team', ['slack', 'telegram']],
    ['summarise my inbox', ['gmail', 'outlook']],
    ['check my mail', ['gmail', 'outlook']],
    ['file a bug report', ['linear', 'jira', 'asana', 'todoist']],
    ['close the ticket', ['linear', 'jira', 'asana', 'todoist']],
    ['schedule a meeting with Sam on monday', ['googlecalendar']],
    ['add the meeting to google calendar', ['googlecalendar']],
    ['send an email with outlook', ['outlook', 'gmail']],
    ['update the deal in salesforce', ['salesforce', 'hubspot']],
    [
      'post the release notes to slack',
      ['slack', 'notion', 'googledocs', 'googlesheets', 'airtable'],
    ],
  ])('%s → %j', (intent, expected) => {
    expect(slugs(intent)).toEqual(expected);
  });

  it('returns nothing, never a padded guess, when nothing fits', () => {
    expect(slugs('water the plants on the balcony')).toEqual([]);
    expect(slugs('the and of to this')).toEqual([]);
    // Everyday words that happen to be app names do not pick an app alone.
    expect(slugs('help me write a status update')).toEqual([]);
    expect(slugs('call me on monday')).toEqual([]);
  });

  it('needs a second word before an ambiguous shelf word picks a shelf', () => {
    expect(slugs('open an issue')).toEqual([]);
    expect(slugs('open an issue in the backlog')[0]).toBe('linear');
  });

  it('matches whole words of a name, never part of one', () => {
    // "deploy" is a piece of "DeployHQ", not a word of it.
    expect(slugs('deploy the site')).toEqual([]);
  });

  it('puts apps the caller already has first among equal scores', () => {
    expect(slugs('summarise my inbox', 5, ['outlook'])).toEqual(['outlook', 'gmail']);
  });

  it('returns at most the limit, best first', () => {
    expect(slugs('add a task to the project backlog', 2)).toEqual(['linear', 'jira']);
  });

  it('maps every keyword to exactly one shelf', () => {
    const seen = new Map<string, string>();
    for (const table of [INTENT_CATEGORY_KEYWORDS, INTENT_WEAK_CATEGORY_KEYWORDS]) {
      for (const [category, keywords] of Object.entries(table)) {
        for (const keyword of keywords ?? []) {
          expect(seen.get(keyword), `${keyword} is on ${seen.get(keyword)} too`).toBeUndefined();
          seen.set(keyword, category);
        }
      }
    }
  });
});

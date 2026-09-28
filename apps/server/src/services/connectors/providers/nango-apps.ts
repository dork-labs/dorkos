/**
 * Which DorkOS app each Nango integration serves (DOR-2436).
 *
 * A Nango integration has two names. Its `unique_key` is the person's own
 * choice when they set it up ("google-mail", "gmail-work", anything), so it
 * can't say which app it is. Its `provider` is Nango's own fixed template id
 * (`google-mail`, `google-calendar`, `slack`), the same on every Nango server.
 * The catalog lists apps by DorkOS service id (the Composio slugs in
 * `resources/built-in-apps.ts`), so without this map a Nango Gmail integration
 * showed as a second row beside the popular Gmail one, under the person's key.
 *
 * The Nango provider speaks DorkOS service ids across the port, and turns them
 * back into the integration's own key only when it calls Nango, exactly as it
 * keeps Nango's `connectionId` behind the private account reference. Everything
 * past the port (the catalog, sign-in, agent requests, the "Yours" list) then
 * sees one id per app and needs no Nango knowledge.
 *
 * @module services/connectors/providers/nango-apps
 */
import type { NangoIntegration } from './nango-client.js';

/**
 * Nango template id → the DorkOS service id of the popular app it signs in to.
 *
 * Only templates that connect a person's own account in that app through its
 * usual API are listed (checked against Nango's `providers.yaml`, 2026-09-27).
 * Left out on purpose: the `-mcp` templates and `github-app` (an organization's
 * app install, not a person's account), and `telegram` (a bot token, which
 * DorkOS's own Telegram chat bot already covers). An unlisted template keeps
 * its own row under the integration's key, as before.
 */
export const NANGO_TEMPLATE_SERVICES: Readonly<Record<string, string>> = {
  'google-mail': 'gmail',
  outlook: 'outlook',
  'google-calendar': 'googlecalendar',
  slack: 'slack',
  notion: 'notion',
  'google-docs': 'googledocs',
  'google-sheet': 'googlesheets',
  airtable: 'airtable',
  'airtable-pat': 'airtable',
  'google-drive': 'googledrive',
  dropbox: 'dropbox',
  github: 'github',
  'github-pat': 'github',
  linear: 'linear',
  jira: 'jira',
  'jira-basic': 'jira',
  asana: 'asana',
  todoist: 'todoist',
  hubspot: 'hubspot',
};

/** One integration as the port sees it: the service id it goes by, and its name. */
export interface NangoServiceEntry {
  /** The DorkOS service id this integration is listed and connected under. */
  readonly serviceSlug: string;
  /** The integration's name in the list. */
  readonly displayName: string;
  /** The integration as Nango lists it. */
  readonly integration: NangoIntegration;
}

/** Every integration's service id, both ways round. */
export interface NangoServiceIds {
  /** Each integration's entry, in the order Nango listed them. */
  readonly entries: readonly NangoServiceEntry[];
  /**
   * The service id an integration's accounts go by. An integration Nango no
   * longer lists keeps its own key.
   *
   * @param uniqueKey - The integration's Nango `unique_key`.
   */
  serviceSlugOf(uniqueKey: string): string;
  /**
   * The integration a service id names, or undefined when none does.
   *
   * @param serviceSlug - A service id from the port.
   */
  integrationFor(serviceSlug: string): NangoIntegration | undefined;
  /**
   * Every integration whose accounts go by an id other than its own key: its
   * key → that id. Accounts DorkOS saved under the key move to the id.
   */
  readonly renames: ReadonlyMap<string, string>;
}

/**
 * Which of several integrations of one app keeps the app's id: the one set up
 * first, so setting up another integration of the app later never moves the
 * row, or the accounts on it, to the new one. When Nango sends no set-up date,
 * one that already holds accounts goes first, then the first by key.
 *
 * Set-up date comes before accounts on purpose: an account landing on the
 * younger integration would otherwise move the app's id to it in the middle
 * of that very sign-in, and move the older integration's accounts off it.
 */
function winnerOrder(withAccounts: ReadonlySet<string>) {
  return (a: NangoIntegration, b: NangoIntegration): number =>
    setUpAt(a) - setUpAt(b) ||
    Number(withAccounts.has(b.uniqueKey)) - Number(withAccounts.has(a.uniqueKey)) ||
    a.uniqueKey.localeCompare(b.uniqueKey);
}

/** When an integration was set up, in ms; one Nango sent no date for sorts last. */
function setUpAt(integration: NangoIntegration): number {
  const at = integration.createdAt ? Date.parse(integration.createdAt) : Number.NaN;
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : at;
}

/**
 * Give every integration one service id, never the same one twice.
 *
 * An integration whose template serves a popular app takes that app's id, so
 * it merges into the popular row. Two rules keep ids unique. An integration's
 * own key always stays its own: if the person named one integration `gmail`,
 * no other can take `gmail`. And an app's id goes to one integration only,
 * chosen by {@link winnerOrder}, never by Nango's list order. An
 * integration that loses the id keeps its key and its own row, named with its
 * key so it never reads as a second copy of the popular one: two Gmail
 * integrations are two setups the person made on purpose (other sign-in apps,
 * other scopes), and each stays reachable.
 *
 * @param integrations - Nango's integration list.
 * @param withAccounts - Keys of the integrations that already hold accounts.
 */
export function nangoServiceIds(
  integrations: readonly NangoIntegration[],
  withAccounts: ReadonlySet<string> = new Set()
): NangoServiceIds {
  const ownKeys = new Set(integrations.map((it) => it.uniqueKey));
  const claimed = new Map<string, string>();
  for (const it of [...integrations].sort(winnerOrder(withAccounts))) {
    const app = NANGO_TEMPLATE_SERVICES[it.provider];
    if (app && app !== it.uniqueKey && !ownKeys.has(app) && !claimed.has(app)) {
      claimed.set(app, it.uniqueKey);
    }
  }
  const appOf = new Map([...claimed].map(([app, uniqueKey]) => [uniqueKey, app]));
  const entries = integrations.map((integration): NangoServiceEntry => {
    const name = integration.displayName ?? integration.provider;
    const app = NANGO_TEMPLATE_SERVICES[integration.provider];
    const serviceSlug = appOf.get(integration.uniqueKey) ?? integration.uniqueKey;
    const lostTheApp = app !== undefined && serviceSlug !== app;
    return {
      serviceSlug,
      displayName: lostTheApp ? `${name} (${integration.uniqueKey})` : name,
      integration,
    };
  });
  const bySlug = new Map(entries.map((entry) => [entry.serviceSlug, entry.integration]));
  return {
    entries,
    serviceSlugOf: (uniqueKey) => appOf.get(uniqueKey) ?? uniqueKey,
    integrationFor: (serviceSlug) => bySlug.get(serviceSlug),
    renames: appOf,
  };
}

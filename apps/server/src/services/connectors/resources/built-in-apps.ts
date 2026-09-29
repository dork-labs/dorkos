/**
 * The hand-picked popular apps DorkOS always lists, so the Connections list is
 * never empty (connections-one-list design §6, DOR-2421).
 *
 * Before anyone sets up a way to reach apps, the catalog has nothing live to
 * show, and a search for "gmail" used to answer "No matching services". These
 * entries keep the popular apps on screen from the first visit: connecting one
 * starts with the one-time step that sets up how DorkOS reaches apps. Once a
 * connection service is set up, its live catalog merges into these by service
 * id, so an app is never listed twice.
 *
 * Service ids are Composio toolkit slugs, because Composio is what both the
 * person's own key and the DorkOS account route through. The chat apps are the
 * built-in Relay adapters (`packages/relay/src/adapters/`): they work with
 * nothing set up and never need the one-time step.
 *
 * @module services/connectors/resources/built-in-apps
 */
import type { ConnectorCatalogCategory } from '@dorkos/shared/connector-resource-schemas';

/** One hand-picked app the catalog always lists. */
export interface BuiltInApp {
  /** Stable service id; live catalog entries with the same id merge into this one. */
  readonly serviceSlug: string;
  /** The app's name. */
  readonly displayName: string;
  /** One plain line saying what agents can do with it. */
  readonly description: string;
  /** The shelf it sits on in the list. */
  readonly category: ConnectorCatalogCategory;
  /** The company whose sign-in page the person meets, when it is not the app's name. */
  readonly signInName?: string;
  /** Agents can act on a person's account in it, through a connection service. */
  readonly account: boolean;
  /** People can talk to agents through it with a built-in chat bot. */
  readonly chat: boolean;
}

/** The popular apps, in the order a person scanning the list expects them. */
export const BUILT_IN_APPS: readonly BuiltInApp[] = [
  {
    serviceSlug: 'gmail',
    displayName: 'Gmail',
    description: 'Read, search and send email.',
    category: 'email',
    signInName: 'Google',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'outlook',
    displayName: 'Outlook',
    description: 'Read, search and send Outlook email.',
    category: 'email',
    signInName: 'Microsoft',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'googlecalendar',
    displayName: 'Google Calendar',
    description: 'See your schedule and add events.',
    category: 'calendar',
    signInName: 'Google',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'slack',
    displayName: 'Slack',
    description: 'Talk to your agents in Slack, or let them post as you.',
    category: 'chat',
    account: true,
    chat: true,
  },
  {
    serviceSlug: 'telegram',
    displayName: 'Telegram',
    description: 'Talk to your agents through your own Telegram bot.',
    category: 'chat',
    account: false,
    chat: true,
  },
  {
    serviceSlug: 'notion',
    displayName: 'Notion',
    description: 'Search, read and write pages and databases.',
    category: 'docs',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'googledocs',
    displayName: 'Google Docs',
    description: 'Read and write documents.',
    category: 'docs',
    signInName: 'Google',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'googlesheets',
    displayName: 'Google Sheets',
    description: 'Read and update spreadsheets.',
    category: 'docs',
    signInName: 'Google',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'airtable',
    displayName: 'Airtable',
    description: 'Read and update bases and records.',
    category: 'docs',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'googledrive',
    displayName: 'Google Drive',
    description: 'Find, read and upload files.',
    category: 'files',
    signInName: 'Google',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'dropbox',
    displayName: 'Dropbox',
    description: 'Find, read and upload files.',
    category: 'files',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'github',
    displayName: 'GitHub',
    description: 'Work with issues, pull requests and code.',
    category: 'code',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'linear',
    displayName: 'Linear',
    description: 'Create, update and track issues.',
    category: 'tasks',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'jira',
    displayName: 'Jira',
    description: 'Create, update and track issues.',
    category: 'tasks',
    signInName: 'Atlassian',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'asana',
    displayName: 'Asana',
    description: 'Manage tasks and projects.',
    category: 'tasks',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'todoist',
    displayName: 'Todoist',
    description: 'Add, update and finish to-dos.',
    category: 'tasks',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'hubspot',
    displayName: 'HubSpot',
    description: 'Work with contacts, companies and deals.',
    category: 'sales',
    account: true,
    chat: false,
  },
  {
    serviceSlug: 'webhook',
    displayName: 'Webhook',
    description: 'Send and receive messages over signed web requests.',
    category: 'developer',
    account: false,
    chat: true,
  },
];

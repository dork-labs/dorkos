/**
 * The words an app's side panel speaks in: "Try it" prompts, one plain line per
 * recent action, and what the new-event notifications are called for each app.
 *
 * The prompts are a small hand-picked map for the popular apps (design record
 * `connections-one-list` §3, "v1 source"). An app with no entry shows no
 * "Try it" section at all, rather than a generic prompt that might not fit.
 *
 * @module features/connections/lib/app-panel-copy
 */
import { actionNameFromSlug, type ConnectorUsageItem } from '@dorkos/shared/connector-schemas';

/** Two or three one-click prompts per popular app, written as a person would ask. */
const TRY_IT_PROMPTS: Record<string, readonly string[]> = {
  gmail: ['Summarise today’s Gmail inbox', 'Which of my Gmail emails need a reply?'],
  outlook: ['Summarise today’s Outlook inbox', 'Which of my Outlook emails need a reply?'],
  googlecalendar: [
    'What’s on my Google Calendar today?',
    'Find a free hour on my Google Calendar this week',
  ],
  slack: ['Summarise what I missed in Slack today', 'Which Slack messages mention me?'],
  notion: ['What changed in my Notion this week?', 'Summarise my most recent Notion page'],
  googledocs: ['Summarise my most recent Google Doc'],
  googlesheets: ['What’s in my most recent Google Sheet?'],
  airtable: ['List my Airtable bases and what each one tracks'],
  googledrive: ['Which Google Drive files did I change this week?'],
  dropbox: ['Which Dropbox files did I add this week?'],
  github: ['Which GitHub pull requests need my review?', 'Summarise my open GitHub issues'],
  linear: ['Which Linear issues are assigned to me?', 'What changed in my Linear issues today?'],
  jira: ['Which Jira issues are assigned to me?'],
  asana: ['Which Asana tasks are due this week?'],
  todoist: ['What’s on my Todoist list today?'],
  hubspot: ['Which HubSpot deals changed this week?'],
};

/**
 * The "Try it" prompts for an app, or an empty list when it has none.
 *
 * @param toolkit - The app's service id.
 */
export function tryItPrompts(toolkit: string): readonly string[] {
  return TRY_IT_PROMPTS[toolkit] ?? [];
}

/** What new-event notifications are called, for the apps where a plainer name exists. */
const EVENT_NOTICE_LABELS: Record<string, string> = {
  gmail: 'When a new email arrives…',
  outlook: 'When a new email arrives…',
  googlecalendar: 'When an event changes…',
  slack: 'When a new message arrives…',
  github: 'When something changes on GitHub…',
  linear: 'When an issue changes…',
  jira: 'When an issue changes…',
};

/**
 * The name of an app's new-event notifications row: "When a new email arrives…".
 *
 * @param toolkit - The app's service id.
 * @param appName - The app's display name, for the generic wording.
 */
export function eventNoticeLabel(toolkit: string, appName: string): string {
  return EVENT_NOTICE_LABELS[toolkit] ?? `When something new happens in ${appName}…`;
}

/**
 * Who did a recorded action, in words.
 *
 * @param item - One usage record.
 * @param agentNames - Agent display names by id.
 */
function actorName(item: ConnectorUsageItem, agentNames: Readonly<Record<string, string>>): string {
  if (item.agentId && agentNames[item.agentId]) return agentNames[item.agentId];
  switch (item.actorKind) {
    case 'operator':
      return 'You';
    case 'program':
      return 'A program';
    case 'event':
      return 'A notification';
    default:
      return 'An agent';
  }
}

/**
 * One plain "Recently" line: "DorkBot · Send email", and when it did not
 * finish, says so.
 *
 * @param item - One usage record.
 * @param toolkit - The app's service id.
 * @param agentNames - Agent display names by id.
 */
export function usageLine(
  item: ConnectorUsageItem,
  toolkit: string,
  agentNames: Readonly<Record<string, string>>
): string {
  const line = `${actorName(item, agentNames)} · ${actionNameFromSlug(item.operationSlug, toolkit)}`;
  if (item.outcome === undefined) return item.completedAt ? line : `${line} (in progress)`;
  if (item.outcome === 'success') return line;
  if (item.outcome === 'outcome_unknown') return `${line} (result unknown)`;
  return `${line} (didn’t finish)`;
}

/**
 * When DorkOS tries a stalled change again, as a person reads a clock:
 * "Trying again at 12:48.", with the weekday when it is not today, and
 * "Trying again now." once that time has passed.
 *
 * @param retryAt - ISO time of the next try.
 * @param now - The current time.
 */
export function retryLine(retryAt: string, now: Date = new Date()): string {
  const at = new Date(retryAt);
  if (at.getTime() <= now.getTime()) return 'Trying again now.';
  const time = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return at.toDateString() === now.toDateString()
    ? `Trying again at ${time}.`
    : `Trying again ${at.toLocaleDateString([], { weekday: 'long' })} at ${time}.`;
}

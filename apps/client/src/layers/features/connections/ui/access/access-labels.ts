/**
 * Words the access card uses for levels and names.
 *
 * @module features/connections/ui/access/access-labels
 */
import type { CardAccessLevel, HeldAccess } from '../../lib/access-card-selection';

/** The switch's two levels. */
export const LEVEL_LABELS: Record<CardAccessLevel, string> = {
  read: 'Read',
  'read-write': 'Read and write',
};

/** What a row says an agent holds today. */
export const HELD_LABELS: Record<Exclude<HeldAccess, 'none'>, string> = {
  ...LEVEL_LABELS,
  custom: 'Exact actions',
};

/** "Ada", "Ada and Bo", "Ada, Bo and Cy". */
export function joinNames(names: string[]): string {
  return names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * What write access lets an agent do in an app, for the one warning "Every
 * agent" with write shows. Known apps get their own words; any other app gets
 * a plain general phrase.
 */
const WRITE_VERBS: Record<string, string> = {
  gmail: 'send email',
  outlook: 'send email',
  slack: 'send messages',
  googlecalendar: 'change your calendar',
  google_calendar: 'change your calendar',
  calendar: 'change your calendar',
  googledrive: 'change your files',
  google_drive: 'change your files',
  notion: 'change your pages',
  github: 'make changes on GitHub',
  linear: 'change your issues',
};

/**
 * The warning shown when every agent, including future ones, can write:
 * "Every agent — including ones you add later — could send email as you."
 * When every agent also holds a high-risk action, it says so in the shared
 * words, never "delete": the service marks forwarding and sharing high risk
 * too. "…could send email and take high-risk actions as you."
 *
 * @param toolkit - The app's toolkit id, e.g. `gmail`.
 * @param serviceName - The app's display name, for apps without their own words.
 * @param highRisk - Whether every agent also holds a high-risk action.
 */
export function everyAgentWriteWarning(
  toolkit: string,
  serviceName: string,
  highRisk = false
): string {
  const verb = WRITE_VERBS[toolkit.toLowerCase()] ?? `make changes in ${serviceName}`;
  const reach = highRisk ? `${verb} and take high-risk actions` : verb;
  return `Every agent — including ones you add later — could ${reach} as you.`;
}

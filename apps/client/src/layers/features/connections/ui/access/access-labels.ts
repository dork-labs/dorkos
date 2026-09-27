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
 * The warning shown when every agent, including future ones, is given write
 * access: "Every agent — including ones you add later — could send email as you."
 *
 * @param toolkit - The app's toolkit id, e.g. `gmail`.
 * @param serviceName - The app's display name, for apps without their own words.
 */
export function everyAgentWriteWarning(toolkit: string, serviceName: string): string {
  const verb = WRITE_VERBS[toolkit.toLowerCase()] ?? `make changes in ${serviceName}`;
  return `Every agent — including ones you add later — could ${verb} as you.`;
}

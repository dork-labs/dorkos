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
const WRITE_VERBS: Record<string, { write: string; writeAndDelete: string }> = {
  gmail: { write: 'send email', writeAndDelete: 'send and delete email' },
  outlook: { write: 'send email', writeAndDelete: 'send and delete email' },
  slack: { write: 'send messages', writeAndDelete: 'send and delete messages' },
  googlecalendar: {
    write: 'change your calendar',
    writeAndDelete: 'change and delete calendar events',
  },
  google_calendar: {
    write: 'change your calendar',
    writeAndDelete: 'change and delete calendar events',
  },
  calendar: { write: 'change your calendar', writeAndDelete: 'change and delete calendar events' },
  googledrive: { write: 'change your files', writeAndDelete: 'change and delete your files' },
  google_drive: { write: 'change your files', writeAndDelete: 'change and delete your files' },
  notion: { write: 'change your pages', writeAndDelete: 'change and delete your pages' },
  github: {
    write: 'make changes on GitHub',
    writeAndDelete: 'make changes and delete things on GitHub',
  },
  linear: { write: 'change your issues', writeAndDelete: 'change and delete your issues' },
};

/**
 * The warning shown when every agent, including future ones, can write:
 * "Every agent — including ones you add later — could send email as you." When
 * every agent can also delete, it says so: "…could send and delete email as you."
 *
 * @param toolkit - The app's toolkit id, e.g. `gmail`.
 * @param serviceName - The app's display name, for apps without their own words.
 * @param canDelete - Whether every agent can also delete.
 */
export function everyAgentWriteWarning(
  toolkit: string,
  serviceName: string,
  canDelete = false
): string {
  const words = WRITE_VERBS[toolkit.toLowerCase()];
  const verb = canDelete
    ? (words?.writeAndDelete ?? `make changes and delete things in ${serviceName}`)
    : (words?.write ?? `make changes in ${serviceName}`);
  return `Every agent — including ones you add later — could ${verb} as you.`;
}

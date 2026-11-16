/**
 * The words every surface uses for an app built for an older version of
 * DorkOS (DOR-3293, designer 2026-11-10/11): its page and right-panel tab say
 * the full sentence; its tile and Settings row say the short chip, which fits.
 */
export const APP_NEEDS_UPDATE_COPY = {
  /** The one line, after the app's name. */
  headline: (name: string) => `${name} needs an update to run safely.`,
  /** The muted second line when no newer version is known. */
  detail: 'It was built for an older version of DorkOS. Ask its maker for an update.',
  /** The short words on its tile and the Settings row's chip, beside the app's name. */
  chip: 'Needs an update',
} as const;

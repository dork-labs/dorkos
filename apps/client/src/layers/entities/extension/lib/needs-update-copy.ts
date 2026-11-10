/**
 * The words every surface uses for an app built for an older version of
 * DorkOS (DOR-3293, designer 2026-11-10): its tile, page, Settings row and
 * right-panel tab say the same thing.
 */
export const APP_NEEDS_UPDATE_COPY = {
  /** The one line, after the app's name. */
  headline: (name: string) => `${name} needs an update to run safely.`,
  /** The muted second line when no newer version is known. */
  detail: 'It was built for an older version of DorkOS. Ask its maker for an update.',
  /** The same line under the app's name on its tile, where the name is already shown. */
  tileLine: 'Needs an update to run safely.',
  /** The Settings row's chip, beside the app's name. */
  chip: 'Needs an update',
} as const;

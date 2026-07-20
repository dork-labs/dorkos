import type { CreationMode as StoreCreationMode } from '@/layers/shared/model';

/**
 * The steps of the creation dialog.
 *
 * - `gallery` (M2) — the generic entry: design-your-own + template job listings.
 * - `naming` (M3) — name, face, and details, with a live preview.
 * - `arrival` (M1) — a seeded one-card confirm (a Shape's offered agent).
 * - `import` — bring in an existing project on disk (leaves the creation fork).
 */
export type WizardStep = 'gallery' | 'naming' | 'arrival' | 'import';

/**
 * A template chosen from the gallery, distilled from a marketplace package (or
 * a custom URL). Carries what the naming step needs: the download source, a
 * resolved human name, the job line, a face seed, and chips.
 */
export interface SelectedTemplate {
  /** Download source (git URL) passed to the create API. */
  source: string;
  /** Package slug (kebab-case). */
  name: string;
  /** Resolved human display name (sidecar `displayName` or humanized slug). */
  displayName: string;
  /** What the agent does. */
  description?: string;
  /** Package icon — an emoji seeds the face; anything else is ignored. */
  icon?: string;
  /** Connection/cadence chips derived from the package. */
  tags?: string[];
  /** Primary category. */
  category?: string;
}

export type ConflictStatus =
  | 'idle'
  | 'checking'
  | 'no-path'
  | 'exists-no-dork'
  | 'exists-has-dork'
  | 'error';

/** Title + description shown in the dialog header for each step (arrival owns its own). */
export const STEP_HEADERS: Record<WizardStep, { title: string; description: string }> = {
  gallery: { title: 'New agent', description: 'What will your agent do?' },
  naming: { title: 'Name your agent', description: 'Give it a name and a face.' },
  arrival: { title: 'Meet your new agent', description: 'Bring a ready-made agent to life.' },
  import: {
    title: 'Bring in a project',
    description: 'Scan for an existing project folder on disk.',
  },
};

/**
 * Map the store's `initialMode` to the wizard's starting step. Generic entries
 * (`new`/`template`) open the gallery; `import` jumps straight to the scan.
 *
 * @param mode - The mode the store was opened with.
 */
export function initialStepFromMode(mode: StoreCreationMode): WizardStep {
  return mode === 'import' ? 'import' : 'gallery';
}

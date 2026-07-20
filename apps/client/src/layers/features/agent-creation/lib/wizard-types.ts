/**
 * The steps of the creation dialog.
 *
 * - `gallery` (M2) — the generic entry: design-your-own + template job listings.
 * - `naming` (M3) — name, face, and details, with a live preview.
 * - `arrival` (M1) — a seeded one-card confirm (a Shape's or marketplace agent).
 *
 * Import is no longer a step here — it leaves the dialog entirely (see
 * `useImportProjectsStore` + `ImportProjectsDialog`).
 */
export type WizardStep = 'gallery' | 'naming' | 'arrival';

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

/**
 * Title + description shown in the dialog header for each step. The arrival step
 * (M1) owns its own title/face and suppresses the generic header, so it carries
 * only the description — surfaced through the dialog's sr-only live region.
 */
export const STEP_HEADERS: {
  gallery: { title: string; description: string };
  naming: { title: string; description: string };
  arrival: { description: string };
} = {
  gallery: { title: 'New agent', description: 'What will your agent do?' },
  naming: { title: 'Name your agent', description: 'Give it a name and a face.' },
  arrival: { description: 'Bring a ready-made agent to life.' },
};

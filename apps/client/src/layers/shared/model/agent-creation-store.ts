import { create } from 'zustand';
import type { AgentRuntime } from '@dorkos/shared/mesh-schemas';

/**
 * How the generic creation dialog was opened. `new` and `template` both land on
 * the gallery (M2); the distinction is historical (a former method fork). Import
 * is no longer a creation mode — it leaves the dialog entirely (see
 * `useImportProjectsStore`).
 */
export type CreationMode = 'new' | 'template';

/** Where a creation seed came from — drives the arrival copy and how the offer is recovered. */
export type CreationOrigin = 'shape-offer' | 'marketplace-agent';

/**
 * The ready-made agent an arrival confirm (M1) is seeded from. Mirrors a Shape's
 * offered-agent template: a display name plus whatever the source already knows
 * about the agent (its voice, where it runs, what it can do).
 */
export interface CreationSeedTemplate {
  displayName: string;
  runtime?: AgentRuntime;
  persona?: string;
  capabilities?: string[];
  skills?: string[];
  /**
   * Download source (git URL / giget ref) for a template-backed offer. Present
   * for a `marketplace-agent` seed — passed to the create API as `template`, so
   * the standard engine clones the package's files into the new agent's
   * directory. Absent for a `shape-offer` (its template is inline, no download).
   */
  source?: string;
  /**
   * Emoji icon that seeds the agent's face (M3 picker). An arbitrary
   * non-emoji identifier is ignored by the picker; only an emoji is a valid seed.
   */
  icon?: string;
  /**
   * Human cadence label for the M1 ledger's schedule line (e.g. "Every
   * weekday at 9am"). Present only when the offer's shape declares a schedule;
   * the ledger renders the line solely when this is set, so the arrival card
   * never claims a cadence the agent does not have.
   */
  schedule?: string;
}

/**
 * A pre-filled creation seed. Opening the dialog with one skips the method fork
 * and shows the arrival confirm for that specific agent instead.
 */
export interface CreationSeed {
  /** The agent taking shape. */
  template: CreationSeedTemplate;
  /** What surfaced this offer. */
  origin: CreationOrigin;
  /** Human-facing name of the source (e.g. the Shape or marketplace), for "offered by …" copy. */
  sourceLabel?: string;
}

/** Optional per-open behavior. */
export interface CreationOpenOptions {
  /**
   * One-shot hook run on a successful create INSTEAD of the default
   * navigate-to-session. Lets a host flow (e.g. onboarding) take over — it
   * stays mounted underneath the dialog and advances itself. Cleared on close.
   */
  onCreated?: () => void;
}

interface AgentCreationState {
  isOpen: boolean;
  initialMode: CreationMode;
  /** Present when the dialog was opened from a specific offer — renders M1, not the fork. */
  seed: CreationSeed | null;
  /** One-shot post-create hook, set at open time (see {@link CreationOpenOptions}). */
  onCreated: (() => void) | null;
  /** Open the gallery dialog (or a specific mode). Clears any seed. */
  open: (mode?: CreationMode, options?: CreationOpenOptions) => void;
  /** Open the dialog seeded from an offer — renders the arrival confirm (M1). */
  openWithSeed: (seed: CreationSeed, options?: CreationOpenOptions) => void;
  close: () => void;
}

/** Global dialog state for the Create Agent dialog. */
export const useAgentCreationStore = create<AgentCreationState>((set) => ({
  isOpen: false,
  initialMode: 'new',
  seed: null,
  onCreated: null,
  open: (mode?: CreationMode, options?: CreationOpenOptions) =>
    set({
      isOpen: true,
      initialMode: mode ?? 'new',
      seed: null,
      onCreated: options?.onCreated ?? null,
    }),
  openWithSeed: (seed: CreationSeed, options?: CreationOpenOptions) =>
    set({ isOpen: true, initialMode: 'new', seed, onCreated: options?.onCreated ?? null }),
  close: () => set({ isOpen: false, initialMode: 'new', seed: null, onCreated: null }),
}));

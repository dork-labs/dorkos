import { create } from 'zustand';
import type { AgentRuntime } from '@dorkos/shared/mesh-schemas';

export type CreationMode = 'new' | 'template' | 'import';

/** @deprecated Use CreationMode instead */
export type CreationTab = CreationMode;

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
  /** Human-facing name of the source (e.g. the Shape), for "offered by …" copy. */
  sourceLabel?: string;
}

interface AgentCreationState {
  isOpen: boolean;
  initialMode: CreationMode;
  /** Present when the dialog was opened from a specific offer — renders M1, not the fork. */
  seed: CreationSeed | null;
  /** Open the method-fork dialog (or jump straight to a mode). Clears any seed. */
  open: (mode?: CreationMode) => void;
  /** Open the dialog seeded from an offer — renders the arrival confirm (M1). */
  openWithSeed: (seed: CreationSeed) => void;
  close: () => void;
}

/** Global dialog state for the Create Agent dialog. */
export const useAgentCreationStore = create<AgentCreationState>((set) => ({
  isOpen: false,
  initialMode: 'new',
  seed: null,
  open: (mode?: CreationMode) => set({ isOpen: true, initialMode: mode ?? 'new', seed: null }),
  openWithSeed: (seed: CreationSeed) => set({ isOpen: true, initialMode: 'new', seed }),
  close: () => set({ isOpen: false, initialMode: 'new', seed: null }),
}));

import { create } from 'zustand';
import type { PulsePreset } from '@dorkos/shared/types';

interface PulsePresetDialogState {
  /** Preset to pre-populate when dialog opens externally, or null for blank form. */
  pendingPreset: PulsePreset | null;
  /** True when the dialog was triggered externally (e.g., from SchedulesView sidebar). */
  externalTrigger: boolean;
  /**
   * Signal PulsePanel to open CreateScheduleDialog at form step with this preset.
   *
   * @param preset - The preset to pre-populate the form with
   */
  openWithPreset: (preset: PulsePreset) => void;
  /** Reset after the dialog has consumed the pending state. */
  clear: () => void;
}

export const usePulsePresetDialog = create<PulsePresetDialogState>((set) => ({
  pendingPreset: null,
  externalTrigger: false,
  openWithPreset: (preset) => set({ pendingPreset: preset, externalTrigger: true }),
  clear: () => set({ pendingPreset: null, externalTrigger: false }),
}));

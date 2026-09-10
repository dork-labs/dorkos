/**
 * Factory for lightweight runtime feature flags.
 *
 * Each flag holds a boolean state that is set once at server startup and
 * queried by the config route to report enabled/disabled status.
 *
 * @module lib/feature-flag
 */

interface FeatureFlag {
  setEnabled: (enabled: boolean) => void;
  isEnabled: () => boolean;
  setInitError: (error: string) => void;
  getInitError: () => string | undefined;
}

/** Create a runtime feature flag with get/set accessors and optional init error tracking. */
export function createFeatureFlag(): FeatureFlag {
  // A subsystem is running only after its startup path says so. Starting true
  // makes an explicit disable and an initialization failure indistinguishable
  // from a successful start on the config wire (DOR-1966).
  const state: { enabled: boolean; initError?: string } = { enabled: false };
  return {
    setEnabled: (enabled: boolean) => {
      state.enabled = enabled;
    },
    isEnabled: () => state.enabled,
    setInitError: (error: string) => {
      state.initError = error;
    },
    getInitError: () => state.initError,
  };
}

import type { TransportSlices } from './transport-slices.js';
import type {
  BrowserProfile,
  BrowserInstance,
  BrowserCloseRequest,
  BrowserCloseReceipt,
} from './browser-schemas.js';

/** Supplemental ports of the supported transport, including browser operations. */
export interface TransportSupplementalPorts extends TransportSlices {
  /** Owner-filtered nonsecret browser profile metadata. */
  getBrowserProfiles(signal?: AbortSignal): Promise<BrowserProfile[]>;
  /** Read one accessible profile; unavailable and inaccessible requests reject. */
  getBrowserProfile(profileId: string, signal?: AbortSignal): Promise<BrowserProfile>;
  /** Current original generation projections, never an authority token. */
  getBrowserInstances(signal?: AbortSignal): Promise<BrowserInstance[]>;
  /** Read the exact original generation without silently replacing it. */
  getBrowserInstance(
    browserId: string,
    browserGeneration: number,
    signal?: AbortSignal
  ): Promise<BrowserInstance>;
  /** Explicit stop; unverified cleanup remains an unverified receipt. */
  closeBrowserInstance(
    request: BrowserCloseRequest,
    signal?: AbortSignal
  ): Promise<BrowserCloseReceipt>;
}

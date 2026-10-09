import type { EgressPolicyCode } from '../errors.js';

/** Private original-policy observation, captured by the broker constructor; grants no forwarding authority. */
export type OriginalConnectDenial = Readonly<{
  browserId: string;
  browserGeneration: number;
  authority: string;
  outcome: 'denied';
  beforeDial: true;
  reason: EgressPolicyCode;
}>;
/** Synchronous telemetry entry; async send ownership belongs to the original armed IPC sender. */
export type OriginalConnectDenialObserver = (value: OriginalConnectDenial) => void;

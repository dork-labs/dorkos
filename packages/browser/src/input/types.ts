import type { BrowserBinding, BrowserInputStep, BrowserResult } from '../contracts.js';
import type { BrowserStopGate } from '../lifecycle/stop.js';

/** Atomic operations only; a click is expanded before admission. No DOM setter/evaluation port. */
export type NativeInputStep = Exclude<BrowserInputStep, { kind: 'click' }>;
export type InputResult = Extract<BrowserResult, { kind: 'action' }>;
export type InputReason = Extract<InputResult, { reason: unknown }>['reason'];
export type ResetResult = Readonly<{ binding: BrowserBinding; status: 'ready' | 'stopped' }>;

/** Trusted, private transport. AbortSignal is notification, never proof of native cancellation. */
export interface NativeInputTransport {
  dispatch(step: NativeInputStep, signal: AbortSignal): Promise<void>;
  cancelComposition(signal: AbortSignal): Promise<void>;
  cancelDrag(signal: AbortSignal): Promise<void>;
}

/** Registry/authority ports are trusted engine/server wiring, not request-body capabilities. */
export interface InputPorts {
  readBinding(): BrowserBinding | null;
  publishResetBinding(binding: BrowserBinding): void;
  authorize(
    binding: BrowserBinding,
    step: NativeInputStep,
    signal: AbortSignal
  ): Promise<'allowed' | 'refused' | 'unknown'>;
  native: NativeInputTransport;
  stopGate: BrowserStopGate;
}

/** Implemented input leaf; parent owns transport and registry wiring, not this queue's state. */
export interface TabInput {
  submit(command: unknown, signal?: AbortSignal): Promise<InputResult>;
  reset(): Promise<ResetResult>;
  stop(): void;
}

import type { OwnedInputWork } from './owned-work.js';
import type { BrowserBinding, BrowserInputStep, BrowserResult } from '../contracts.js';
import type { BrowserStopGate } from '../lifecycle/stop.js';
import type { CleanupPermit, CleanupAttempt, CleanupObservation } from '../lifecycle/ownership.js';
import type { ReleaseLedger } from './held.js';

/** Atomic operations only; a click is expanded before admission. No DOM setter/evaluation port. */
export type NativeInputStep = Exclude<BrowserInputStep, { kind: 'click' }>;
export type InputResult = Extract<BrowserResult, { kind: 'action' }>;
export type InputReason = Extract<InputResult, { reason: unknown }>['reason'];
export type ResetResult = Readonly<{ binding: BrowserBinding; status: 'ready' | 'stopped' }>;

/** Trusted, private transport. AbortSignal is notification, never proof of native cancellation. */
export interface NativeInputTransport {
  dispatch(step: NativeInputStep, signal: AbortSignal, current?: () => boolean): Promise<void>;
  cancelComposition(signal: AbortSignal): Promise<void>;
  cancelDrag(signal: AbortSignal): Promise<void>;
  cleanup(permit: CleanupPermit, attempt: CleanupAttempt, signal: AbortSignal): Promise<void>;
}

/** Cleanup commands are fixed conservative releases, never arbitrary text/down/navigation/CDP. */
export type CleanupInputStep =
  | Extract<NativeInputStep, { kind: 'keyUp' | 'mouseUp' }>
  | Readonly<{ kind: 'cancelComposition' }>
  | Readonly<{ kind: 'cancelDrag' }>;

/** Exact producer-owned route; no method is installed from an input/action body. */
export interface InputCleanupRoute {
  requestRetirement(cause: import('../lifecycle/ownership.js').RetirementCause): void;
  terminal(): boolean;
  ordinary(): boolean;
  retiring(): boolean;
  binding(): BrowserBinding | null;
  registerTarget(
    page: import('../lifecycle/records.js').TabRecord['page'],
    transport: object,
    session: object
  ): void;
  registerLedger(ledger: ReleaseLedger): boolean;
  releaseLedger(ledger: ReleaseLedger): void;
  permit(binding: BrowserBinding, end: number): CleanupPermit | null;
  enter(permit: CleanupPermit, attempt: CleanupAttempt): boolean;
  allows(
    permit: CleanupPermit,
    binding: BrowserBinding,
    transport: object,
    session: object,
    page: import('../lifecycle/records.js').TabRecord['page']
  ): boolean;
  settlement(
    binding: BrowserBinding,
    transport: object,
    session: object,
    page: import('../lifecycle/records.js').TabRecord['page']
  ): boolean;
}

/** Registry/authority ports are trusted engine/server wiring, not request-body capabilities. */
export interface InputPorts {
  readonly cleanup: InputCleanupRoute;
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
  submit(command: unknown, signal?: AbortSignal, ownedWork?: OwnedInputWork): Promise<InputResult>;
  reset(): Promise<ResetResult>;
  retire(end: number): Promise<CleanupObservation>;
  stop(): void;
}

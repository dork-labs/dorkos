import type { BrowserBinding } from '../contracts.js';
import { sameBinding } from '../input/binding.js';
/** Native-completed movement metadata, never control authority or OS pointer truth. */
export interface PointerMarker {
  readonly x: number;
  readonly y: number;
  readonly revision: number;
}
/** Exact immutable frame snapshot; terminal changes matter even when revision cannot increase. */
export interface PointerSnapshot {
  readonly revision: number;
  readonly terminal: boolean;
  readonly marker: PointerMarker | null;
}
/** Only synchronous internal closures are supported; unexpected return properties are never observed. */
export interface PointerLedger {
  beginMove(x: number, y: number): object | null;
  success(ticket: object | null): void;
  invalidate(): void;
  unavailable(): void;
  accepts(ticket: unknown): boolean;
  read(): PointerSnapshot;
}
/** Own one active ticket and compare complete canonical binding at every observation. */
export function createPointerLedger(
  readBinding: () => BrowserBinding | null,
  initialRevision = 0
): PointerLedger {
  if (!Number.isSafeInteger(initialRevision) || initialRevision < 0)
    throw new Error('POINTER_COUNTER_REFUSED');
  let revision = initialRevision,
    terminal = false,
    marker: PointerMarker | null = null;
  let ticket: object | null = null,
    binding: BrowserBinding | null = null;
  let position: { x: number; y: number } | null = null;
  const unavailable = () => {
    terminal = true;
    marker = null;
    ticket = null;
    position = null;
    binding = null;
  };
  const invalidate = () => {
    marker = null;
    ticket = null;
    position = null;
    binding = null;
    if (!terminal && revision < Number.MAX_SAFE_INTEGER) revision++;
    else unavailable();
  };
  const current = () => {
    if (terminal) return false;
    const captured = binding,
      enteredRevision = revision;
    try {
      const observed = readBinding();
      if (
        !terminal &&
        captured &&
        binding === captured &&
        revision === enteredRevision &&
        sameBinding(observed, captured)
      )
        return true;
    } catch {
      unavailable();
    }
    invalidate();
    return false;
  };
  const ledger: PointerLedger = {
    beginMove(x, y) {
      invalidate();
      if (terminal) return null;
      const enteredRevision = revision;
      const captured = readBinding();
      if (
        terminal ||
        revision !== enteredRevision ||
        !captured ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        x < 0 ||
        y < 0
      )
        return null;
      binding = Object.freeze({ ...captured });
      position = { x, y };
      ticket = Object.freeze({});
      return ticket;
    },
    success(candidate) {
      const enteredRevision = revision;
      if (
        !candidate ||
        candidate !== ticket ||
        !current() ||
        candidate !== ticket ||
        revision !== enteredRevision ||
        !position
      )
        return;
      marker = Object.freeze({ ...position, revision });
      ticket = null;
      position = null;
    },
    invalidate,
    unavailable,
    accepts: (candidate) => candidate === ticket && candidate !== null,
    read() {
      if (binding) current();
      return Object.freeze({ revision, terminal, marker });
    },
  };
  return Object.freeze(ledger);
}

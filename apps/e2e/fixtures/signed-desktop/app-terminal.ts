import type { ChildProcess } from 'node:child_process';

type Return = Readonly<{ exitCode: number | null; signalCode: string | null }>;
type Slot = { child: ChildProcess; terminal: Promise<void> };
// Unknown original close history remains owned; an exit field never releases this bank.
const pending = new Set<Slot>();

/** Capture immediately after the original SDK returns its child. No inferred close result. */
export function retainOriginalPackagedAppTerminal(child: ChildProcess) {
  const enteredLive = child.exitCode === null && child.signalCode === null;
  let returned: Return | undefined;
  const terminal = new Promise<void>((resolve) => {
    child.once('close', (exitCode, signalCode) => {
      returned = Object.freeze({ exitCode, signalCode });
      pending.delete(slot);
      resolve();
    });
  });
  const slot: Slot = { child, terminal };
  pending.add(slot);
  return Object.freeze({
    enteredLive,
    terminal,
    async join() {
      // A nonlive SDK return may have missed close. Keep the exact promise and child
      // retained, report unavailable, and refuse the leg rather than wait forever.
      if (enteredLive || returned) await terminal;
      return Object.freeze({
        close: returned ? ('observed' as const) : ('unavailable' as const),
        returned: returned ?? null,
        pending: pending.has(slot),
      });
    },
  });
}

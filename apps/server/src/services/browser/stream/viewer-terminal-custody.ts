import type { BrowserBinding } from '@dorkos/shared/browser-schemas';
import { isOriginalCaptureCancellation } from './capture-cancellation.js';

type Terminal = Readonly<{
  actorIdentity: object;
  binding: BrowserBinding;
  work?: Promise<void>;
}>;

/** Terminal custody routes exact authenticated cleanup; it never admits frames or retains pixels. */
export class ViewerTerminalCustody {
  private readonly navigation = new Map<string, Terminal>();
  private readonly capture = new Map<string, Terminal>();

  get size(): number {
    return this.navigation.size + this.capture.size;
  }

  has(token: string): boolean {
    return this.navigation.has(token) || this.capture.has(token);
  }

  get(token: string): Terminal | undefined {
    return this.navigation.get(token) ?? this.capture.get(token);
  }

  retainNavigation(token: string, terminal: Terminal): void {
    this.navigation.set(
      token,
      Object.freeze({
        actorIdentity: terminal.actorIdentity,
        binding: terminal.binding,
        work: terminal.work,
      })
    );
  }

  retainCapture(token: string, terminal: Terminal): void {
    const work = terminal.work;
    if (!work || this.navigation.has(token)) return;
    const original = Object.freeze({
      actorIdentity: terminal.actorIdentity,
      binding: terminal.binding,
      work,
    });
    this.capture.set(token, original);
    const settled = () => {
      if (this.capture.get(token) === original) this.capture.delete(token);
    };
    // The existing work bank bounds these still-pending originals at sixteen.
    void original.work.then(settled, settled);
  }

  consume(token: string): void {
    this.navigation.delete(token);
    this.capture.delete(token);
  }

  clear(): void {
    this.navigation.clear();
    this.capture.clear();
  }
}

/** Keep only the exact original capture terminal, discarding its resolved pixel value. */
export function retainViewerCaptureTerminal(original: Promise<unknown>): Promise<void> {
  const terminal = original.then(() => undefined);
  void terminal.catch(() => undefined);
  return terminal;
}

/** Genuine lifetime cancellation alone is expected after the original viewer fence. */
export function joinViewerCaptureTerminal(pending?: Promise<void>): Promise<void> {
  return pending
    ? pending.then(
        () => undefined,
        (value: unknown) => {
          if (!isOriginalCaptureCancellation(value)) throw value;
        }
      )
    : Promise.resolve();
}

/** Join every entered capture before reading the original observation failure cell. */
export async function joinViewerCaptureTerminals(
  originals: readonly Promise<unknown>[],
  readFailure: () => Readonly<{ value: unknown }> | undefined
): Promise<void> {
  const results = await Promise.allSettled(originals);
  const first = results.find(
    (result) => result.status === 'rejected' && !isOriginalCaptureCancellation(result.reason)
  );
  const observationFailure = readFailure();
  if (observationFailure) throw observationFailure.value;
  if (first?.status === 'rejected') throw first.reason;
}

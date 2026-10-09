import { BrowserBindingSchema, type BrowserBinding } from '@dorkos/shared/browser-schemas';
import { BrowserApiRefusal } from './service.js';

const lifetime = (binding: BrowserBinding) =>
  JSON.stringify([binding.browserId, binding.browserGeneration, binding.tabId]);
const sameLifetime = (a: BrowserBinding, b: BrowserBinding) => lifetime(a) === lifetime(b);

/** Original native navigation completions only; joining conveys no actor or input permission. */
export class BrowserNavigationTransitions {
  private readonly pending = new Map<Promise<Readonly<BrowserBinding>>, Readonly<BrowserBinding>>();
  private readonly failures = new Map<
    string,
    Readonly<{ binding: Readonly<BrowserBinding>; reason: unknown }>
  >();
  private closed = false;
  private closing?: Promise<void>;

  /** Charge the actual engine-owned operation before its first fallible native continuation. */
  observe(value: BrowserBinding, original: Promise<Readonly<BrowserBinding>>): void {
    const before = Object.freeze(BrowserBindingSchema.parse(value));
    if (
      this.closed ||
      this.pending.has(original) ||
      this.pending.size >= 16 ||
      this.failures.size >= 128
    )
      throw new BrowserApiRefusal('unavailable');
    this.pending.set(original, before);
    void original.then(
      (result) => {
        try {
          const after = BrowserBindingSchema.parse(result);
          if (
            !sameLifetime(before, after) ||
            after.viewportVersion !== before.viewportVersion ||
            after.epoch !== before.epoch + 1 ||
            after.inputGeneration !== before.inputGeneration + 1 ||
            after.navigationGeneration !== before.navigationGeneration + 1
          )
            throw new BrowserApiRefusal('inaccessible');
        } catch (reason) {
          this.failures.set(
            lifetime(before),
            this.failures.get(lifetime(before)) ?? Object.freeze({ binding: before, reason })
          );
        } finally {
          this.pending.delete(original);
        }
      },
      (reason) => {
        this.failures.set(
          lifetime(before),
          this.failures.get(lifetime(before)) ?? Object.freeze({ binding: before, reason })
        );
        this.pending.delete(original);
      }
    );
  }

  /** Wait for exact matching original cleanup, then let the caller freshly read engine authority. */
  async join(browserId: string, browserGeneration: number): Promise<void> {
    const matches = (binding: BrowserBinding) =>
      binding.browserId === browserId && binding.browserGeneration === browserGeneration;
    while (true) {
      if (this.closed) throw new BrowserApiRefusal('unavailable');
      const originals = [...this.pending]
        .filter(([, binding]) => matches(binding))
        .map(([original]) => original);
      if (!originals.length) break;
      await Promise.allSettled(originals);
    }
    for (const failure of this.failures.values()) {
      if (matches(failure.binding)) throw failure.reason;
    }
    if (this.closed) throw new BrowserApiRefusal('unavailable');
  }

  /** Admission closes immediately; held originals remain charged until their natural return. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = Promise.allSettled([...this.pending.keys()]).then(() => {
      const first = this.failures.values().next();
      if (!first.done) throw first.value.reason;
    });
    return this.closing;
  }
}

import { LocalBrowserError } from '../errors.js';
import { PAGE_READ_RESPONSE_TIMEOUT_MS } from '../lifecycle.js';

interface WaitingOperation {
  effect: boolean;
  execute(): Promise<void>;
  expire(): void;
}

/** Bounded admission per exact Page. Response expiry never releases physical work. */
export class BrowserPageOperations {
  private active = false;
  private effect = false;
  private readonly waiting: WaitingOperation[] = [];

  constructor(private readonly drain: () => Promise<void>) {}

  run<T>(effect: boolean, operation: () => Promise<T>): Promise<T> {
    if (
      this.waiting.length >= 32 ||
      (effect && (this.effect || this.waiting.some((entry) => entry.effect)))
    )
      return Promise.reject(busy());
    return new Promise<T>((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => entry.expire(), PAGE_READ_RESPONSE_TIMEOUT_MS);
      timer.unref?.();
      const entry: WaitingOperation = {
        effect,
        expire: () => {
          expired = true;
          const index = this.waiting.indexOf(entry);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(busy());
        },
        execute: async () => {
          clearTimeout(timer);
          if (expired) return;
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          } finally {
            await this.drain();
          }
        },
      };
      this.waiting.push(entry);
      this.next();
    });
  }

  private next(): void {
    if (this.active) return;
    const entry = this.waiting.shift();
    if (!entry) return;
    this.active = true;
    this.effect = entry.effect;
    void entry
      .execute()
      .finally(() => {
        this.active = this.effect = false;
        this.next();
      })
      .catch(() => undefined);
  }
}
function busy(): LocalBrowserError {
  return new LocalBrowserError('busy', 'A browser operation is finishing. Try again shortly.');
}

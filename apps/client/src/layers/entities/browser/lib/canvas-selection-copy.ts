import type { BrowserInputTransport } from '@dorkos/shared/transport';
import {
  type BrowserBinding,
  type BrowserControl,
  type BrowserViewer,
  BrowserCopySelectionReceiptSchema,
  type BrowserCopySelectionReceipt,
} from '@dorkos/shared/browser-schemas';

/** Closed local refusal copy; arbitrary server/native error text never becomes UI prose. */
class SelectionCopyRefusal extends Error {
  constructor(readonly reason: 'changed' | 'secret' | 'capacity' | 'selection' | 'unsupported') {
    super(reason);
  }
}
const refusalCopy = {
  changed: 'Selection changed. Select text and try again.',
  secret: 'Password or secret fields cannot be copied.',
  capacity: 'Selected browser text is too large.',
  selection: 'Select text in the browser page to copy it.',
  unsupported: 'Copying from this field or frame is unavailable.',
} as const;
/** Browser-owned gesture ports; no clipboard read or native OS shortcut is available. */
export interface SelectionCopyPorts {
  readonly item: typeof ClipboardItem | undefined;
  readonly write: ((items: ClipboardItem[]) => Promise<void>) | undefined;
  capture?(): void;
  current(): boolean;
  read(signal: AbortSignal): Promise<BrowserCopySelectionReceipt>;
  status(message: string): void;
}
/** One actual gesture owns both the promise-backed clipboard write and authenticated selection read. */
export class CanvasSelectionCopy {
  private readonly controller = new AbortController();
  private readonly abort = this.controller.abort.bind(this.controller);
  private pending?: Promise<void>;
  private closing?: Promise<void>;
  private closed = false;
  private readonly item;
  private readonly write;
  private readonly capture;
  private readonly current;
  private readonly read;
  private readonly status;
  constructor(ports: SelectionCopyPorts) {
    this.capture = ports.capture?.bind(ports);
    this.item = ports.item;
    this.write = ports.write?.bind(undefined);
    this.current = ports.current.bind(ports);
    this.read = ports.read.bind(ports);
    this.status = ports.status.bind(ports);
  }
  busy(): boolean {
    return !!this.pending;
  }
  /** Entry must stay synchronous until the original clipboard write acquires browser activation. */
  copy(event: Pick<Event, 'isTrusted' | 'preventDefault'>): boolean {
    if (!event.isTrusted) return false;
    event.preventDefault();
    if (this.closed || this.pending) return true;
    try {
      this.capture?.();
      if (!this.current()) {
        this.status('Selection changed. Select text and try again.');
        return true;
      }
    } catch {
      try {
        this.status('Selection changed. Select text and try again.');
      } catch {
        /* No original producer entered. */
      }
      return true;
    }
    if (!this.item || !this.write) {
      this.status('Copying is unavailable in this browser.');
      return true;
    }
    let done!: (value: void) => void, fail!: (value: unknown) => void;
    const owned = new Promise<void>((yes, no) => {
      done = yes;
      fail = no;
    });
    this.pending = owned;
    void owned.catch(() => undefined);
    const gesture = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, gesture.signal]);
    let first: { value: unknown } | undefined;
    const guard = () => {
      if (first) throw first.value;
      signal.throwIfAborted();
      if (this.closed || !this.current()) throw new SelectionCopyRefusal('changed');
    };
    const payload = Promise.resolve().then(async () => {
      guard();
      const receipt = BrowserCopySelectionReceiptSchema.parse(await this.read(signal));
      guard();
      if (receipt.outcome === 'refused') throw new SelectionCopyRefusal(receipt.reason);
      const blob = new Blob([receipt.text], { type: 'text/plain' });
      guard();
      return blob;
    });
    void payload.catch(() => undefined);
    let original: Promise<void>;
    try {
      guard();
      const item = new this.item({ 'text/plain': payload });
      guard();
      original = Promise.resolve(this.write([item]));
    } catch (value) {
      original = Promise.reject(value);
    }
    void original.catch(() => undefined);
    void (async () => {
      // Observe clipboard refusal immediately; independently retain/join the original read.
      const written = original.catch((value) => {
        first ??= { value };
        gesture.abort(value);
        throw value;
      });
      void written.catch(() => undefined);
      const selected = payload.catch((value) => {
        first ??= { value };
        throw value;
      });
      void selected.catch(() => undefined);
      await Promise.allSettled([written, selected]);
      if (this.pending === owned) this.pending = undefined;
      try {
        if (!this.closed) {
          if (first) {
            let message = 'Copying failed. Check clipboard permission and try again.';
            try {
              if (first.value instanceof SelectionCopyRefusal)
                message = refusalCopy[first.value.reason];
              else if (
                first.value instanceof DOMException &&
                first.value.name === 'NotAllowedError'
              )
                message = 'Clipboard permission was denied.';
            } catch {
              /* Fixed fallback remains. */
            }
            this.status(message);
          } else this.status('Copied selected text.');
        }
      } catch {
        /* A status sink cannot strand original producer settlement. */
      }
      if (first) fail(first.value);
      else done();
    })();
    return true;
  }
  /** Fence new delivery and join the same original write/read; failed gestures never certify a write. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    let done!: () => void, reject!: (value: unknown) => void;
    this.closing = new Promise<void>((yes, no) => {
      done = yes;
      reject = no;
    });
    void this.closing.catch(() => undefined);
    this.closed = true;
    let failure: { value: unknown } | undefined;
    try {
      this.abort();
    } catch (value) {
      failure = { value };
    }
    void Promise.allSettled(this.pending ? [this.pending] : []).then(() => {
      if (failure) reject(failure.value);
      else done();
    });
    return this.closing;
  }
}

/** Capture the exact original rendered owner scope at the gesture, before any asynchronous read. */
export function createRenderedSelectionCopy(
  canvas: HTMLCanvasElement,
  port: BrowserInputTransport,
  read: () => Readonly<{ controller: BrowserControl; viewer: BrowserViewer }>,
  wait: (draw: () => void, signal: AbortSignal) => Promise<void>,
  uuid: () => string,
  closed: () => boolean,
  composing: () => boolean,
  status: (message: string) => void
): CanvasSelectionCopy | undefined {
  const copy = port.copyBrowserSelection?.bind(port);
  if (!copy) return undefined;
  const clipboard = canvas.ownerDocument.defaultView?.navigator.clipboard;
  let scope:
    Readonly<{ controllerId: string; viewerId: string; binding: BrowserBinding }> | undefined;
  const same = (a: BrowserBinding, b: BrowserBinding) =>
    (Object.keys(a) as (keyof BrowserBinding)[]).every((key) => a[key] === b[key]);
  return new CanvasSelectionCopy({
    item: typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem,
    write: clipboard?.write?.bind(clipboard),
    capture() {
      const context = read();
      if (!context.controller.controllerId) throw new SelectionCopyRefusal('changed');
      scope = Object.freeze({
        controllerId: context.controller.controllerId,
        viewerId: context.viewer.viewerId,
        binding: Object.freeze({ ...context.controller.binding }),
      });
    },
    current() {
      try {
        const context = read();
        return (
          !!scope &&
          !closed() &&
          !composing() &&
          scope.controllerId === context.controller.controllerId &&
          scope.viewerId === context.viewer.viewerId &&
          same(scope.binding, context.controller.binding)
        );
      } catch {
        return false;
      }
    },
    async read(signal) {
      const original = scope;
      if (!original) throw new SelectionCopyRefusal('changed');
      await wait(() => undefined, signal);
      const context = read();
      if (
        closed() ||
        composing() ||
        scope !== original ||
        original.controllerId !== context.controller.controllerId ||
        original.viewerId !== context.viewer.viewerId ||
        !same(original.binding, context.controller.binding)
      )
        throw new SelectionCopyRefusal('changed');
      return copy({ requestId: uuid(), binding: original.binding }, original.controllerId, signal);
    },
    status,
  });
}

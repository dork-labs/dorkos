/** Nonissuing frame resource mechanics; recovery supplies closed original decisions. */
import type {
  FrameObservation,
  FrameDocBinding,
  BoundDocPort,
} from '@/layers/shared/lib/canvas-doc-frame';
import type { DocChannelFrameResources } from './doc-channel-frame-resources';
interface LoadOperations {
  current(): boolean;
  complete(): FrameObservation | null;
  accept(loaded: FrameObservation): boolean;
}
interface AttachOperations {
  current(): boolean;
  acquire(): Readonly<{ binding: FrameDocBinding; release(): void }> | null;
  bindingCurrent(binding: FrameDocBinding): boolean;
  createPort(binding: FrameDocBinding): BoundDocPort;
  portCurrent(port: BoundDocPort): boolean;
}
/** Sequence a captured load; this module cannot issue a record or choose its birth. */
export function prepareDocFrameLoad(
  resources: DocChannelFrameResources,
  ticket: number,
  operations: LoadOperations
) {
  const current = () =>
    resources.current(ticket) && operations.current() === true && resources.current(ticket);
  const complete = resources.once(ticket, current, operations.complete);
  return Object.freeze({
    completeLoad: () => {
      const loaded = complete();
      if (!loaded || !current() || operations.accept(loaded) !== true || !current()) return null;
      return loaded;
    },
  });
}
/** Own only a provisional resource returned by recovery's closed binding operation. */
export function attachDocFramePort(
  resources: DocChannelFrameResources,
  ticket: number,
  operations: AttachOperations
): BoundDocPort | null {
  const current = () =>
    resources.current(ticket) && operations.current() === true && resources.current(ticket);
  if (!current()) return null;
  const acquisition = operations.acquire();
  if (!acquisition) return null;
  let transferred = false;
  let result: BoundDocPort | null = null;
  let failure: { cause: unknown } | undefined;
  try {
    const binding = acquisition.binding;
    if (current() && operations.bindingCurrent(binding) === true && current()) {
      const port = operations.createPort(binding);
      if (current() && operations.portCurrent(port) === true && current()) {
        if (resources.install(ticket, acquisition.release)) {
          transferred = true;
          result = port;
        }
      }
    }
  } catch (cause) {
    failure = { cause };
  }
  if (!transferred) {
    try {
      acquisition.release();
    } catch (cleanupCause) {
      failure ??= { cause: cleanupCause };
    }
  }
  if (failure) throw failure.cause;
  return result;
}

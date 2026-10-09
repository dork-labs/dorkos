import { Socket } from 'node:net';
type ColdSocketResult =
  Readonly<{ state: 'connected' }> | Readonly<{ state: 'refused'; cause: unknown }>;
/** Only an actual error event from this exact original Socket may be a cold refusal.
 * Callback-free own fields distinguish it; TypeError/HTTP/error-class shapes confer nothing. */
export async function connectOriginalColdListener(
  port: number,
  sockets: Map<Socket, () => void>,
  guard: () => void
): Promise<ColdSocketResult> {
  guard();
  const originalConnect = Socket.prototype.connect,
    originalDestroy = Socket.prototype.destroy;
  const socket = new Socket();
  let destroying = false,
    stopFailed = false;
  const destroy = () => {
    if (!destroying) {
      destroying = true;
      try {
        Reflect.apply(originalDestroy, socket, []);
      } catch (value) {
        stopFailed = true;
        throw value;
      }
    }
  };
  sockets.set(socket, destroy);
  let first: Readonly<{ value: unknown }> | undefined,
    observedError: Readonly<{ value: unknown }> | undefined;
  let resolveReady!: () => void,
    rejectReady!: (value: unknown) => void,
    readySettled = false;
  const ready = new Promise<void>((yes, no) => {
    resolveReady = yes;
    rejectReady = no;
  });
  const terminal = new Promise<void>((resolve) =>
    socket.once('close', () => {
      if (!readySettled) {
        readySettled = true;
        rejectReady(new Error('PUBLIC_NATIVE_ORIGINAL_SOCKET_CLOSED'));
      }
      resolve();
    })
  );
  void ready.then(
    () => {},
    () => {}
  );
  socket.once('connect', () => {
    readySettled = true;
    resolveReady();
  });
  socket.once('error', (value) => {
    observedError = { value };
    readySettled = true;
    rejectReady(value);
  });
  const connect = originalConnect.bind(socket);
  const timer = setTimeout(() => {
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error('PUBLIC_NATIVE_ORIGINAL_SOCKET_HELD'));
    }
    try {
      destroy();
    } catch (value) {
      first ??= { value };
    }
  }, 1000);
  try {
    guard();
    connect({ host: '127.0.0.1', port });
    await ready;
    guard();
  } catch (value) {
    first ??= { value };
  }
  clearTimeout(timer);
  try {
    destroy();
  } catch (value) {
    first ??= { value };
  }
  const joined = await Promise.allSettled([ready, terminal]);
  for (const result of joined) if (result.status === 'rejected') first ??= { value: result.reason };
  sockets.delete(socket);
  if (first) {
    const original = observedError?.value;
    const data = (name: string) => {
      if (!original || typeof original !== 'object') return undefined;
      const field = Object.getOwnPropertyDescriptor(original, name);
      return field && Object.prototype.hasOwnProperty.call(field, 'value')
        ? field.value
        : undefined;
    };
    if (
      observedError &&
      !stopFailed &&
      Object.is(first.value, original) &&
      data('code') === 'ECONNREFUSED' &&
      data('syscall') === 'connect' &&
      data('address') === '127.0.0.1' &&
      data('port') === port
    )
      return Object.freeze({ state: 'refused', cause: original });
    throw first.value;
  }
  return Object.freeze({ state: 'connected' });
}

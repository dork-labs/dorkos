import { ServerResponse } from 'node:http';

/** Hold one actual fixture response and retain its exact release and close duties. */
export function ownOriginalBackgroundResponseGate(response: ServerResponse, current: () => void) {
  if (!(response instanceof ServerResponse))
    throw new Error('BACKGROUND_ORIGINAL_RESPONSE_REQUIRED');
  current();
  if (response.destroyed || response.writableEnded) throw new Error('BACKGROUND_RESPONSE_NOT_LIVE');
  const originalEnd = response.end;
  const originalDestroy = response.destroy;
  const originalFlush = response.flushHeaders;
  const originalSetHeader = response.setHeader;
  const originalOnce = response.once;
  let first: { value: unknown } | undefined;
  let returned!: () => void;
  const closed = new Promise<void>((resolve) => {
    returned = resolve;
  });
  let observedClosed = false;
  Reflect.apply(originalOnce, response, [
    'close',
    () => {
      observedClosed = true;
      returned();
    },
  ]);
  Reflect.apply(originalOnce, response, [
    'error',
    (value: unknown) => {
      first ??= { value };
    },
  ]);
  let releasing: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () => {
    if (stopping) return stopping;
    let resolve!: () => void;
    let reject!: (value: unknown) => void;
    stopping = new Promise<void>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void stopping.catch(() => {});
    try {
      Reflect.apply(originalDestroy, response, []);
    } catch (value) {
      first ??= { value };
    }
    void closed.then(() => {
      if (first) reject(first.value);
      else resolve();
    });
    return stopping;
  };
  try {
    current();
    if (response.destroyed || response.writableEnded)
      throw new Error('BACKGROUND_RESPONSE_NOT_LIVE');
    response.statusCode = 200;
    Reflect.apply(originalSetHeader, response, ['content-type', 'text/plain']);
    Reflect.apply(originalSetHeader, response, ['cache-control', 'no-store']);
    Reflect.apply(originalFlush, response, []);
  } catch (value) {
    first ??= { value };
    void stop().catch(() => {});
    throw value;
  }
  return Object.freeze({
    originalClose: closed,
    isOriginalClosed: () => observedClosed,
    releaseOriginalResponse() {
      if (releasing) return releasing;
      let resolve!: () => void;
      let reject!: (value: unknown) => void;
      releasing = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void releasing.catch(() => {});
      try {
        if (first) throw first.value;
        current();
        if (stopping || response.destroyed || response.writableEnded)
          throw new Error('BACKGROUND_GATE_NOT_LIVE');
        Reflect.apply(originalEnd, response, ['Original owned background gate released\n']);
      } catch (value) {
        first ??= { value };
        void stop().catch(() => {});
      }
      void closed.then(() => {
        if (first) reject(first.value);
        else resolve();
      });
      return releasing;
    },
    close: stop,
  });
}

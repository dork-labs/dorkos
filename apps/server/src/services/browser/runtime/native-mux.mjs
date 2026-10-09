import { RecordDecoder, encodeRecord, checkScope, CAPS } from './guest-mux.mjs';
import { inspectRetainedOriginalSerial as inspectNativeSerial } from './native-fifo-owner.mjs';
const lanes = new WeakMap();
const refuse = (code) => new Error(code);

/** Original native FIFO byte duties, never replacement Node streams. The fixed
 * scope and outer decoder remain distinct from the inner proxy protocol. */
export function createNativeMux({ serial, selected, consume, onFailure }) {
  const original = inspectNativeSerial(serial),
    scope = checkScope(selected);
  if (typeof consume !== 'function' || typeof onFailure !== 'function')
    throw refuse('NATIVE_MUX_CONSUMER');
  let first,
    stopped = false,
    sequence = 0,
    bank = 0,
    writer = Promise.resolve();
  let receiver,
    issued = false,
    closing;
  const pending = new Set();
  const fail = (value) => {
    first ??= { value };
    if (!stopped) {
      stopped = true;
      original.revoke();
      try {
        onFailure(first.value);
      } catch {
        /* The original failure is already latched; diagnostic observer faults cannot replace it. */
      }
    }
  };
  const guard = () => {
    if (first) throw first.value;
    if (stopped) throw refuse('NATIVE_MUX_REVOKED');
  };
  const own = (job) => {
    pending.add(job);
    job.then(
      () => pending.delete(job),
      (value) => {
        fail(value);
        pending.delete(job);
      }
    );
    return job;
  };
  let delivery;
  const decoder = new RecordDecoder(scope, 'guest-host', (row, bytes) => {
    guard();
    const job = own(
      Promise.resolve().then(async () => {
        guard();
        if (row.channel === 'proxy') {
          if (!receiver) throw refuse('NATIVE_MUX_PROXY_NOT_READY');
          await receiver(bytes);
        } else await consume(row, bytes);
        guard();
      })
    );
    delivery.push(job); // Reserved before any original callback can reenter.
  });
  original.attachConsumer(async (bytes) => {
    guard();
    const entered = [];
    delivery = entered;
    try {
      decoder.push(bytes);
      const results = await Promise.allSettled(entered);
      for (const result of results) if (result.status === 'rejected') throw result.reason;
      guard();
    } catch (value) {
      fail(value);
      throw first.value;
    } finally {
      delivery = undefined;
    }
  });
  original.closed.then(() => {
    if (!stopped) {
      try {
        decoder.finish();
        fail(refuse('NATIVE_MUX_ORIGINAL_EOF'));
      } catch (value) {
        fail(value);
      }
    }
  }, fail);
  const send = (channel, bytes) => {
    try {
      guard();
    } catch (value) {
      return Promise.reject(value);
    }
    const next = sequence + 1;
    let record;
    try {
      record = encodeRecord(scope, 'host-guest', next, channel, bytes);
    } catch (value) {
      return Promise.reject(value);
    }
    if (record.length > CAPS.bank - bank) return Promise.reject(refuse('NATIVE_MUX_WRITE_BANK'));
    sequence = next;
    bank += record.length;
    const job = own(
      writer.then(async () => {
        guard();
        await original.write(record);
        guard();
      })
    );
    writer = job;
    job.then(
      () => {
        bank -= record.length;
      },
      () => {
        bank -= record.length;
      }
    );
    return job;
  };
  const owner = Object.freeze({
    send,
    proxySerial() {
      guard();
      if (issued) throw refuse('NATIVE_MUX_LANE_ISSUED');
      issued = true;
      const token = Object.freeze(Object.create(null));
      lanes.set(
        token,
        Object.freeze({
          attachConsumer(callback) {
            guard();
            if (receiver || typeof callback !== 'function')
              throw refuse('NATIVE_MUX_LANE_CONSUMER');
            receiver = callback;
          },
          async write(bytes) {
            if (!(bytes instanceof Uint8Array) || bytes.length > CAPS.bank)
              throw refuse('NATIVE_MUX_LANE_BYTES');
            for (let offset = 0; offset < bytes.length; offset += CAPS.payload)
              await send('proxy', bytes.subarray(offset, offset + CAPS.payload));
          },
          revoke() {
            stopped = true;
            original.revoke();
          },
          end: () => original.end(),
          closed: original.closed,
        })
      );
      return token;
    },
    close() {
      if (closing) return closing;
      stopped = true;
      original.revoke();
      closing = (async () => {
        const ended = Promise.resolve().then(() => original.end());
        ended.catch((value) => {
          first ??= { value };
        });
        await Promise.allSettled([ended, original.closed]);
        while (pending.size) await Promise.allSettled([...pending]);
        if (first) throw first.value;
      })();
      closing.catch(() => {});
      return closing;
    },
    snapshot: () => Object.freeze({ stopped, bank, pending: pending.size }),
  });
  return owner;
}
/** Only this module's original mux can mint the inner proxy byte capability. */
export function inspectRetainedOriginalSerial(token) {
  const lane = lanes.get(token);
  if (!lane) throw refuse('ORIGINAL_NATIVE_MUX_LANE_REQUIRED');
  return lane;
}

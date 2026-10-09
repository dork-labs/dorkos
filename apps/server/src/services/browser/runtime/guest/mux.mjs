import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { Readable, Writable } from 'node:stream';
const lanes = new WeakMap();
export const CAPS = Object.freeze({ metadata: 4096, payload: 65536, bank: 131072, frame: 2097152 });
const refusal = (code) => new Error(code);
export function checkScope(v) {
  if (
    !v ||
    Object.keys(v).sort().join(',') !== 'browserId,generation,nonce' ||
    typeof v.browserId !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(v.browserId) ||
    !Number.isSafeInteger(v.generation) ||
    v.generation < 0 ||
    typeof v.nonce !== 'string' ||
    !/^[a-f0-9]{48}$/.test(v.nonce)
  )
    throw refusal('MUX_SCOPE');
  return Object.freeze({ browserId: v.browserId, generation: v.generation, nonce: v.nonce });
}
export function encodeRecord(scope, direction, sequence, channel, bytes) {
  checkScope(scope);
  if (
    !['host-guest', 'guest-host'].includes(direction) ||
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !['bootstrap', 'control', 'frame', 'proxy'].includes(channel) ||
    !(bytes instanceof Uint8Array) ||
    bytes.length > CAPS.payload
  )
    throw refusal('MUX_RECORD');
  const meta = Buffer.from(JSON.stringify({ version: 1, ...scope, direction, sequence, channel }));
  const frame = Buffer.alloc(8 + meta.length + bytes.length);
  frame.writeUInt32BE(meta.length);
  frame.writeUInt32BE(bytes.length, 4);
  meta.copy(frame, 8);
  Buffer.from(bytes).copy(frame, 8 + meta.length);
  return frame;
}
export class RecordDecoder {
  constructor(selected, direction, consume) {
    this.scope = selected && checkScope(selected);
    this.direction = direction;
    this.consume = consume;
    this.header = Buffer.alloc(8);
    this.headerUsed = 0;
    this.body = null;
    this.used = 0;
    this.sequence = 0;
    this.failure = null;
    this.ended = false;
  }
  push(bytes) {
    if (this.failure) throw this.failure.value;
    try {
      if (this.ended || !(bytes instanceof Uint8Array) || bytes.length > CAPS.bank)
        throw refusal('MUX_INPUT');
      let offset = 0;
      while (offset < bytes.length) {
        if (!this.body) {
          const take = Math.min(8 - this.headerUsed, bytes.length - offset);
          this.header.set(bytes.subarray(offset, offset + take), this.headerUsed);
          offset += take;
          this.headerUsed += take;
          if (this.headerUsed !== 8) continue;
          this.m = this.header.readUInt32BE(0);
          this.n = this.header.readUInt32BE(4);
          if (this.m < 1 || this.m > CAPS.metadata || this.n > CAPS.payload)
            throw refusal('MUX_LENGTH');
          this.body = Buffer.alloc(this.m + this.n);
          this.used = 0;
        }
        const take = Math.min(this.body.length - this.used, bytes.length - offset);
        this.body.set(bytes.subarray(offset, offset + take), this.used);
        this.used += take;
        offset += take;
        if (this.used !== this.body.length) continue;
        const row = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(this.body.subarray(0, this.m))
        );
        if (
          !row ||
          Object.keys(row).sort().join(',') !==
            'browserId,channel,direction,generation,nonce,sequence,version' ||
          row.version !== 1 ||
          row.direction !== this.direction ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence !== this.sequence + 1 ||
          !['bootstrap', 'control', 'frame', 'proxy'].includes(row.channel)
        )
          throw refusal('MUX_RECORD');
        const observed = checkScope({
          browserId: row.browserId,
          generation: row.generation,
          nonce: row.nonce,
        });
        if (!this.scope) {
          if (row.channel !== 'bootstrap' || row.sequence !== 1)
            throw refusal('MUX_BOOTSTRAP_REQUIRED');
          this.scope = observed;
        }
        if (Object.keys(observed).some((k) => observed[k] !== this.scope[k]))
          throw refusal('MUX_STALE');
        this.sequence = row.sequence;
        const payload = Buffer.from(this.body.subarray(this.m));
        this.body = null;
        this.headerUsed = 0;
        this.consume(Object.freeze(row), payload);
      }
    } catch (value) {
      this.failure ??= { value };
      this.body = null;
      throw this.failure.value;
    }
  }
  finish() {
    this.ended = true;
    if (this.failure) throw this.failure.value;
    if (this.headerUsed || this.body) throw refusal('MUX_TRUNCATED');
  }
}
export function writeOriginal(output, bytes, fail) {
  return new Promise((resolve, reject) => {
    let entered = false,
      callback = false,
      drained = false,
      first;
    const done = () => {
      if (entered && callback && (drained || first)) {
        output.off('close', close);
        output.off('error', error);
        output.off('drain', drain);
        if (first) reject(first.value);
        else resolve();
      }
    };
    const error = (value) => {
      first ??= { value };
      fail(value);
      done();
    };
    const close = () => error(refusal('MUX_WRITE_CLOSED'));
    const drain = () => {
      drained = true;
      done();
    };
    output.on('close', close);
    output.on('error', error);
    output.on('drain', drain);
    try {
      drained ||= output.write(bytes, (value) => {
        callback = true;
        if (value !== undefined && value !== null) error(value);
        done();
      });
      entered = true;
      done();
    } catch (value) {
      entered = true;
      callback = true;
      error(value);
    }
  });
}
/** Own the actual PID1-created FIFO streams. Logical lanes are not replacements
 * for those originals and their closure is never process/profile authority. */
export function ownMux({ input, output, selected, direction, consume, onFailure }) {
  if (
    !(input instanceof Readable) ||
    !(output instanceof Writable) ||
    typeof consume !== 'function' ||
    typeof onFailure !== 'function'
  )
    throw refusal('MUX_ORIGINAL_STREAMS');
  let scope = selected && checkScope(selected),
    first,
    stopped = false,
    busy = false,
    bank = 0,
    sequence = 0,
    writer = Promise.resolve(),
    eof = false;
  const pending = new Set();
  const inputClose = new Promise((resolve) => input.once('close', resolve));
  const outputClose = new Promise((resolve) => output.once('close', resolve));
  const fail = (value) => {
    first ??= { value };
    if (!stopped) {
      stopped = true;
      input.resume();
      try {
        onFailure(first.value);
      } catch {
        /* The original failure is already latched; diagnostic observer faults cannot replace it. */
      }
    }
  };
  const own = (job) => {
    pending.add(job);
    void job.then(
      () => pending.delete(job),
      (value) => {
        fail(value);
        pending.delete(job);
      }
    );
    return job;
  };
  const decoder = new RecordDecoder(
    scope,
    direction === 'guest-host' ? 'host-guest' : 'guest-host',
    (row, bytes) => {
      scope ??= decoder.scope;
      consume(row, bytes);
    }
  );
  input.on('error', fail);
  output.on('error', fail);
  input.on('data', (bytes) => {
    input.pause();
    if (stopped) {
      input.resume();
      return;
    }
    if (busy || bytes.length > CAPS.bank) {
      fail(refusal('MUX_READ_BANK'));
      return;
    }
    busy = true;
    const copy = Buffer.from(bytes);
    const job = own(
      Promise.resolve().then(() => {
        if (stopped) throw refusal('MUX_REVOKED');
        decoder.push(copy);
      })
    );
    void job.then(
      () => {
        busy = false;
        if (!stopped) input.resume();
      },
      () => {
        busy = false;
      }
    );
  });
  input.once('end', () => {
    eof = true;
    try {
      decoder.finish();
      fail(refusal('MUX_MANAGER_EOF'));
    } catch (value) {
      fail(value);
    }
  });
  input.once('close', () => {
    if (!eof && !stopped) fail(refusal('MUX_INPUT_CLOSE'));
  });
  const send = (channel, bytes) => {
    if (stopped || !scope) return Promise.reject(refusal('MUX_REVOKED'));
    if (!(bytes instanceof Uint8Array) || bytes.length > CAPS.payload)
      return Promise.reject(refusal('MUX_BYTES'));
    const next = sequence + 1;
    const record = encodeRecord(scope, direction, next, channel, bytes);
    if (record.length > CAPS.bank - bank) return Promise.reject(refusal('MUX_WRITE_BANK'));
    sequence = next;
    bank += record.length;
    const job = own(
      writer.then(() => {
        if (stopped) throw refusal('MUX_REVOKED');
        return writeOriginal(output, record, fail);
      })
    );
    writer = job;
    void job.then(
      () => {
        bank -= record.length;
      },
      () => {
        bank -= record.length;
      }
    );
    return job;
  };
  let issued = false,
    laneReceiver,
    laneStopped = false,
    closing;
  const owner = Object.freeze({
    send,
    get scope() {
      return scope;
    },
    deliverProxy(bytes) {
      if (stopped || laneStopped || !laneReceiver) throw refusal('MUX_PROXY_NOT_READY');
      laneReceiver(bytes);
    },
    proxyLane() {
      if (issued) throw refusal('MUX_LANE_ISSUED');
      issued = true;
      const token = Object.freeze(Object.create(null));
      lanes.set(
        token,
        Object.freeze({
          subscribe(fn) {
            if (laneReceiver || typeof fn !== 'function') throw refusal('MUX_LANE_CONSUMER');
            laneReceiver = fn;
          },
          async write(bytes) {
            if (laneStopped || stopped) throw refusal('MUX_LANE_REVOKED');
            for (let offset = 0; offset < bytes.length; offset += CAPS.payload)
              await send('proxy', bytes.subarray(offset, offset + CAPS.payload));
          },
          revoke() {
            laneStopped = true;
          },
          async join() {
            while (pending.size) await Promise.allSettled([...pending]);
            if (first) throw first.value;
          },
        })
      );
      return token;
    },
    revoke() {
      stopped = true;
      laneStopped = true;
      input.resume();
    },
    close() {
      return (closing ??= (async () => {
        owner.revoke();
        input.destroy();
        output.destroy();
        await Promise.allSettled([inputClose, outputClose]);
        while (pending.size) await Promise.allSettled([...pending]);
        if (first) throw first.value;
      })());
    },
    snapshot: () => Object.freeze({ stopped, busy, bank, pending: pending.size }),
  });
  return owner;
}
/** Internal module seam only. Cannot be minted by guest JSON or arbitrary stream. */
export function inspectProxyLane(token) {
  const lane = lanes.get(token);
  if (!lane) throw refusal('MUX_ORIGINAL_LANE');
  return lane;
}

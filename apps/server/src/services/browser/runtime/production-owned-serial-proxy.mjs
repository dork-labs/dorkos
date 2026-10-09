import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { inspectRetainedOriginalSerial } from './native-mux.mjs';
import { createServer } from 'node:net';
import { connectOriginalPreparedBrokerEndpoint } from '../egress/broker/live/production-composition.js';
import { randomBytes } from 'node:crypto';

export const LIMITS = Object.freeze({
  streams: 32,
  metadata: 16384,
  payload: 65536,
  queued: 131072,
});
const operations = new Set(['open', 'accepted', 'data', 'end', 'reset', 'closed', 'credit']);
const refuse = (code) => new Error(code);

/** Fresh host-selected transport scope; not an admission grant or guest identity proof. */
export function createSerialScope(browserId, generation) {
  if (
    typeof browserId !== 'string' ||
    !/^[A-Za-z0-9_-]{22}$/.test(browserId) ||
    !Number.isSafeInteger(generation) ||
    generation < 0
  )
    throw refuse('SERIAL_SCOPE');
  return Object.freeze({ browserId, generation, nonce: randomBytes(24).toString('hex') });
}
function scope(value) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'browserId,generation,nonce' ||
    !/^[A-Za-z0-9_-]{22}$/.test(value.browserId) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    !/^[a-f0-9]{48}$/.test(value.nonce)
  )
    throw refuse('SERIAL_SCOPE');
  return Object.freeze({
    browserId: value.browserId,
    generation: value.generation,
    nonce: value.nonce,
  });
}

/** Length is checked before allocation; only complete records reach the exact original consumer. */
export class ProxyRecordDecoder {
  constructor(selected, direction, consume) {
    this.scope = scope(selected);
    this.direction = direction;
    this.consume = consume;
    this.sequence = 0;
    this.header = Buffer.alloc(8);
    this.headerUsed = 0;
    this.body = undefined;
    this.used = 0;
    this.first = undefined;
    this.ended = false;
  }
  push(bytes) {
    if (this.first) throw this.first.value;
    if (this.ended) throw refuse('SERIAL_CLOSED');
    try {
      if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw refuse('SERIAL_BYTES');
      let offset = 0;
      while (offset < bytes.byteLength) {
        if (!this.body) {
          const take = Math.min(8 - this.headerUsed, bytes.byteLength - offset);
          this.header.set(bytes.subarray(offset, offset + take), this.headerUsed);
          offset += take;
          this.headerUsed += take;
          if (this.headerUsed !== 8) continue;
          this.metadataLength = this.header.readUInt32BE(0);
          this.payloadLength = this.header.readUInt32BE(4);
          if (
            this.metadataLength < 1 ||
            this.metadataLength > LIMITS.metadata ||
            this.payloadLength > LIMITS.payload
          )
            throw refuse('SERIAL_LENGTH');
          this.body = Buffer.alloc(this.metadataLength + this.payloadLength);
          this.used = 0;
        }
        const take = Math.min(this.body.length - this.used, bytes.byteLength - offset);
        this.body.set(bytes.subarray(offset, offset + take), this.used);
        offset += take;
        this.used += take;
        if (this.used !== this.body.length) continue;
        const body = this.body;
        const row = JSON.parse(
          new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(0, this.metadataLength))
        );
        if (
          !row ||
          Object.keys(row).sort().join(',') !==
            'browserId,direction,generation,nonce,op,sequence,stream,version' ||
          row.version !== 1 ||
          row.browserId !== this.scope.browserId ||
          row.generation !== this.scope.generation ||
          row.nonce !== this.scope.nonce ||
          row.direction !== this.direction ||
          !operations.has(row.op) ||
          !Number.isSafeInteger(row.sequence) ||
          row.sequence !== this.sequence + 1 ||
          !Number.isSafeInteger(row.stream) ||
          row.stream < 1 ||
          (row.op === 'data'
            ? this.payloadLength < 1
            : row.op === 'credit'
              ? this.payloadLength !== 4
              : this.payloadLength !== 0)
        )
          throw refuse('SERIAL_RECORD');
        this.sequence = row.sequence;
        const payload = Buffer.from(body.subarray(this.metadataLength));
        this.body = undefined;
        this.headerUsed = 0;
        this.used = 0;
        this.consume(Object.freeze(row), payload);
        if (this.first) throw this.first.value;
      }
    } catch (value) {
      this.first ??= { value };
      this.body = undefined;
      throw this.first.value;
    }
  }
  finish() {
    this.ended = true;
    if (this.first) throw this.first.value;
    if (this.body || this.headerUsed) throw refuse('SERIAL_TRUNCATED');
  }
}
function encode(selected, direction, sequence, op, stream, payload = Buffer.alloc(0)) {
  const metadata = Buffer.from(
    JSON.stringify({ version: 1, ...selected, direction, sequence, op, stream })
  );
  if (metadata.length > LIMITS.metadata || payload.length > LIMITS.payload)
    throw refuse('SERIAL_LENGTH');
  const bytes = Buffer.alloc(8 + metadata.length + payload.length);
  bytes.writeUInt32BE(metadata.length, 0);
  bytes.writeUInt32BE(payload.length, 4);
  metadata.copy(bytes, 8);
  payload.copy(bytes, 8 + metadata.length);
  return bytes;
}
function retainClose(original) {
  let resolve;
  const returned = new Promise((yes) => {
    resolve = yes;
  });
  original.once('close', resolve);
  return returned;
}
function originalWrite(output, bytes) {
  return new Promise((resolve, reject) => {
    let callback = false,
      drained = false,
      entered = false,
      settled = false,
      first;
    const remove = () => {
      output.off('drain', drain);
      output.off('error', error);
      output.off('close', close);
    };
    const done = () => {
      // A close/error refuses the write, but cannot manufacture its original callback return.
      if (entered && callback && (drained || first) && !settled) {
        settled = true;
        remove();
        if (first) reject(first.value);
        else resolve();
      }
    };
    const error = (value) => {
      first ??= { value };
      done();
    };
    const close = () => error(refuse('SERIAL_WRITE_CLOSED'));
    const drain = () => {
      drained = true;
      done();
    };
    output.on('drain', drain);
    output.on('error', error);
    output.on('close', close);
    try {
      const accepted = output.write(bytes, (value) => {
        callback = true;
        if (value !== undefined && value !== null) first ??= { value };
        done();
      });
      drained ||= accepted;
      entered = true;
      done();
    } catch (value) {
      callback = true;
      entered = true;
      error(value);
    }
  });
}

/** Original stream bridge only. Guest claims never satisfy broker authority or process closure. */
function bridge({ role, input, output, selected, endpoint, serial }) {
  const ownedSerial = serial === undefined ? undefined : inspectRetainedOriginalSerial(serial);
  if (ownedSerial && (role !== 'host' || input !== undefined || output !== undefined))
    throw refuse('SERIAL_OWNED_SCOPE');
  if (!ownedSerial && (input.destroyed || output.destroyed)) throw refuse('SERIAL_CLOSED');
  const captured = scope(selected),
    streams = new Map(),
    originals = new Set(),
    work = new Set(),
    socketReturns = new WeakMap();
  let expectedShutdownEOF = false;
  let first,
    stopped = false,
    closing,
    sequence = 0,
    streamSequence = 0,
    receivedStream = 0,
    queued = 0;
  let refusalYes;
  const refused = new Promise((resolve) => {
    refusalYes = resolve;
  });
  let writer = Promise.resolve(),
    listener,
    listenerReturned;
  const inputReturned = ownedSerial ? ownedSerial.closed : retainClose(input),
    outputReturned = ownedSerial ? ownedSerial.closed : retainClose(output);
  const own = (promise) => {
    work.add(promise);
    void promise.then(
      () => work.delete(promise),
      (value) => {
        work.delete(promise);
        fail(value);
      }
    );
    return promise;
  };
  const guard = () => {
    if (first) throw first.value;
    if (stopped) throw refuse('SERIAL_STOPPED');
  };
  const fail = (value) => {
    first ??= { value };
    refusalYes(Object.freeze({ value: first.value }));
    stop();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (listener) {
      try {
        listener.close();
      } catch (value) {
        first ??= { value };
      }
    }
    for (const cell of streams.values()) {
      try {
        cell.creditWaiter?.reject(first ? first.value : refuse('SERIAL_STOPPED'));
        if (cell.originalConnection) own(cell.originalConnection.close());
        else cell.socket.destroy();
      } catch (value) {
        first ??= { value };
      }
    }
    if (ownedSerial) {
      try {
        ownedSerial.revoke();
      } catch (value) {
        first ??= { value };
      }
    } else {
      try {
        input.destroy();
      } catch (value) {
        first ??= { value };
      }
      try {
        output.destroy();
      } catch (value) {
        first ??= { value };
      }
    }
  };
  const send = (op, id, bytes = Buffer.alloc(0)) => {
    guard();
    const next = sequence + 1;
    if (!Number.isSafeInteger(next)) throw refuse('SERIAL_SEQUENCE');
    sequence = next;
    const record = encode(
      captured,
      role === 'guest' ? 'guest-host' : 'host-guest',
      sequence,
      op,
      id,
      bytes
    );
    if (record.length > LIMITS.queued - queued) throw refuse('SERIAL_QUEUE');
    queued += record.length;
    const job = writer.then(async () => {
      guard();
      await (ownedSerial ? ownedSerial.write(record) : originalWrite(output, record));
      guard();
    });
    writer = job;
    own(job);
    void job.then(
      () => {
        queued -= record.length;
      },
      () => {
        queued -= record.length;
      }
    );
    return job;
  };
  const releaseCell = (id, cell) => {
    if (
      cell.localClosed &&
      cell.peerClosed &&
      cell.pending === 0 &&
      !cell.endPending &&
      cell.outstanding === 0
    )
      streams.delete(id);
  };
  const retainSocket = (socket) => {
    let returned = socketReturns.get(socket);
    if (!returned) {
      returned = retainClose(socket);
      socketReturns.set(socket, returned);
      originals.add(returned);
      void returned.then(() => originals.delete(returned));
      socket.on('error', fail);
    }
    return returned;
  };
  const attach = (socket, id, admitted) => {
    retainSocket(socket);
    if (streams.size >= LIMITS.streams || streams.has(id)) {
      socket.destroy();
      throw refuse('SERIAL_STREAM_CAPACITY');
    }
    const cell = {
      socket,
      originalConnection: undefined,
      admitted,
      remoteEnd: false,
      localEnd: false,
      localClosed: false,
      peerClosed: false,
      pending: 0,
      endPending: false,
      outgoing: Promise.resolve(),
      credit: LIMITS.payload,
      receivingCredit: LIMITS.payload,
      outstanding: 0,
      creditWaiter: undefined,
      admission: undefined,
      incoming: Promise.resolve(),
    };
    streams.set(id, cell);
    socket.pause();
    const outgoing = (produce) => {
      const job = cell.outgoing.then(produce);
      cell.outgoing = job;
      own(job);
      return job;
    };
    socket.on('data', (bytes) => {
      socket.pause();
      outgoing(async () => {
        guard();
        if (cell.originalConnection) cell.originalConnection.check();
        if (!cell.admitted || bytes.length > LIMITS.queued) throw refuse('SERIAL_STREAM_DATA');
        for (let offset = 0; offset < bytes.length; offset += LIMITS.payload) {
          const payload = bytes.subarray(offset, offset + LIMITS.payload);
          if (cell.credit < payload.length)
            await new Promise((resolve, reject) => {
              cell.creditWaiter = { resolve, reject, needed: payload.length };
            });
          guard();
          if (cell.originalConnection) cell.originalConnection.check();
          cell.credit -= payload.length;
          cell.outstanding += payload.length;
          await send('data', id, payload);
        }
        guard();
        if (!cell.localEnd && !cell.localClosed) socket.resume();
      });
    });
    socket.on('end', () => {
      cell.localEnd = true;
      try {
        outgoing(() => send('end', id));
      } catch (value) {
        fail(value);
      }
    });
    socket.on('close', () => {
      cell.localClosed = true;
      if (!stopped) {
        try {
          outgoing(() => send('closed', id));
        } catch (value) {
          fail(value);
        }
      }
      releaseCell(id, cell);
    });
    return cell;
  };
  const receive = (row, bytes) => {
    guard();
    if (row.op === 'open') {
      if (role !== 'host' || row.stream !== receivedStream + 1) throw refuse('SERIAL_OPEN');
      receivedStream = row.stream;
      // This constructor captures the genuine socket/close before its guards/connect.
      // Retain that original owner before attach can fail; never copy its address.
      const original = connectOriginalPreparedBrokerEndpoint(endpoint);
      originals.add(original.closed);
      void original.closed.then(() => originals.delete(original.closed));
      let cell;
      try {
        cell = attach(original.socket, row.stream, false);
      } catch (value) {
        own(original.close());
        throw value;
      }
      cell.originalConnection = original;
      cell.admission = own(
        original.connected.then(async () => {
          original.check();
          guard();
          await send('accepted', row.stream);
          original.check();
          guard();
          cell.admitted = true;
          original.socket.resume();
        })
      );
      return;
    }
    const cell = streams.get(row.stream);
    if (!cell || (cell.peerClosed && row.op !== 'credit')) throw refuse('SERIAL_UNKNOWN_STREAM');
    if (row.op === 'accepted') {
      if (role !== 'guest' || cell.admitted) throw refuse('SERIAL_ACCEPTED');
      cell.admitted = true;
      cell.socket.resume();
      return;
    }
    if (!cell.admitted && !cell.admission && row.op !== 'reset' && row.op !== 'closed')
      throw refuse('SERIAL_UNADMITTED');
    if (row.op === 'credit') {
      const amount = bytes.readUInt32BE(0);
      if (amount < 1 || amount > cell.outstanding || amount > LIMITS.payload - cell.credit)
        throw refuse('SERIAL_CREDIT');
      cell.outstanding -= amount;
      cell.credit += amount;
      releaseCell(row.stream, cell);
      if (cell.creditWaiter && cell.credit >= cell.creditWaiter.needed) {
        const original = cell.creditWaiter;
        cell.creditWaiter = undefined;
        original.resolve();
      }
    } else if (row.op === 'data') {
      if (
        cell.remoteEnd ||
        cell.localClosed ||
        bytes.length > cell.receivingCredit ||
        bytes.length > LIMITS.queued - cell.pending
      )
        throw refuse('SERIAL_STREAM_DATA');
      cell.receivingCredit -= bytes.length;
      cell.pending += bytes.length;
      // The original socket's write/drain duty stays retained, even when remote serial input continues.
      const job = cell.incoming.then(async () => {
        if (cell.admission) await cell.admission;
        guard();
        if (!cell.admitted) throw refuse('SERIAL_UNADMITTED');
        if (cell.originalConnection) cell.originalConnection.check();
        await originalWrite(cell.socket, bytes);
        guard();
        if (cell.originalConnection) cell.originalConnection.check();
        cell.receivingCredit += bytes.length;
        const credit = Buffer.alloc(4);
        credit.writeUInt32BE(bytes.length);
        await send('credit', row.stream, credit);
      });
      cell.incoming = job;
      own(job);
      void job.then(
        () => {
          cell.pending -= bytes.length;
          if (cell.peerClosed && !cell.localClosed && cell.pending === 0 && !cell.endPending)
            cell.socket.destroy();
          releaseCell(row.stream, cell);
        },
        () => {
          cell.pending -= bytes.length;
          releaseCell(row.stream, cell);
        }
      );
    } else if (row.op === 'end') {
      if (cell.remoteEnd || cell.localClosed) throw refuse('SERIAL_STREAM_END');
      cell.remoteEnd = true;
      cell.endPending = true;
      const job = cell.incoming.then(async () => {
        if (cell.admission) await cell.admission;
        guard();
        if (cell.originalConnection) cell.originalConnection.check();
        await new Promise((resolve, reject) => {
          let returned = false,
            first;
          const close = () => {
            first ??= { value: refuse('SERIAL_END_CLOSED') };
            fail(first.value);
          };
          cell.socket.once('close', close);
          const finish = (value) => {
            if (returned) return;
            returned = true;
            cell.socket.off('close', close);
            if (value !== undefined && value !== null) first ??= { value };
            if (first) reject(first.value);
            else resolve();
          };
          // Original close can refuse this duty, never manufacture its callback return.
          try {
            cell.socket.end(finish);
          } catch (value) {
            first ??= { value };
            fail(first.value);
            finish();
          }
        });
      });
      cell.incoming = job;
      own(job);
      // Remote closed cannot destroy the original socket while its admitted
      // end duty is queued or its actual end callback has not returned.
      const joinedEnd = () => {
        cell.endPending = false;
        if (cell.peerClosed && !cell.localClosed && cell.pending === 0 && !cell.endPending)
          cell.socket.destroy();
        releaseCell(row.stream, cell);
      };
      void job.then(joinedEnd, joinedEnd);
    } else if (row.op === 'reset') {
      cell.remoteEnd = true;
      cell.creditWaiter?.reject(refuse('SERIAL_STREAM_RESET'));
      cell.socket.destroy();
    } else if (row.op === 'closed') {
      cell.peerClosed = true;
      // A remote close is never a local original close receipt.
      if (!cell.localClosed && cell.pending === 0 && !cell.endPending) cell.socket.destroy();
      releaseCell(row.stream, cell);
    } else throw refuse('SERIAL_OPERATION');
  };
  const decoder = new ProxyRecordDecoder(
    captured,
    role === 'guest' ? 'host-guest' : 'guest-host',
    receive
  );
  if (ownedSerial) {
    ownedSerial.attachConsumer((bytes) => {
      try {
        decoder.push(bytes);
      } catch (value) {
        fail(value);
        throw value;
      }
    });
    // The serial lifetime is original pipe/callback closure, not process return.
    void ownedSerial.closed.then(() => {
      if (!stopped) {
        try {
          decoder.finish();
          if (!expectedShutdownEOF) throw refuse('SERIAL_OWNED_EOF');
          // EOF never settles or discards an admitted callback/credit/socket duty.
          if (work.size || originals.size || streams.size || queued)
            throw refuse('SERIAL_SHUTDOWN_UNSETTLED');
          stop();
        } catch (value) {
          fail(value);
        }
      }
    }, fail);
  } else {
    input.on('data', (bytes) => {
      try {
        decoder.push(bytes);
      } catch (value) {
        fail(value);
      }
    });
    input.on('end', () => {
      try {
        decoder.finish();
        fail(refuse('SERIAL_EOF'));
      } catch (value) {
        fail(value);
      }
    });
    input.on('error', fail);
    output.on('error', fail);
    input.on('close', () => {
      if (!stopped) fail(refuse('SERIAL_INPUT_CLOSED'));
    });
    output.on('close', () => {
      if (!stopped) fail(refuse('SERIAL_OUTPUT_CLOSED'));
    });
  }
  return Object.freeze({
    refused,
    expectOriginalShutdownEOF() {
      guard();
      if (!ownedSerial || role !== 'host' || expectedShutdownEOF)
        throw refuse('SERIAL_SHUTDOWN_BOUNDARY');
      expectedShutdownEOF = true;
    },
    async listen() {
      if (role !== 'guest' || listener) throw refuse('SERIAL_LISTENER');
      guard();
      listener = createServer({ allowHalfOpen: true }, (socket) => {
        retainSocket(socket);
        try {
          guard();
          const id = ++streamSequence;
          if (!Number.isSafeInteger(id)) throw refuse('SERIAL_STREAM_ID');
          attach(socket, id, false);
          own(send('open', id));
        } catch (value) {
          socket.destroy();
          fail(value);
        }
      });
      listenerReturned = retainClose(listener);
      listener.on('error', fail);
      await own(
        new Promise((resolve, reject) => {
          const error = (value) => {
            listener.off('listening', listening);
            reject(value);
          };
          const listening = () => {
            listener.off('error', error);
            resolve();
          };
          listener.once('error', error);
          listener.once('listening', listening);
          listener.listen({ host: '127.0.0.1', port: 0 });
        })
      );
      guard();
      const address = listener.address();
      if (!address || typeof address === 'string' || address.address !== '127.0.0.1')
        throw refuse('SERIAL_LISTENER');
      return Object.freeze({ host: '127.0.0.1', port: address.port });
    },
    reset(stream) {
      guard();
      const cell = streams.get(stream);
      if (!cell || cell.peerClosed || cell.localClosed) throw refuse('SERIAL_UNKNOWN_STREAM');
      const original = send('reset', stream);
      cell.creditWaiter?.reject(refuse('SERIAL_STREAM_RESET'));
      cell.socket.destroy();
      return original;
    },
    snapshot: () =>
      Object.freeze({
        streams: streams.size,
        queued,
        stopped,
        originalJobs: work.size,
        ending: [...streams.values()].filter((cell) => cell.endPending).length,
        incomingPending: [...streams.values()].reduce((sum, cell) => sum + cell.pending, 0),
      }),
    close() {
      if (closing) return closing;
      stop();
      closing = (async () => {
        await Promise.allSettled([
          inputReturned,
          outputReturned,
          ...(listenerReturned ? [listenerReturned] : []),
          ...originals,
        ]);
        while (work.size) await Promise.allSettled([...work]);
        if (first) throw first.value;
      })();
      void closing.catch(() => {});
      return closing;
    },
  });
}
/** Internal production host seam. Only original native mux and prepared broker
 * capability are accepted; no replacement streams, Server or callback issuer. */
export function createProductionOwnedSerialProxyIntake(options) {
  const fields = Object.getOwnPropertyDescriptors(options ?? {});
  if (
    Object.keys(fields).sort().join(',') !== 'endpoint,selected,serial' ||
    Object.values(fields).some((d) => !('value' in d))
  )
    throw refuse('SERIAL_PRODUCTION_CLOSED_ARGUMENTS');
  if (options.serial === undefined) throw refuse('SERIAL_ORIGINAL_NATIVE_MUX_REQUIRED');
  return bridge({ ...options, role: 'host' });
}

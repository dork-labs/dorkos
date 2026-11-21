/** One binary direction per socket. Credit returns only after the receiver reads. */
import { Buffer } from 'node:buffer';
import { createByteLane, MAX_FRAME_BYTES, MAX_LANE_CREDIT } from '../index.mjs';

const BYTES = 1;
const CREDIT = 2;
const EOF = 3;
const FAULT = 4;

function header(kind, length = 0) {
  const bytes = Buffer.alloc(5);
  bytes[0] = kind;
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

function socketWrite(socket, value) {
  return new Promise((resolve, reject) => {
    socket.write(value, (error) => (error ? reject(error) : resolve()));
  });
}

async function readFrames(socket, check, receive) {
  const first = Buffer.alloc(5);
  let headerBytes = 0;
  let body;
  let bodyBytes = 0;
  let kind;
  let length;
  for await (const chunk of socket) {
    if (!Buffer.isBuffer(chunk)) throw new Error('Expected binary custody lane');
    let cursor = 0;
    while (cursor < chunk.length) {
      if (!body) {
        const count = Math.min(first.length - headerBytes, chunk.length - cursor);
        first.set(chunk.subarray(cursor, cursor + count), headerBytes);
        cursor += count;
        headerBytes += count;
        if (headerBytes !== first.length) continue;
        kind = first[0];
        length = first.readUInt32BE(1);
        check(kind, length);
        if (kind !== BYTES) {
          headerBytes = 0;
          await receive(kind, length);
          continue;
        }
        body = Buffer.allocUnsafe(length);
      }
      const count = Math.min(body.length - bodyBytes, chunk.length - cursor);
      body.set(chunk.subarray(cursor, cursor + count), bodyBytes);
      cursor += count;
      bodyBytes += count;
      if (bodyBytes !== body.length) continue;
      const frame = body;
      body = undefined;
      bodyBytes = 0;
      headerBytes = 0;
      await receive(kind, frame);
    }
  }
  if (headerBytes || body) throw new Error('Truncated custody lane frame');
}

/** Serialize at most one pending frame and use one bounded credit window. */
export function socketLaneWriter(socket) {
  let outstanding = 0;
  let pending = false;
  let ended = false;
  let failed = false;
  let wake;
  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });
  const fault = () => {
    failed = true;
    settle(false);
    socket.destroy();
    wake?.();
  };
  void readFrames(
    socket,
    (kind, count) => {
      if (kind !== CREDIT || count < 1 || count > MAX_FRAME_BYTES || count > outstanding)
        throw new Error('Invalid custody lane credit');
    },
    (_, count) => {
      outstanding -= count;
      wake?.();
    }
  ).then(() => {
    if (!ended) fault();
  }, fault);
  async function terminate(kind) {
    try {
      if (!failed) {
        await socketWrite(socket, header(kind));
        settle(!failed && kind === EOF);
      }
    } catch {
      fault();
    } finally {
      if (!socket.destroyed) socket.end();
    }
  }

  return {
    finished,
    async write(frame) {
      if (!(frame instanceof Uint8Array) || !frame.byteLength || frame.byteLength > MAX_FRAME_BYTES)
        throw new RangeError('Invalid custody socket frame');
      if (pending || ended || failed) throw new Error('Custody socket writer unavailable');
      const copy = Buffer.from(frame);
      pending = true;
      try {
        while (!failed && outstanding + copy.length > MAX_LANE_CREDIT) {
          await new Promise((resolve) => {
            wake = resolve;
          });
        }
        if (failed) throw new Error('Custody socket closed before frame admission');
        outstanding += copy.length;
        await socketWrite(socket, Buffer.concat([header(BYTES, copy.length), copy]));
      } catch (error) {
        fault();
        throw error;
      } finally {
        pending = false;
        wake = undefined;
        if (ended) void terminate(EOF);
      }
    },
    end() {
      if (ended || failed) return false;
      ended = true;
      if (!pending) void terminate(EOF);
      return true;
    },
    fail() {
      if (failed || ended) return false;
      ended = true;
      // A blocked write exits immediately and sends no later data.
      if (pending) fault();
      else void terminate(FAULT);
      return true;
    },
  };
}

/** Admit bytes to one bounded reader and return credit only on caller consumption. */
export function socketLaneReader(socket) {
  const lane = createByteLane();
  let terminal = false;
  const lost = () => {
    lane.abandon(new Error('Custody socket closed without stream EOF'));
    socket.destroy();
  };
  void readFrames(
    socket,
    (kind, length) => {
      if (
        terminal ||
        (kind === BYTES
          ? length < 1 || length > MAX_FRAME_BYTES || lane.creditUsed + length > MAX_LANE_CREDIT
          : (kind !== EOF && kind !== FAULT) || length !== 0)
      )
        throw new Error('Invalid custody lane frame');
    },
    async (kind, frame) => {
      if (kind === BYTES) {
        await lane.writer.write(frame);
      } else {
        terminal = true;
        if (kind === EOF) lane.writer.end();
        else lane.writer.fail(new Error('Custody stream failed'));
      }
    }
  ).then(() => {
    if (!terminal) lost();
  }, lost);
  return {
    async read() {
      const result = await lane.reader.read();
      if (result.kind === 'bytes' && !socket.destroyed && !socket.writableEnded) {
        try {
          await socketWrite(socket, header(CREDIT, result.frame.byteLength));
        } catch {
          if (!terminal) lost();
        }
      } else if (result.kind !== 'bytes') {
        socket.end();
      }
      return result;
    },
  };
}

/** Pump a real readable into bounded frames. EOF is separate from process exit. */
export async function forwardOutput(source, writer) {
  try {
    for await (const chunk of source) {
      for (let start = 0; start < chunk.length; start += MAX_FRAME_BYTES)
        await writer.write(chunk.subarray(start, start + MAX_FRAME_BYTES));
    }
    if (!source.readableEnded) throw new Error('Native output closed without EOF');
    if (!writer.end()) return false;
    return await writer.finished;
  } catch {
    writer.fail(new Error('Native output lost'));
    return false;
  }
}

/** Pump the private input stream into the actual target stdin descriptor. */
export async function forwardInput(reader, destination) {
  try {
    for (;;) {
      const next = await reader.read();
      if (next.kind === 'eof') break;
      if (next.kind === 'error') throw next.error;
      await socketWrite(destination, next.frame);
    }
    destination.end();
  } catch {
    destination.destroy();
  }
}

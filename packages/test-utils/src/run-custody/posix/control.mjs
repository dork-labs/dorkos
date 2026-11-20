/** Framed, sequenced messages for the exclusive guardian/anchor control pipe. */
import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { createHmac, timingSafeEqual } from 'node:crypto';

const VERSION = 1;
const MAX_CONTROL_BYTES = 4 * 1024 * 1024;
const CAPABILITY = /^[0-9a-f]{64}$/;
const CHANNEL = /^[0-9a-f]{32}$/;

function keyFor(secret, channel, direction) {
  if (
    !CAPABILITY.test(secret) ||
    !CHANNEL.test(channel) ||
    (direction !== 'guardian-to-anchor' && direction !== 'anchor-to-guardian')
  )
    throw new Error('Invalid private POSIX control binding');
  return createHmac('sha256', Buffer.from(secret, 'hex'))
    .update(JSON.stringify([VERSION, channel, direction]))
    .digest();
}

/** Encode one control direction. Binary stdin/stdout/stderr use separate lanes. */
export function createControlWriter(secret, channel, direction) {
  const key = keyFor(secret, channel, direction);
  let sequence = 0;
  return (kind, payload) => {
    const body = Buffer.from(JSON.stringify([VERSION, sequence, kind, payload]));
    if (!body.length || body.length > MAX_CONTROL_BYTES)
      throw new RangeError('Private POSIX control frame exceeds its bound');
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length);
    const authentication = createHmac('sha256', key).update(body).digest();
    sequence++;
    return Buffer.concat([header, authentication, body]);
  };
}

/** A decoder retains at most one bounded partial frame and rejects replay or truncation. */
export function createControlReader(secret, channel, direction, receive) {
  const key = keyFor(secret, channel, direction);
  const header = Buffer.alloc(36);
  let headBytes = 0;
  let body;
  let bodyBytes = 0;
  let sequence = 0;
  let failed = false;

  function fail() {
    failed = true;
    body = undefined;
    throw new Error('Invalid private POSIX control frame');
  }

  function complete() {
    const expected = createHmac('sha256', key).update(body).digest();
    if (!timingSafeEqual(expected, header.subarray(4))) fail();
    let message;
    try {
      message = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(body));
    } catch {
      fail();
    }
    if (
      !Array.isArray(message) ||
      message.length !== 4 ||
      message[0] !== VERSION ||
      message[1] !== sequence ||
      typeof message[2] !== 'string'
    )
      fail();
    sequence++;
    headBytes = 0;
    body = undefined;
    bodyBytes = 0;
    receive(message[2], message[3]);
  }

  return {
    push(chunk) {
      if (failed || !(chunk instanceof Uint8Array)) fail();
      let offset = 0;
      while (offset < chunk.length) {
        if (!body) {
          const count = Math.min(header.length - headBytes, chunk.length - offset);
          header.set(chunk.subarray(offset, offset + count), headBytes);
          headBytes += count;
          offset += count;
          if (headBytes !== header.length) continue;
          const length = header.readUInt32BE();
          if (!length || length > MAX_CONTROL_BYTES) fail();
          body = Buffer.allocUnsafe(length);
        }
        const count = Math.min(body.length - bodyBytes, chunk.length - offset);
        body.set(chunk.subarray(offset, offset + count), bodyBytes);
        bodyBytes += count;
        offset += count;
        if (bodyBytes === body.length) complete();
      }
    },
    end() {
      if (failed || headBytes || bodyBytes) fail();
    },
  };
}

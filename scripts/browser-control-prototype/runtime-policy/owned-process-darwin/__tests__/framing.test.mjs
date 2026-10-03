import assert from 'node:assert/strict';
import test from 'node:test';
import { closedRecord, encodeFrame, FrameQueue } from '../framing.mjs';
const validate = (value) => closedRecord(value, ['ordinal', 'kind']);
const frame = () => encodeFrame({ ordinal: 1, kind: 'private-fixture' });
test('private framing accepts split UTF8 frames and drains bounded accounting', () => {
  const queue = new FrameQueue(validate);
  const bytes = frame();
  for (const byte of bytes) queue.push(Buffer.from([byte]));
  assert.equal(queue.pending.frames, 1);
  assert.deepEqual(queue.take(), { ordinal: 1, kind: 'private-fixture' });
  assert.equal(queue.pending.bytes, 0);
  queue.end();
});
test('32-frame cap closes admission and erases queued payloads permanently', () => {
  const queue = new FrameQueue(validate);
  for (let i = 0; i < 32; i++) queue.push(frame());
  assert.equal(queue.pending.frames, 32);
  assert.throws(() => queue.push(frame()), /FRAME_QUEUE_CAP/);
  assert.deepEqual(queue.pending, { frames: 0, bytes: 0, closed: true });
  assert.throws(() => queue.push(frame()), /FRAME_CLOSED/);
});
test('malformed size, UTF8, schema and trailing partial frame never publish', () => {
  const cases = [
    Buffer.from([0, 0, 0, 0]),
    Buffer.from([0, 0, 16, 1]),
    Buffer.from([0, 0, 0, 1, 255]),
    encodeFrame({ ordinal: 1, kind: 'x', extra: true }),
  ];
  for (const bytes of cases) {
    const queue = new FrameQueue(validate);
    assert.throws(() => queue.push(bytes));
    assert.equal(queue.take(), null);
    assert.equal(queue.pending.closed, true);
  }
  const partial = new FrameQueue(validate);
  partial.push(frame().subarray(0, 5));
  assert.throws(() => partial.end(), /FRAME_TRUNCATED/);
});
test('closed schema rejects accessors and symbol fields before reading them', () => {
  let accessed = false;
  const getter = {
    kind: 'x',
    get ordinal() {
      accessed = true;
      return 1;
    },
  };
  assert.throws(() => validate(getter), /FRAME_SCHEMA/);
  assert.equal(accessed, false);
  assert.throws(
    () => validate({ ordinal: 1, kind: 'x', [Symbol('authority')]: true }),
    /FRAME_SCHEMA/
  );
});

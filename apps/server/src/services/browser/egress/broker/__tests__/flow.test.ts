import { it, expect } from 'vitest';
import { forwardFlow } from '../flow.js';
import { BrokerError } from '../errors.js';
import { FakeSocket, FakeBody } from './fake-transport.js';
it('byte overflow refuses the excess chunk and cumulative direction survives drain', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let failed = 0;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 5,
    queueLimit: 5,
    onFailure: () => failed++,
  });
  source.emit('12345');
  expect(target.writes).toEqual(['12345']);
  source.emit('x');
  expect(target.writes).toEqual(['12345']);
  expect(failed).toBe(1);
  expect(flow.snapshot().total).toBe(6);
  flow.stop();
});
it('paused resume rechecks authority before any queued challenge', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let valid = true,
    failed = 0;
  target.backpressure = true;
  const flow = forwardFlow({
    source,
    target,
    check: () => {
      if (!valid) throw Error('revoked');
    },
    limit: 10,
    queueLimit: 5,
    onFailure: () => failed++,
  });
  source.emit('one');
  source.emit('two');
  expect(target.writes).toEqual(['one']);
  expect(flow.snapshot().queued).toBe(3);
  valid = false;
  target.drain();
  expect(target.writes).toEqual(['one']);
  expect(failed).toBe(1);
  flow.stop();
});

it('initial header backpressure keeps new bytes queued until checked drain', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let failed = 0;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 10,
    queueLimit: 5,
    initiallyBlocked: true,
    onFailure: () => failed++,
  });
  expect(source.paused).toBe(true);
  source.emit('one');
  expect(target.writes).toEqual([]);
  target.drain();
  expect(target.writes).toEqual(['one']);
  expect(failed).toBe(0);
  flow.stop();
});

it('EOF waits through multiple blocked drains and ends once after exact ordered payload', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  target.backpressure = true;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 20,
    queueLimit: 20,
    initiallyBlocked: true,
    endOnSourceEOF: true,
    onFailure: () => {
      throw Error('unexpected');
    },
  });
  let ends = 0;
  target.end = () => {
    ends++;
    target.closed();
  };
  source.emit('first');
  source.emit('last');
  source.finish();
  expect(target.writes).toEqual([]);
  expect(ends).toBe(0);
  target.drain();
  expect(target.writes).toEqual(['first']);
  expect(ends).toBe(0);
  expect(flow.snapshot().queued).toBe(4);
  target.backpressure = false;
  target.drain();
  expect(target.writes).toEqual(['first', 'last']);
  expect(ends).toBe(1);
  target.drain();
  source.finish();
  expect(ends).toBe(1);
  flow.stop();
});
it('revoked EOF queue never drains or ends and owner receives the exact primary refusal', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  let current = true;
  const cause = new BrokerError('EXPIRED');
  const causes: BrokerError[] = [];
  const flow = forwardFlow({
    source,
    target,
    check: () => {
      if (!current) throw cause;
    },
    limit: 20,
    queueLimit: 20,
    initiallyBlocked: true,
    endOnSourceEOF: true,
    onFailure: (e) => causes.push(e),
  });
  source.emit('private');
  source.finish();
  current = false;
  target.drain();
  expect(target.writes).toEqual([]);
  expect(target.observedClosed).toBe(false);
  expect(causes).toEqual([cause]);
  expect(flow.snapshot().queued).toBe(0);
  source.emit('late');
  target.drain();
  expect(causes).toHaveLength(1);
  flow.stop();
});

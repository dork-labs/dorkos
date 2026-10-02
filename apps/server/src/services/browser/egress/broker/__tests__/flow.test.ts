import { it, expect } from 'vitest';
import { forwardFlow, guardedCall, guardedWrite } from '../flow.js';
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
it('includes already-owned writable buffers before the first new write', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  target.writableBytes = 3;
  let failed = 0;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 10,
    queueLimit: 5,
    onFailure: () => failed++,
  });
  source.emit('123');
  expect(target.writes).toEqual([]);
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
it('blocked queued bytes and the already-owned native buffer share one queue ceiling', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  target.writableBytes = 3;
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
  source.emit('123');
  expect(failed).toBe(1);
  expect(target.writes).toEqual([]);
  flow.stop();
});

it('a target buffer getter invalidation cannot forward the current chunk', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let valid = true,
    observed = false,
    failures = 0;
  Object.defineProperty(target, 'writableBytes', {
    get() {
      observed = true;
      valid = false;
      return 0;
    },
  });
  const flow = forwardFlow({
    source,
    target,
    check: () => {
      if (!valid) throw Error('revoked');
    },
    limit: 10,
    queueLimit: 10,
    onFailure: () => failures++,
  });
  source.emit('secret');
  flow.stop();
  expect(observed).toBe(true);
  expect(target.writes, 'BYTES_AFTER_BUFFER_OBSERVATION_REVOKED').toEqual([]);
  expect(failures).toBe(1);
});
it.each(['method', 'onBytes', 'resume'] as const)(
  'reentrant %s observation cannot invoke stale IO',
  (where) => {
    const source = new FakeSocket(),
      target = new FakeSocket();
    let valid = true,
      observed = 0,
      failures = 0,
      resumed = 0;
    const check = () => {
      if (!valid) throw Error('revoked');
    };
    if (where === 'method')
      Object.defineProperty(target, 'write', {
        get() {
          observed++;
          valid = false;
          return FakeSocket.prototype.write;
        },
      });
    if (where === 'resume')
      Object.defineProperty(source, 'resume', {
        get() {
          observed++;
          valid = false;
          return () => {
            resumed++;
          };
        },
      });
    const flow = forwardFlow({
      source,
      target,
      check,
      limit: 20,
      queueLimit: 20,
      onFailure: () => failures++,
      onBytes:
        where === 'onBytes'
          ? () => {
              observed++;
              valid = false;
            }
          : undefined,
    });
    if (where === 'resume') target.drain();
    else source.emit('challenge');
    expect(observed).toBe(1);
    expect(target.writes).toEqual([]);
    expect(resumed).toBe(0);
    expect(failures).toBe(1);
    flow.stop();
  }
);
it('same-target callbacks that retain authority still forward and resume', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let observed = 0;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 20,
    queueLimit: 20,
    onFailure: () => {
      throw Error('unexpected');
    },
    onBytes: () => observed++,
  });
  source.emit('challenge');
  target.drain();
  expect(target.writes).toEqual(['challenge']);
  expect(observed).toBe(1);
  expect(source.paused).toBe(false);
  flow.stop();
});
it('byte-length observation is fenced before write and method call properties confer no authority', () => {
  const target = new FakeSocket(),
    source = new FakeSocket();
  let valid = true,
    observed = 0;
  const bytes = new Uint8Array([1]);
  Object.defineProperty(bytes, 'byteLength', {
    get() {
      observed++;
      valid = false;
      return 1;
    },
  });
  const flow = forwardFlow({
    source,
    target,
    check: () => {
      if (!valid) throw Error('revoked');
    },
    limit: 10,
    queueLimit: 10,
    onFailure: () => {},
  });
  for (const callback of source.data) callback(bytes);
  expect(observed).toBeGreaterThan(0);
  expect(target.writes).toEqual([]);
  flow.stop();
  const plain = new FakeSocket();
  const write = plain.write;
  Object.defineProperty(write, 'call', {
    get() {
      throw Error('METHOD_CALL_PROPERTY_EXECUTED');
    },
    configurable: true,
  });
  try {
    const producer = new FakeSocket();
    const okay = forwardFlow({
      source: producer,
      target: plain,
      check: () => {},
      limit: 10,
      queueLimit: 10,
      onFailure: () => {
        throw Error('unexpected');
      },
    });
    producer.emit('positive');
    expect(plain.writes).toEqual(['positive']);
    okay.stop();
  } finally {
    delete (write as { call?: unknown }).call;
  }
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
it('synchronous EOF during accepted write waits for returned write then ends', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  let inWrite = false,
    ends = 0;
  target.write = (bytes) => {
    inWrite = true;
    source.finish();
    expect(ends).toBe(0);
    target.writes.push(Buffer.from(bytes).toString());
    inWrite = false;
    return true;
  };
  target.end = () => {
    expect(inWrite).toBe(false);
    ends++;
  };
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 20,
    queueLimit: 20,
    endOnSourceEOF: true,
    onFailure: () => {
      throw Error('unexpected');
    },
  });
  source.emit('complete');
  expect(target.writes).toEqual(['complete']);
  expect(ends).toBe(1);
  flow.stop();
});
it('reentrant accepted payload preserves queue order without requiring an invented drain', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  let entered = false;
  target.write = (bytes) => {
    if (!entered) {
      entered = true;
      source.emit('second');
    }
    target.writes.push(Buffer.from(bytes).toString());
    return true;
  };
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 20,
    queueLimit: 20,
    endOnSourceEOF: true,
    onFailure: () => {
      throw Error('unexpected');
    },
  });
  source.emit('first');
  source.finish();
  expect(target.writes).toEqual(['first', 'second']);
  expect(target.observedClosed).toBe(true);
  flow.stop();
});
for (const operation of ['resume', 'end'] as const)
  it(`${operation} getter closes owned socket before any stale invocation`, () => {
    const target = new FakeSocket();
    let captures = 0,
      entered = 0;
    Object.defineProperty(target, operation, {
      get() {
        captures++;
        target.closed();
        return () => entered++;
      },
    });
    expect(() => guardedCall(target, operation, () => {})).toThrow('CLOSED');
    expect(captures).toBe(1);
    expect(entered).toBe(0);
  });
it('pause and all three detach failures cannot replace primary overflow or suppress owner', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  const detached: string[] = [],
    causes: BrokerError[] = [];
  for (const [port, method, label] of [
    [source, 'onData', 'data'],
    [source, 'onEnd', 'end'],
    [target, 'onDrain', 'drain'],
  ] as const) {
    const original = port[method as keyof typeof port] as (...args: unknown[]) => () => void;
    Object.defineProperty(port, method, {
      value: (...args: unknown[]) => {
        const remove = Reflect.apply(original, port, args);
        return () => {
          detached.push(label);
          remove();
          throw Error('DETACH_SECRET');
        };
      },
    });
  }
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 1,
    queueLimit: 5,
    endOnSourceEOF: true,
    onFailure: (e) => causes.push(e),
  });
  let pauses = 0;
  source.pause = () => {
    pauses++;
    throw Error('PAUSE_SECRET');
  };
  source.emit('xx');
  expect(detached.sort()).toEqual(['data', 'drain', 'end']);
  expect(pauses).toBe(1);
  expect(causes).toHaveLength(1);
  expect(causes[0]!.code).toBe('BYTE_LIMIT');
  expect(JSON.stringify(causes)).not.toContain('SECRET');
  expect(target.writes).toEqual([]);
  flow.stop();
  expect(detached).toHaveLength(3);
});
it('late subscription returned after synchronous failure is detached once', () => {
  const source = new FakeSocket(),
    target = new FakeSocket();
  let detached = 0,
    failed = 0;
  source.onData = (fn) => {
    source.data.add(fn);
    fn(Buffer.from('xx'));
    return () => {
      detached++;
      return source.data.delete(fn);
    };
  };
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 1,
    queueLimit: 5,
    onFailure: () => failed++,
  });
  expect(detached).toBe(1);
  expect(failed).toBe(1);
  expect(target.writes).toEqual([]);
  expect(source.data.size).toBe(0);
  flow.stop();
  expect(detached).toBe(1);
});

it('write method observation closes a target before the final closed snapshot', () => {
  const target = new FakeSocket();
  let captures = 0;
  Object.defineProperty(target, 'write', {
    get() {
      captures++;
      target.closed();
      return FakeSocket.prototype.write;
    },
  });
  expect(() => guardedWrite(target, Buffer.from('STALE_CLOSED_WRITE'), () => {}, 100)).toThrow(
    'CLOSED'
  );
  expect(captures).toBe(1);
  expect(target.writes).toEqual([]);
});
it('same write method observation preserves exact open target receiver', () => {
  const target = new FakeSocket();
  let entered = 0;
  Object.defineProperty(target, 'write', {
    get() {
      return function (this: FakeSocket, b: Uint8Array) {
        expect(this).toBe(target);
        entered++;
        return Reflect.apply(FakeSocket.prototype.write, this, [b]);
      };
    },
  });
  expect(guardedWrite(target, Buffer.from('OPEN_TARGET'), () => {}, 100)).toBe(true);
  expect(entered).toBe(1);
  expect(target.writes).toEqual(['OPEN_TARGET']);
});

it('ordinary closed target is not resumed after its method observation', () => {
  const target = new FakeSocket();
  let reached = 0;
  target.closed();
  target.resume = () => reached++;
  expect(() => guardedCall(target, 'resume', () => {})).toThrow('CLOSED');
  expect(reached).toBe(0);
});

it.each(['registration', 'resume getter', 'final authority', 'open'])(
  'flow-owned initial resume refuses EOF at %s',
  (point) => {
    const source = new FakeBody(),
      target = new FakeSocket();
    let resumes = 0,
      ends = 0,
      captures = 0,
      failed = 0,
      armed = false;
    target.end = () => ends++;
    source.onEnd = (callback) => {
      source.end.add(callback);
      if (point === 'registration') callback();
      return () => source.end.delete(callback);
    };
    Object.defineProperty(source, 'resume', {
      get() {
        captures++;
        if (point === 'resume getter') source.finish();
        armed = true;
        return function (this: FakeBody) {
          expect(this).toBe(source);
          resumes++;
        };
      },
    });
    const flow = forwardFlow({
      source,
      target,
      check: () => {
        if (point === 'final authority' && armed) {
          armed = false;
          source.finish();
        }
      },
      limit: 100,
      queueLimit: 100,
      endOnSourceEOF: true,
      resumeOnStart: true,
      onFailure: () => failed++,
    });
    expect(resumes).toBe(point === 'open' ? 1 : 0);
    expect(captures).toBe(point === 'registration' ? 0 : 1);
    expect(ends).toBe(point === 'open' ? 0 : 1);
    expect(failed).toBe(0);
    source.finish();
    expect(ends).toBe(1);
    expect(resumes).toBe(point === 'open' ? 1 : 0);
    flow.stop();
  }
);

it('initial blocked EOF drains the header without resuming the completed producer', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  let resumes = 0,
    ends = 0;
  source.resume = () => resumes++;
  target.end = () => ends++;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 100,
    queueLimit: 100,
    initiallyBlocked: true,
    endOnSourceEOF: true,
    resumeOnStart: true,
    onFailure: () => {
      throw Error('unexpected failure');
    },
  });
  source.finish();
  expect(ends).toBe(0);
  target.drain();
  expect(ends).toBe(1);
  expect(resumes).toBe(0);
  flow.stop();
});

it.each(['initial', 'drain'])(
  '%s resume refuses a current authority failure after capturing the method',
  (phase) => {
    const source = new FakeBody(),
      target = new FakeSocket();
    let captures = 0,
      resumes = 0,
      failed = 0,
      armed = false;
    Object.defineProperty(source, 'resume', {
      get() {
        captures++;
        armed = true;
        return () => resumes++;
      },
    });
    const flow = forwardFlow({
      source,
      target,
      check: () => {
        if (armed) throw new BrokerError('AUTHORITY_REFUSED');
      },
      limit: 100,
      queueLimit: 100,
      initiallyBlocked: phase === 'drain',
      endOnSourceEOF: true,
      resumeOnStart: true,
      onFailure: (cause) => {
        expect(cause.code).toBe('AUTHORITY_REFUSED');
        failed++;
      },
    });
    if (phase === 'drain') target.drain();
    expect(captures).toBe(1);
    expect(resumes).toBe(0);
    expect(failed).toBe(1);
    flow.stop();
  }
);

it('drain method capture EOF never resumes a completed source', () => {
  const source = new FakeBody(),
    target = new FakeSocket();
  let resumes = 0,
    ends = 0;
  Object.defineProperty(source, 'resume', {
    get() {
      source.finish();
      return () => resumes++;
    },
  });
  target.end = () => ends++;
  const flow = forwardFlow({
    source,
    target,
    check: () => {},
    limit: 100,
    queueLimit: 100,
    initiallyBlocked: true,
    endOnSourceEOF: true,
    resumeOnStart: true,
    onFailure: () => {
      throw Error('unexpected failure');
    },
  });
  target.drain();
  expect(ends).toBe(1);
  expect(resumes).toBe(0);
  flow.stop();
});

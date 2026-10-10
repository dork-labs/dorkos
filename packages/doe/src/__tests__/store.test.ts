import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { ModelMessage } from '../contracts.js';
import { SqliteModelStore } from '../index.js';
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'doe-'));
  dirs.push(dir);
  return join(dir, 'history.db');
}
it('preserves opaque model fields, monotonic sequence and independent scopes after reopen', () => {
  const file = fixture();
  let store = new SqliteModelStore(file);
  store.createSession('alpha');
  store.createSession('beta');
  const payload: ModelMessage = {
    role: 'assistant',
    content: [
      { type: 'thinking', signature: 'opaque', thinking: 'x' },
      { type: 'image', data: 'abc' },
      { type: 'toolCall', id: 'call', arguments: { a: 1 } },
    ],
    unknown: { nested: [null, true] },
  };
  expect(store.appendMessage('alpha', payload).seq).toBe(1);
  store.appendMessage('alpha', { role: 'toolResult', toolCallId: 'call', content: [] });
  store.appendMessage('alpha', { role: 'user', content: 'child' }, 'child:one');
  store.appendMessage('beta', { role: 'user', content: 'other' });
  store.close();
  store = new SqliteModelStore(file);
  expect(store.archive('alpha')[0]?.payload).toEqual(payload);
  expect(store.appendMessage('alpha', { role: 'user', content: 'next' }).seq).toBe(3);
  expect(store.archive('alpha', 'child:one')).toHaveLength(1);
  expect(store.archive('beta')).toHaveLength(1);
  store.close();
});
it('atomically records completion and usage; checkpoints preserve originals and rollback on failure', () => {
  const file = fixture();
  const store = new SqliteModelStore(file);
  store.createSession('alpha');
  store.appendMessage('alpha', { role: 'user', content: 'old' });
  store.appendMessage('alpha', { role: 'user', content: 'retain' });
  const usage = { requestId: 'summary-1', inputTokens: 10, outputTokens: 2 };
  store.checkpoint('alpha', {
    summary: { role: 'user', content: 'summary' },
    firstRetainedSeq: 2,
    before: { tokens: 50, source: 'estimated' },
    after: { tokens: 20, source: 'estimated' },
    usage,
  });
  expect(store.restore('alpha').messages.map((x) => x.payload.content)).toEqual([
    'summary',
    'retain',
  ]);
  expect(store.archive('alpha')).toHaveLength(2);
  const db = new Database(file);
  db.exec(
    "CREATE TRIGGER fail_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'disk failure'); END"
  );
  expect(() =>
    store.checkpoint('alpha', {
      summary: { role: 'user', content: 'bad' },
      firstRetainedSeq: 3,
      before: { tokens: 20, source: 'estimated' },
      after: { tokens: 5, source: 'estimated' },
      usage: { ...usage, requestId: 'summary-2' },
    })
  ).toThrow('disk failure');
  expect(store.restore('alpha').checkpoint?.summary.content).toBe('summary');
  expect(store.usage('alpha')).toHaveLength(1);
  db.exec(
    "CREATE TRIGGER fail_usage BEFORE INSERT ON usage BEGIN SELECT RAISE(ABORT, 'usage failure'); END"
  );
  expect(() =>
    store.complete('alpha', [{ role: 'assistant', content: 'new' }], { requestId: 'run-1' })
  ).toThrow('usage failure');
  expect(store.archive('alpha')).toHaveLength(2);
  db.close();
  store.close();
});
it('rejects malformed identifiers and deletes only the explicitly named session', () => {
  const store = new SqliteModelStore(fixture());
  for (const id of ['', '../bad', "a'; DROP TABLE sessions;--", 'a'.repeat(129)])
    expect(() => store.createSession(id)).toThrow();
  store.createSession('alpha');
  store.createSession('beta');
  store.appendMessage('alpha', { role: 'user' });
  store.appendMessage('beta', { role: 'user' });
  store.deleteSession('alpha');
  expect(store.archive('beta')).toHaveLength(1);
  expect(() => store.archive('alpha')).toThrow();
  store.close();
});
it('persists metadata and isolated beat outcomes, and prevents cross-scope double accounting', () => {
  const file = fixture();
  let store = new SqliteModelStore(file);
  store.createSession('alpha', { host: 'supplied' });
  store.recordUsage('alpha', { requestId: 'unique' }, 'child:one');
  expect(() => store.recordUsage('alpha', { requestId: 'unique' })).toThrow();
  store.recordOutcome('alpha', { kind: 'quiet' }, 'beat:one');
  expect(() => store.recordOutcome('alpha', { kind: 'quiet' }, 'main')).toThrow();
  store.close();
  store = new SqliteModelStore(file);
  expect(store.metadata('alpha')).toEqual({ host: 'supplied' });
  expect(store.listSessions()).toEqual([{ id: 'alpha', metadata: { host: 'supplied' } }]);
  expect(store.outcomes('alpha', 'beat:one')).toEqual([{ seq: 1, result: { kind: 'quiet' } }]);
  expect(store.allUsage('alpha')).toHaveLength(1);
  store.close();
});
it('rejects lossy JSON and invalid scopes without advancing sequence', () => {
  const store = new SqliteModelStore(fixture());
  store.createSession('alpha');
  expect(() => store.appendMessage('alpha', { role: 'user', content: Number.NaN })).toThrow();
  expect(() => store.archive('alpha', 'beat:../escape' as never)).toThrow();
  expect(
    store.appendMessage('alpha', { role: 'system', content: 'changed', tools: [{ name: 'new' }] })
      .seq
  ).toBe(1);
  store.close();
});
it('restores the newest repeated checkpoint after reopen without changing the original archive', () => {
  const file = fixture();
  let store = new SqliteModelStore(file);
  store.createSession('alpha');
  for (const content of ['one', 'two', 'three'])
    store.appendMessage('alpha', { role: 'user', content });
  for (const firstRetainedSeq of [2, 3])
    store.checkpoint('alpha', {
      summary: { role: 'user', content: `summary-${firstRetainedSeq}` },
      firstRetainedSeq,
      before: { tokens: 100, source: 'provider' },
      after: { tokens: 30, source: 'estimated' },
      usage: { requestId: `summary-${firstRetainedSeq}` },
    });
  store.close();
  store = new SqliteModelStore(file);
  expect(store.restore('alpha').messages.map((x) => x.payload.content)).toEqual([
    'summary-3',
    'three',
  ]);
  expect(store.archive('alpha')).toHaveLength(3);
  expect(store.usage('alpha')).toHaveLength(2);
  expect(() =>
    store.checkpoint('alpha', {
      summary: { role: 'user' },
      firstRetainedSeq: 9,
      before: { tokens: 1, source: 'estimated' },
      after: { tokens: 1, source: 'estimated' },
      usage: { requestId: 'invalid' },
    })
  ).toThrow();
  expect(store.usage('alpha')).toHaveLength(2);
  store.close();
});
it('checkpoints a previously accounted summary without double counting or accepting changed usage', () => {
  const store = new SqliteModelStore(fixture());
  store.createSession('alpha');
  store.appendMessage('alpha', { role: 'user' });
  const usage = { requestId: 'already-recorded', inputTokens: 12 };
  store.recordUsage('alpha', usage);
  const checkpoint = {
    summary: { role: 'user', content: 'summary' },
    firstRetainedSeq: 2,
    before: { tokens: 10, source: 'estimated' as const },
    after: { tokens: 5, source: 'estimated' as const },
    usage,
  };
  store.checkpoint('alpha', checkpoint);
  expect(store.usage('alpha')).toHaveLength(1);
  expect(() =>
    store.checkpoint('alpha', { ...checkpoint, usage: { ...usage, inputTokens: 13 } })
  ).toThrow('Usage request already recorded differently');
  store.close();
});
it('rejects non-string runtime identifiers rather than coercing them into another session', () => {
  const store = new SqliteModelStore(fixture());
  expect(() => store.createSession(123 as never)).toThrow('Invalid session id');
  store.createSession('valid');
  expect(() => store.archive('valid', 123 as never)).toThrow('Invalid context scope');
  store.close();
});
it('rejects sparse arrays, accessors and discarded properties without executing getters or advancing history', () => {
  const store = new SqliteModelStore(fixture());
  store.createSession('alpha');
  const sparse: unknown[] = [];
  sparse.length = 2;
  let reads = 0;
  const accessor = {
    role: 'user',
    get content() {
      reads++;
      return String(reads);
    },
  };
  const symbol = { role: 'user', [Symbol('discarded')]: 'secret' };
  const hidden = Object.defineProperty({ role: 'user' }, 'hidden', {
    value: 'discarded',
    enumerable: false,
  });
  const array = Object.assign(['valid'], { extra: 'discarded' });
  for (const payload of [
    { role: 'user', content: sparse },
    accessor,
    symbol,
    hidden,
    { role: 'user', content: array },
  ])
    expect(() => store.appendMessage('alpha', payload as never)).toThrow();
  expect(reads).toBe(0);
  expect(store.archive('alpha')).toHaveLength(0);
  expect(store.appendMessage('alpha', { role: 'user', content: 'valid' }).seq).toBe(1);
  const summary = {
    role: 'user',
    get content() {
      reads++;
      return 'invalid';
    },
  };
  expect(() =>
    store.checkpoint('alpha', {
      summary,
      firstRetainedSeq: 2,
      before: { tokens: 1, source: 'estimated' },
      after: { tokens: 1, source: 'estimated' },
      usage: { requestId: 'rejected' },
    })
  ).toThrow();
  expect(reads).toBe(0);
  expect(store.restore('alpha').checkpoint).toBeUndefined();
  expect(store.usage('alpha')).toHaveLength(0);
  store.close();
});
it('returns the same plain JSON snapshot it persists, preserving null prototypes and __proto__ data', () => {
  const store = new SqliteModelStore(fixture());
  store.createSession('alpha');
  const payload = Object.create(null);
  payload.role = 'user';
  Object.defineProperty(payload, '__proto__', { value: { nested: true }, enumerable: true });
  payload.content = ['valid'];
  const result = store.appendMessage('alpha', payload);
  payload.content.push('later');
  expect(result.payload).toEqual(store.archive('alpha')[0]?.payload);
  expect(Object.hasOwn(result.payload, '__proto__')).toBe(true);
  expect(result.payload['__proto__']).toEqual({ nested: true });
  const summary = { role: 'user', content: ['summary'] };
  const checkpoint = store.checkpoint('alpha', {
    summary,
    firstRetainedSeq: 2,
    before: { tokens: 2, source: 'estimated' },
    after: { tokens: 1, source: 'estimated' },
    usage: { requestId: 'summary' },
  });
  summary.content.push('later');
  expect(checkpoint).toEqual(store.restore('alpha').checkpoint);
  store.close();
});

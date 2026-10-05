import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexJsonRpcClient } from '../json-rpc-client.js';
import {
  CodexProcessExitedError,
  CodexRpcError,
  CodexRpcTimeoutError,
  classifyCodexRpcError,
} from '../protocol/errors.js';

/** An in-memory app-server: what the client writes, and a way to answer. */
function makePeer(options: ConstructorParameters<typeof CodexJsonRpcClient>[1] = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Array<Record<string, unknown>> = [];
  let buffered = '';
  stdin.on('data', (chunk: Buffer) => {
    buffered += chunk.toString();
    const lines = buffered.split('\n');
    buffered = lines.pop() ?? '';
    for (const line of lines) if (line) sent.push(JSON.parse(line) as Record<string, unknown>);
  });
  const client = new CodexJsonRpcClient({ stdin, stdout, stderr }, options);
  const send = (message: unknown): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { client, stdin, stdout, stderr, sent, send, flush };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('framing', () => {
  it('writes JSON-RPC without the jsonrpc field, one per line, and resolves by id', async () => {
    const peer = makePeer();
    const pending = peer.client.request('turn/interrupt', { threadId: 't', turnId: 'u' });
    await peer.flush();
    expect(peer.sent).toEqual([
      { id: 1, method: 'turn/interrupt', params: { threadId: 't', turnId: 'u' } },
    ]);
    peer.send({ id: 1, result: {} });
    await expect(pending).resolves.toEqual({});
    peer.client.notify('initialized');
    await peer.flush();
    expect(peer.sent[1]).toEqual({ method: 'initialized' });
    expect(JSON.stringify(peer.sent)).not.toContain('jsonrpc');
  });

  it('keeps a multi-byte character that arrives split across two chunks', async () => {
    const peer = makePeer();
    const pending = peer.client.request('config/read', { cwd: '/p' });
    await peer.flush();
    const bytes = Buffer.from(`${JSON.stringify({ id: 1, result: { name: 'Astrá 🚀' } })}\n`);
    const cut = bytes.indexOf(Buffer.from('🚀')) + 2;
    peer.stdout.write(bytes.subarray(0, cut));
    await peer.flush();
    peer.stdout.write(bytes.subarray(cut));
    await expect(pending).resolves.toEqual({ name: 'Astrá 🚀' });
  });

  it('treats a line over the cap as a protocol fault, newline or not', async () => {
    for (const terminated of [true, false]) {
      const peer = makePeer({ maxLineBytes: 64 });
      const pending = peer.client.request('config/read', { cwd: '/p' });
      peer.stdout.write('x'.repeat(65) + (terminated ? '\n' : ''));
      await expect(pending).rejects.toBeInstanceOf(CodexProcessExitedError);
      expect(peer.client.closedBecause?.kind).toBe('protocol-fault');
    }
  });

  it('treats a line that is not JSON as a protocol fault', async () => {
    const peer = makePeer();
    const pending = peer.client.request('config/read', { cwd: '/p' });
    peer.stdout.write('this is not json\n');
    await expect(pending).rejects.toThrow(/invalid JSON/);
    expect(peer.client.isClosed).toBe(true);
  });

  it('refuses to send a params object with a key the binary does not know', async () => {
    const peer = makePeer();
    await expect(
      peer.client.request('turn/interrupt', { threadId: 't', turnId: 'u', turnID: 'typo' } as never)
    ).rejects.toThrow(/Refusing to send turn\/interrupt/);
    await peer.flush();
    expect(peer.sent).toEqual([]);
  });
});

describe('requests', () => {
  it('times out, drops the entry, and ignores the late answer', async () => {
    vi.useFakeTimers();
    const peer = makePeer();
    const pending = peer.client.request('turn/start', {
      threadId: 't',
      input: [{ type: 'text', text: 'hi', text_elements: [] }],
      cwd: '/p',
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
      summary: 'auto',
    });
    const rejection = expect(pending).rejects.toBeInstanceOf(CodexRpcTimeoutError);
    // turn/start's default bound is 15 s.
    await vi.advanceTimersByTimeAsync(14_999);
    expect(peer.client.stats.lateResponses).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    vi.useRealTimers();
    peer.send({ id: 1, result: { turn: { id: 'late', status: 'inProgress' } } });
    await peer.flush();
    expect(peer.client.stats.lateResponses).toBe(1);
  });

  it('retries an overloaded request three times with 250/500/1000 ms backoff, then surfaces it', async () => {
    const waits: number[] = [];
    const peer = makePeer({ sleep: async (ms) => void waits.push(ms) });
    peer.stdin.on('data', () => {
      // Answer every attempt "overloaded", by the id it arrived with.
      setImmediate(() => {
        const last = peer.sent[peer.sent.length - 1]!;
        peer.send({
          id: last.id,
          error: { code: -32001, message: 'Server overloaded; retry later.' },
        });
      });
    });
    const err = await peer.client.request('config/read', { cwd: '/p' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CodexRpcError);
    expect((err as CodexRpcError).kind).toBe('overloaded');
    expect(waits).toEqual([250, 500, 1000]);
    expect(peer.sent.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it('succeeds on a retry after one overload', async () => {
    const peer = makePeer({ sleep: async () => {} });
    let answered = 0;
    peer.stdin.on('data', () => {
      setImmediate(() => {
        const last = peer.sent[peer.sent.length - 1]!;
        answered += 1;
        peer.send(
          answered === 1
            ? { id: last.id, error: { code: -32001, message: 'Server overloaded; retry later.' } }
            : { id: last.id, result: { config: {} } }
        );
      });
    });
    await expect(peer.client.request('config/read', { cwd: '/p' })).resolves.toEqual({
      config: {},
    });
  });

  it('classifies a rejection by its message, since every code is -32600', async () => {
    const peer = makePeer();
    const pending = peer.client.request('turn/interrupt', { threadId: 't', turnId: 'u' });
    await peer.flush();
    peer.send({ id: 1, error: { code: -32600, message: 'no active turn to interrupt' } });
    await expect(pending).rejects.toMatchObject({
      kind: 'no-active-turn',
      method: 'turn/interrupt',
    });
  });

  it.each([
    ['Not initialized', 'not-initialized'],
    ['Already initialized', 'already-initialized'],
    ['Invalid request: unknown variant `nope/nope`, expected one of …', 'unknown-method'],
    ['thread not found: 0000', 'thread-not-found'],
    ['no rollout found for thread id 01a10bcf', 'no-rollout'],
    ['no active turn to steer', 'no-active-turn'],
    ['expected active turn id `a` but found `b`', 'turn-mismatch'],
    [
      'thread/backgroundTerminals/list requires experimentalApi capability',
      'experimental-required',
    ],
    ['something else entirely', 'other'],
  ])('classifies %j as %s', (message, kind) => {
    expect(classifyCodexRpcError({ code: -32600, message })).toBe(kind);
  });

  it('classifies a not-steerable turn by its codexErrorInfo', () => {
    expect(
      classifyCodexRpcError({
        code: -32600,
        message: 'cannot steer a review/compact turn',
        data: { codexErrorInfo: { activeTurnNotSteerable: { turnKind: 'review' } } },
      })
    ).toBe('not-steerable');
  });
});

describe('server requests', () => {
  const approval = (id: number) => ({
    id,
    method: 'item/commandExecution/requestApproval',
    params: { threadId: 't', turnId: 'u', itemId: 'i' },
  });

  it('declines when nothing handles it, when the handler throws, and when it declines', async () => {
    const peer = makePeer();
    peer.send(approval(100));
    await peer.flush();
    peer.client.setServerRequestHandler(() => {
      throw new Error('boom');
    });
    peer.send(approval(101));
    await peer.flush();
    peer.client.setServerRequestHandler(() => undefined);
    peer.send(approval(102));
    await peer.flush();
    expect(peer.sent).toEqual([
      { id: 100, result: { decision: 'decline' } },
      { id: 101, result: { decision: 'decline' } },
      { id: 102, result: { decision: 'decline' } },
    ]);
  });

  it('answers each request exactly once with the handler’s reply', async () => {
    const peer = makePeer();
    peer.client.setServerRequestHandler(async () => ({ decision: 'decline' }));
    for (const id of [1, 2, 3]) peer.send(approval(id));
    await peer.flush();
    await peer.flush();
    expect(peer.sent.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it('answers a request with no refusal shape with a JSON-RPC error', async () => {
    const peer = makePeer();
    peer.send({ id: 7, method: 'currentTime/read', params: {} });
    await peer.flush();
    expect(peer.sent).toEqual([
      { id: 7, error: { code: -32601, message: 'DorkOS does not handle currentTime/read' } },
    ]);
  });
});

describe('notifications', () => {
  const delta = (threadId: string) => ({
    method: 'item/agentMessage/delta',
    params: { threadId, turnId: 'u', itemId: 'i', delta: 'hi' },
  });

  it('routes by threadId, sends thread-less ones to process subscribers, and ignores the unknown', async () => {
    const peer = makePeer();
    const a: string[] = [];
    const b: string[] = [];
    const proc: string[] = [];
    peer.client.subscribeThread('A', { notification: (n) => a.push(n.method), closed: () => {} });
    const unsubscribe = peer.client.subscribeThread('B', {
      notification: (n) => b.push(n.method),
      closed: () => {},
    });
    peer.client.subscribeProcess((n) => proc.push(n.method));
    peer.send(delta('A'));
    peer.send(delta('B'));
    peer.send({ method: 'configWarning', params: { summary: 'x', details: null } });
    peer.send({ method: 'brand/new/thing', params: { threadId: 'A' } });
    await peer.flush();
    unsubscribe();
    peer.send(delta('B'));
    await peer.flush();
    expect(a).toEqual(['item/agentMessage/delta']);
    expect(b).toEqual(['item/agentMessage/delta']);
    expect(proc).toEqual(['configWarning']);
    expect(peer.client.stats.unknownNotifications).toBe(1);
  });

  it('drops a malformed notification instead of throwing it into a turn', async () => {
    const peer = makePeer();
    const seen: unknown[] = [];
    peer.client.subscribeThread('A', { notification: (n) => seen.push(n), closed: () => {} });
    peer.send({ method: 'turn/completed', params: { threadId: 'A', turn: { id: 7 } } });
    await peer.flush();
    expect(seen).toEqual([]);
    expect(peer.client.stats.invalidNotifications).toBe(1);
    expect(peer.client.isClosed).toBe(false);
  });
});

describe('closing', () => {
  it('rejects every pending request and tells every subscriber, once', async () => {
    const peer = makePeer();
    const closed: string[] = [];
    peer.client.subscribeThread('A', {
      notification: () => {},
      closed: (c) => closed.push(c.kind),
    });
    peer.client.onClose((c) => closed.push(`listener:${c.kind}`));
    const pending = peer.client.request('config/read', { cwd: '/p' });
    peer.client.close({ kind: 'exited', detail: 'exit code 1' });
    peer.client.close({ kind: 'pipe', detail: 'second reason loses' });
    await expect(pending).rejects.toThrow('Codex stopped: exit code 1');
    expect(closed).toEqual(['exited', 'listener:exited']);
    await expect(peer.client.request('config/read', { cwd: '/p' })).rejects.toBeInstanceOf(
      CodexProcessExitedError
    );
  });

  it('treats a broken stdin pipe as a crash', async () => {
    const peer = makePeer();
    const pending = peer.client.request('config/read', { cwd: '/p' });
    peer.stdin.emit('error', new Error('write EPIPE'));
    await expect(pending).rejects.toThrow('EPIPE');
    expect(peer.client.closedBecause?.kind).toBe('pipe');
  });

  it('keeps a stderr tail with tokens redacted', async () => {
    const peer = makePeer();
    peer.stderr.write(
      'starting\nfailed with token sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd\n'
    );
    await peer.flush();
    const tail = peer.client.stderrTail();
    expect(tail).toContain('starting');
    expect(tail).not.toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcd');
  });
});

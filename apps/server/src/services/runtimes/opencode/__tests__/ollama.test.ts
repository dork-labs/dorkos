import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { OllamaPullProgress } from '@dorkos/shared/runtime-connect';
import { detectOllama, pullOllamaModel, resetOllamaCache, type FetchFn } from '../ollama.js';

/** A JSON Response double. */
function jsonResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** A streamed (NDJSON) Response double for the pull path — chunks fed as-is. */
function streamResp(status: number, chunks: string[]): Response {
  const encoder = new TextEncoder();
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (i < chunks.length) {
            const value = encoder.encode(chunks[i]);
            i += 1;
            return { done: false, value };
          }
          return { done: true, value: undefined };
        },
      }),
    },
  } as unknown as Response;
}

describe('detectOllama', () => {
  beforeEach(() => resetOllamaCache());

  it('reports running with the pulled models', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResp(200, {
        models: [{ name: 'qwen2.5-coder:7b', size: 4700000000 }, { name: 'llama3.2:3b' }],
      })
    ) as unknown as FetchFn;

    const status = await detectOllama({ fetchImpl });
    expect(status).toEqual({
      running: true,
      models: [{ name: 'qwen2.5-coder:7b', size: 4700000000 }, { name: 'llama3.2:3b' }],
    });
    // Loopback endpoint only — never a remote host.
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      'http://127.0.0.1:11434/api/tags'
    );
  });

  it('reports not-running (fast) when the connection is refused', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }) as unknown as FetchFn;

    await expect(detectOllama({ fetchImpl })).resolves.toEqual({ running: false, models: [] });
  });

  it('degrades honestly (no throw) on a malformed / non-JSON response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError('Unexpected token < in JSON');
          },
        }) as unknown as Response
    ) as unknown as FetchFn;

    await expect(detectOllama({ fetchImpl })).resolves.toEqual({ running: true, models: [] });
  });

  it('reports not-running when the endpoint answers non-2xx', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(500, {})) as unknown as FetchFn;
    await expect(detectOllama({ fetchImpl })).resolves.toEqual({ running: false, models: [] });
  });

  describe('with fake timers', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('bounds a hung Ollama by the probe timeout instead of hanging', async () => {
      // A fetch that never resolves on its own but honors the abort signal.
      const fetchImpl = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          })
      ) as unknown as FetchFn;

      const p = detectOllama({ fetchImpl });
      await vi.advanceTimersByTimeAsync(1_500);
      await expect(p).resolves.toEqual({ running: false, models: [] });
    });
  });
});

describe('pullOllamaModel', () => {
  it('streams in-progress frames then completes ok', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResp(200, [
        '{"status":"pulling manifest"}\n',
        '{"status":"downloading","completed":50,"total":100}\n',
        '{"status":"success"}\n',
      ])
    ) as unknown as FetchFn;

    const frames: OllamaPullProgress[] = [];
    const result = await pullOllamaModel('qwen2.5-coder:7b', (f) => frames.push(f), { fetchImpl });

    expect(result).toEqual({ ok: true, model: 'qwen2.5-coder:7b' });
    expect(frames).toContainEqual({ status: 'pulling manifest' });
    expect(frames).toContainEqual({
      status: 'downloading',
      completed: 50,
      total: 100,
      percent: 50,
    });
    // A status-only line (no completed/total) carries no percent.
    expect(frames).toContainEqual({ status: 'success' });

    // Loopback pull endpoint, streamed, carrying the requested model.
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe('http://127.0.0.1:11434/api/pull');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ model: 'qwen2.5-coder:7b', stream: true });
  });

  it('reassembles progress lines split across stream chunks', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResp(200, [
        '{"status":"down',
        'loading","completed":30,"total":60}\n{"status":"success"}\n',
      ])
    ) as unknown as FetchFn;

    const frames: OllamaPullProgress[] = [];
    const result = await pullOllamaModel('qwen2.5-coder:7b', (f) => frames.push(f), { fetchImpl });

    expect(result.ok).toBe(true);
    expect(frames).toContainEqual({
      status: 'downloading',
      completed: 30,
      total: 60,
      percent: 50,
    });
  });

  it('degrades to an honest error on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => streamResp(500, [])) as unknown as FetchFn;
    const result = await pullOllamaModel('qwen2.5-coder:7b', undefined, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.model).toBe('qwen2.5-coder:7b');
    expect(result.error).toMatch(/could not pull/i);
    expect(result.error).toMatch(/500/);
  });

  it('degrades to an honest error when the stream carries an error line', async () => {
    const fetchImpl = vi.fn(async () =>
      streamResp(200, [
        '{"status":"pulling manifest"}\n',
        '{"error":"model \\"nope\\" not found"}\n',
      ])
    ) as unknown as FetchFn;

    const frames: OllamaPullProgress[] = [];
    const result = await pullOllamaModel('qwen2.5-coder:7b', (f) => frames.push(f), { fetchImpl });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
    // The error line is not forwarded as a progress frame.
    expect(frames).not.toContainEqual(
      expect.objectContaining({ status: expect.stringContaining('error') })
    );
  });

  it('returns an honest error (no throw) when Ollama is unreachable', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    }) as unknown as FetchFn;

    await expect(pullOllamaModel('qwen2.5-coder:7b', undefined, { fetchImpl })).resolves.toEqual({
      ok: false,
      model: 'qwen2.5-coder:7b',
      error: expect.stringMatching(/could not pull/i),
    });
  });

  it('returns an honest error (no throw) when the download stream is interrupted', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          body: {
            getReader: () => ({
              read: async () => {
                throw new Error('stream reset');
              },
            }),
          },
        }) as unknown as Response
    ) as unknown as FetchFn;

    const result = await pullOllamaModel('qwen2.5-coder:7b', undefined, { fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/interrupted/i);
  });
});

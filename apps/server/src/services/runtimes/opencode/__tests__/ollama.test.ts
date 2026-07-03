import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectOllama, resetOllamaCache, type FetchFn } from '../ollama.js';

/** A JSON Response double. */
function jsonResp(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
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

import { afterEach, describe, it, expect, vi } from 'vitest';
import { logger } from '../../../../../lib/logger.js';
import {
  readBoundedText,
  requestManagedConnectorCatalog,
  type FetchLike,
} from '../../cloud-link-client.js';
import { BASE } from './cloud-link-client.fixtures.js';

describe('managed cloud refusals', () => {
  const catalog = (fetchImpl: FetchLike) =>
    requestManagedConnectorCatalog({
      baseUrl: BASE,
      accessToken: 'dork_inst_secret',
      request: { version: 1, limit: 10 },
      fetchImpl,
      signal: new AbortController().signal,
    }).catch((error: unknown) => error);

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [503, { error: 'managed_connectors_unavailable', reason: 'toolkit down' }, 'unavailable'],
    [400, { error: 'invalid_request' }, 'request_failed'],
  ])('reads the cloud error body on a %i', async (status, body, code) => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(
      catalog(vi.fn(async () => new Response(JSON.stringify(body), { status })))
    ).resolves.toMatchObject({ code, status, cloudCode: body.error });
  });

  it('maps a network failure to network_error', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    await expect(catalog(offline)).resolves.toMatchObject({ code: 'network_error' });
  });

  it('logs a refusal without the token, query string, or a long reason', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const longReason = 'r'.repeat(900);
    const error = await catalog(
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: 'conflict', reason: longReason }), { status: 409 })
      )
    );
    expect(error).toMatchObject({ code: 'conflict', reason: 'r'.repeat(200) });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('dork_inst_secret');
    expect(logged).not.toContain('limit=');
    expect(logged).not.toContain(longReason);
  });

  it('reads at most 16 KiB of a refusal body, however large the body is', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const chunk = new TextEncoder().encode('<html>' + 'x'.repeat(1_018));
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
          if (pulled >= 4 * 1024 * 1024) controller.close();
        },
      },
      { highWaterMark: 0 }
    );
    await expect(
      catalog(vi.fn(async () => new Response(body, { status: 502 })))
    ).resolves.toMatchObject({ code: 'unavailable', status: 502, cloudCode: undefined });
    expect(pulled).toBeLessThanOrEqual(16 * 1024 + chunk.byteLength);
  });

  it('logs an unexpected answer with issue paths only, never the values', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    await expect(
      catalog(
        vi.fn(
          async () =>
            new Response(JSON.stringify({ version: 1, toolkits: 'SECRET_VALUE' }), { status: 200 })
        )
      )
    ).resolves.toMatchObject({ code: 'invalid_response', status: 200 });
    expect(JSON.stringify(warn.mock.calls)).toContain('toolkits');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET_VALUE');
  });
});

describe('the bounded refusal-body reader', () => {
  it('releases the rest of the stream once it has read enough', async () => {
    const cancel = vi.fn();
    const chunk = new Uint8Array(1_024).fill(0x61);
    const body = new ReadableStream<Uint8Array>(
      { pull: (controller) => controller.enqueue(chunk), cancel },
      { highWaterMark: 0 }
    );
    await readBoundedText(new Response(body, { status: 502 }));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

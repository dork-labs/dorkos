/**
 * @vitest-environment node
 *
 * The credits relay (ADR 261002-221210): it opens only to a live key, forwards
 * only to the credits endpoint for that key's format on a fixed set of paths,
 * sets the token itself, and sends nothing upstream when it refuses.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startCreditsRelay, type CreditsRelay } from '../credits-relay.js';
import { CreditsUnavailableError } from '../credits-protocols.js';

interface Seen {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

const TOKEN = 'relay-test-token-not-real';
let upstream: http.Server;
let upstreamUrl: string;
let seen: Seen[];
let relay: CreditsRelay;
let refuseLaunch: boolean;
/** How the fake upstream answers; a test may swap it. */
let answer: (res: http.ServerResponse) => void;

beforeEach(async () => {
  seen = [];
  refuseLaunch = false;
  answer = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'x-secret-upstream': 'no' });
    res.write('data: one\n\n');
    res.end('data: two\n\n');
  };
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body });
      answer(res);
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/openai/v1/`;
  relay = await startCreditsRelay({
    resolveLaunch: async (protocol, label) => {
      if (refuseLaunch) throw new CreditsUnavailableError('unreachable', label);
      return { protocol, baseUrl: upstreamUrl, token: TOKEN, tokenId: 'it_1', expiresAt: '' };
    },
    limits: { maxBodyBytes: 1024 },
  });
});

afterEach(async () => {
  await relay.close();
  await new Promise((resolve) => upstream.close(resolve));
});

/** One request to the relay. */
function ask(
  url: string,
  init: { key?: string; method?: string; body?: string; headers?: Record<string, string> } = {}
) {
  return fetch(url, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.key ? { authorization: `Bearer ${init.key}` } : {}),
      'content-type': 'application/json',
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

describe('the credits relay', () => {
  it('forwards an allowed request to the fixed endpoint, on the token it sets itself', async () => {
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    expect(new URL(grant.baseUrl).hostname).toBe('127.0.0.1');
    const res = await ask(`${grant.baseUrl}/chat/completions?target=https://elsewhere.invalid`, {
      key: grant.key,
      body: '{"model":"m"}',
      headers: { 'x-api-key': 'theirs', cookie: 'c=1', 'x-forwarded-host': 'elsewhere.invalid' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-secret-upstream')).toBeNull();
    expect(await res.text()).toBe('data: one\n\ndata: two\n\n');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      method: 'POST',
      // The query is dropped: no request chooses where it goes.
      path: '/openai/v1/chat/completions',
      body: '{"model":"m"}',
    });
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Only the content headers travel; the relay key never does.
    for (const name of ['x-api-key', 'cookie', 'x-forwarded-host']) {
      expect(seen[0]?.headers[name]).toBeUndefined();
    }
    expect(JSON.stringify(seen[0]?.headers)).not.toContain(grant.key);
  });

  it('refuses a missing, wrong or revoked key, and sends nothing upstream', async () => {
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    const url = `${grant.baseUrl}/chat/completions`;
    expect((await ask(url, { body: '{}' })).status).toBe(401);
    expect((await ask(url, { key: 'dkr_wrong', body: '{}' })).status).toBe(401);
    relay.revoke(grant.key);
    const revoked = await ask(url, { key: grant.key, body: '{}' });
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({ error: { code: 'credits_unavailable' } });
    expect(seen).toEqual([]);
  });

  it('refuses any path, method or format the key was not issued for', async () => {
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    const origin = new URL(grant.baseUrl).origin;
    for (const [url, method] of [
      [`${grant.baseUrl}/files`, 'POST'],
      [`${grant.baseUrl}/chat/completions/../../admin`, 'POST'],
      [`${grant.baseUrl}/chat/completions`, 'GET'],
      [`${origin}/relay/openai-responses/responses`, 'POST'],
      [`${origin}/chat/completions`, 'POST'],
    ] as const) {
      const res = await ask(url, {
        key: grant.key,
        method,
        ...(method === 'POST' ? { body: '{}' } : {}),
      });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a body over the limit, and sends nothing upstream', async () => {
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    const res = await ask(`${grant.baseUrl}/chat/completions`, {
      key: grant.key,
      body: 'x'.repeat(2048),
    });
    expect(res.status).toBe(413);
    expect(seen).toEqual([]);
  });

  it('says so, and sends nothing, when credits cannot pay right now', async () => {
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    refuseLaunch = true;
    const res = await ask(`${grant.baseUrl}/chat/completions`, { key: grant.key, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({
      error: { code: 'credits_unavailable', message: expect.stringContaining('OpenCode') },
    });
    expect(seen).toEqual([]);
  });

  it('passes the endpoint’s own refusal through, so a refused token is said as one', async () => {
    answer = (res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":{"message":"token revoked","code":"token_revoked"}}');
    };
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    const res = await ask(`${grant.baseUrl}/chat/completions`, { key: grant.key, body: '{}' });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: { code: 'token_revoked' } });
  });

  it('ends a request in flight when everything is stopped (an unlink)', async () => {
    answer = (res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: started\n\n');
      // Never ends on its own.
    };
    const grant = relay.issue('openai-chat-completions', 'OpenCode');
    const res = await ask(`${grant.baseUrl}/chat/completions`, { key: grant.key, body: '{}' });
    const reader = res.body!.getReader();
    await reader.read();
    relay.abortAll();
    // The relayed answer stops: it ends or is cut off, and never runs on.
    const outcome = await (async () => {
      try {
        for (;;) {
          const { done } = await reader.read();
          if (done) return 'ended';
        }
      } catch {
        return 'cut off';
      }
    })();
    expect(['ended', 'cut off']).toContain(outcome);
  });

  it('carries no format it was not built for', () => {
    expect(() => relay.issue('anthropic-messages', 'Claude Code')).toThrow();
  });
});

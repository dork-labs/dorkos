import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  jsonBodyParser,
  parseRequestBody,
  readJsonBody,
  underMount,
  type BodyRule,
  type RequestBodyEnv,
} from '../request-body.js';
import { serve } from './serve.js';

/** An app that parses with `rules` then echoes what it read. */
function echoApp(rules: readonly BodyRule[] = []): Hono<RequestBodyEnv> {
  const app = new Hono<RequestBodyEnv>();
  app.use(parseRequestBody<RequestBodyEnv>({ rules, fallback: jsonBodyParser(64) }));
  app.post('/*', (c) => c.json({ body: readJsonBody(c, { emptyAs: 'none' }) ?? null }));
  app.onError((error, c) =>
    c.json({ thrown: (error as { type?: string }).type ?? 'unknown' }, 500)
  );
  return app;
}

const post = (url: string, body: string, contentType = 'application/json') =>
  fetch(url, { method: 'POST', headers: { 'content-type': contentType }, body });

describe('underMount', () => {
  it('matches the prefix and below it, ignoring case, at a segment boundary', () => {
    expect(underMount('/MCP', '/mcp')).toBe(true);
    expect(underMount('/mcp/x', '/mcp')).toBe(true);
    expect(underMount('/mcpx', '/mcp')).toBe(false);
  });
});

describe('parseRequestBody', () => {
  it('parses JSON once and hands it to the route', async () => {
    const base = await serve(echoApp());
    expect(await (await post(`${base}/a`, '{"a":1}')).json()).toEqual({ body: { a: 1 } });
  });

  it('reads no body as the route asked', async () => {
    const base = await serve(echoApp());
    const res = await fetch(`${base}/a`, { method: 'POST' });
    expect(await res.json()).toEqual({ body: 'none' });
  });

  it('throws a body over the bound to the error handler', async () => {
    const base = await serve(echoApp());
    const res = await post(`${base}/a`, JSON.stringify({ text: 'x'.repeat(100) }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ thrown: 'entity.too.large' });
  });

  it('runs a matching rule instead, and lets it answer its own refusal', async () => {
    const rule: BodyRule = {
      matches: (_method, path) => underMount(path, '/big'),
      parse: jsonBodyParser(1024),
      answerFailure: () => ({ status: 413, body: { refused: true } }),
    };
    const base = await serve(echoApp([rule]));
    const ok = await post(`${base}/big`, JSON.stringify({ text: 'x'.repeat(100) }));
    expect(ok.status).toBe(200);
    const refused = await post(`${base}/big`, JSON.stringify({ text: 'x'.repeat(2000) }));
    expect(refused.status).toBe(413);
    expect(await refused.json()).toEqual({ refused: true });
  });
});

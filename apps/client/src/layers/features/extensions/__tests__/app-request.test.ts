import { describe, expect, it } from 'vitest';
import {
  APP_FAILURE_BODY_MAX,
  AppRequestFailure,
  extensionRequestPath,
  readAppResponse,
} from '../frame/app-request';

describe('the path rule for api.request (DOR-3293)', () => {
  it.each([
    ['/loop', '/ext/atlas/loop'],
    ['/', '/ext/atlas/'],
    ['/reports/q3.v2', '/ext/atlas/reports/q3.v2'],
    ['/files/report:final', '/ext/atlas/files/report%3Afinal'],
    ['/items/', '/ext/atlas/items/'],
    ['/loop?state=open&page=2', '/ext/atlas/loop?state=open&page=2'],
    ['/search?q=a b', '/ext/atlas/search?q=a+b'],
  ])('allows %s inside the app', (path, expected) => {
    expect(extensionRequestPath('atlas', path)).toBe(expected);
  });

  it.each([
    ['a dot-dot segment', '/../quill'],
    ['a dot-dot later on', '/a/../../quill'],
    ['a dot segment', '/a/./b'],
    ['an encoded dot-dot', '/%2e%2e/quill'],
    ['an encoded slash', '/x/%2f../quill'],
    ['any raw %', '/a%20b'],
    ['a backslash', '/a\\..\\quill'],
    ['an empty segment (//)', '//evil.example'],
    ['a fragment', '/loop#x'],
    ['no leading slash', 'loop'],
    ['a full address', 'https://evil.example/x'],
    ['a control character', '/a\u0000b'],
    ['a very long path', `/${'a'.repeat(4001)}`],
  ])('refuses %s', (_label, path) => {
    expect(() => extensionRequestPath('atlas', path)).toThrow('Use a path inside this app.');
  });
});

describe('what an app sees when its route fails', () => {
  it('rejects with the status and the JSON body', async () => {
    const failure = await readAppResponse(
      new Response(JSON.stringify({ error: 'locked' }), { status: 423 })
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppRequestFailure);
    expect(failure).toMatchObject({ status: 423, body: { error: 'locked' } });
  });

  it.each([401, 403, 404, 409, 423])('tells %i apart from the others', async (status) => {
    await expect(readAppResponse(new Response('no', { status }))).rejects.toMatchObject({
      status,
      body: 'no',
    });
  });

  it('carries no reply headers, and caps a long body as text', async () => {
    const response = new Response('x'.repeat(APP_FAILURE_BODY_MAX + 10), {
      status: 500,
      headers: { 'Set-Cookie': 'session=secret', 'WWW-Authenticate': 'Bearer' },
    });
    const failure = (await readAppResponse(response).catch((error: unknown) => error)) as Record<
      string,
      unknown
    >;
    expect(failure).not.toHaveProperty('headers');
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(JSON.stringify(failure)).not.toContain('Bearer');
    expect((failure.body as string).length).toBe(APP_FAILURE_BODY_MAX);
  });

  it('returns JSON or text on success, and null for no content', async () => {
    expect(await readAppResponse(new Response('{"a":1}'))).toEqual({ a: 1 });
    expect(await readAppResponse(new Response('plain'))).toBe('plain');
    expect(await readAppResponse(new Response(null, { status: 204 }))).toBeNull();
  });
});

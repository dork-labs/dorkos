/**
 * What a `dork:` link's refusal looks like by the time the `/r/` route reads
 * it (DOR-5046): the real HTTP transport over a stubbed `fetch`, handed to the
 * real `beforeLoad`. The route decides "not found" on the 404 alone, so it
 * holds when capability refusals become problem documents with the code
 * `not_found`, and a different status never reads as not found because its
 * body happens to say `LINK_NOT_FOUND`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dorkLinkBeforeLoad } from '../../dork-link-route';
import { createDorkLinkMethods } from '../dork-link-methods';

/** Answer every request with this status and JSON body. */
function serverAnswers(status: number, body: unknown, contentType = 'application/json') {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** Run the `/r/` route's `beforeLoad` over the real HTTP transport. */
function openLink(href: string) {
  return dorkLinkBeforeLoad({
    context: { transport: createDorkLinkMethods('/api') },
    location: { href },
    preload: false,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the /r/ route over the HTTP transport', () => {
  it('asks GET /api/links/target with the reference as `uri`', async () => {
    const fetchMock = serverAnswers(200, { kind: 'room', roomId: '01JD3G' });
    await expect(openLink('/r/dork:room:01JD3G')).rejects.toMatchObject({
      options: { to: '/channels', search: { id: '01JD3G' }, replace: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/links/target?uri=dork%3Aroom%3A01JD3G',
      expect.anything()
    );
  });

  it('shows not-found for a 404 problem document with the code `not_found`', async () => {
    serverAnswers(
      404,
      {
        type: 'urn:dorkos:problem:not_found',
        title: 'Not found.',
        status: 404,
        code: 'not_found',
      },
      'application/problem+json'
    );
    await expect(openLink('/r/dork:chat:gone')).resolves.toBeUndefined();
  });

  it('shows not-found for today’s 404 refusal too', async () => {
    serverAnswers(404, {
      error: 'That link opens nothing you can see here.',
      code: 'LINK_NOT_FOUND',
    });
    await expect(openLink('/r/dork:chat:gone')).resolves.toBeUndefined();
  });

  it('never reads a non-404 as not-found, whatever code its body carries', async () => {
    serverAnswers(500, { error: 'Internal server error', code: 'LINK_NOT_FOUND' });
    await expect(openLink('/r/dork:chat:gone')).rejects.toMatchObject({ status: 500 });
  });
});

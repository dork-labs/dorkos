/**
 * Canonical Community link rows of the tenant isolation matrix (spec
 * `community-tenancy-contract`): a link carrying credentials or anything but
 * the exact `/c/:communityId` shape is refused, and a DNS answer that changes
 * after the check can never steer the socket.
 */
import dns from 'node:dns';
import { createServer, get, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PinnedOriginError,
  checkedAddress,
  parseCommunityLink,
  parseCommunityOrigin,
  pinnedJson,
} from '../pinned-origin.js';

const communityId = randomUUID();
let server: Server;
let port = 0;

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ id: communityId }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address');
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('canonical community links', () => {
  it('extracts the tenant from an exact link and refuses credentials and every other shape', () => {
    expect(parseCommunityLink(`https://community.example:8443/c/${communityId}`)).toEqual({
      origin: new URL('https://community.example:8443'),
      communityId,
      shortName: null,
    });
    for (const invalid of [
      `https://owner:secret@community.example/c/${communityId}`,
      `https://owner@community.example/c/${communityId}`,
      `http://owner:secret@localhost:6481/c/${communityId}`,
      `https://community.example/c/${communityId}#${randomUUID()}`,
      `https://community.example/c/${communityId}/`,
      `https://community.example/c/${communityId}%2F${randomUUID()}`,
      `https://community.example/c/${encodeURIComponent(communityId)}%00`,
      `https://community.example/c//${communityId}`,
      `https://community.example/C/${communityId}`,
      `http://community.example/c/${communityId}`,
    ]) {
      expect(() => parseCommunityLink(invalid), invalid).toThrow(PinnedOriginError);
    }
  });

  it('opens the socket on the one checked DNS answer, never a second lookup', async () => {
    // Every socket-level lookup in this process now fails and is counted. A
    // request that still succeeds therefore never asked DNS a second time.
    const lookups: string[] = [];
    const original = dns.lookup;
    dns.lookup = ((hostname: string, ...rest: unknown[]) => {
      lookups.push(hostname);
      const callback = rest.at(-1) as (error: Error) => void;
      process.nextTick(() => callback(Object.assign(new Error('rebound'), { code: 'ENOTFOUND' })));
    }) as typeof dns.lookup;
    try {
      // Control: an ordinary request does consult the patched lookup and fails.
      await expect(
        new Promise((resolve, reject) =>
          get(`http://localhost:${port}/api/v1/community`, resolve).once('error', reject)
        )
      ).rejects.toMatchObject({ code: 'ENOTFOUND' });
      expect(lookups).toEqual(['localhost']);

      await expect(
        pinnedJson(parseCommunityOrigin(`http://localhost:${port}`), '/api/v1/community')
      ).resolves.toEqual({ id: communityId });
      expect(lookups).toEqual(['localhost']);
    } finally {
      dns.lookup = original;
    }
  });

  it('rechecks every resolution, so an answer that changes to a private address is refused', async () => {
    const answers = [
      [{ address: '8.8.8.8', family: 4 }],
      [{ address: '10.0.0.7', family: 4 }],
      [{ address: '::ffff:192.168.1.4', family: 6 }],
    ];
    const resolve = async () => answers.shift()!;
    const origin = parseCommunityOrigin('https://community.example');
    await expect(checkedAddress(origin, resolve)).resolves.toEqual({
      address: '8.8.8.8',
      family: 4,
    });
    await expect(checkedAddress(origin, resolve)).rejects.toMatchObject({
      code: 'UNSAFE_ADDRESS',
    });
    await expect(checkedAddress(origin, resolve)).rejects.toMatchObject({
      code: 'UNSAFE_ADDRESS',
    });
  });
});

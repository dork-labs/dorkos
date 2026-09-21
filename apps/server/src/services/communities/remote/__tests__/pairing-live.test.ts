/** Opt-in proof against a disposable, built Community deployment. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RemoteConnectionStore } from '../connection-store.js';
import { RemoteCommunityPairingService } from '../pairing-service.js';

const url = process.env.COMMUNITY_TEST_REAL_PAIRING_URL;
const cookieFile = process.env.COMMUNITY_TEST_REAL_PAIRING_COOKIE_FILE;

describe.skipIf(!url || !cookieFile)('pairing with a built Community deployment', () => {
  it('approves in the remote session, exchanges privately, survives restart and returns only public status', async () => {
    const origin = url!;
    const saved = JSON.parse(await readFile(cookieFile!, 'utf8')) as {
      cookies: Record<string, string>;
    };
    const cookie = Object.entries(saved.cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
    const directory = await mkdtemp(join(tmpdir(), 'community-live-pairing-'));
    const ownerKey = 'live-local-owner';
    const name = `DorkOS pairing proof ${randomUUID()}`;
    let ref:
      Awaited<ReturnType<RemoteCommunityPairingService['start']>>['connection']['ref'] | undefined;
    let communityId: string | undefined;
    try {
      const store = new RemoteConnectionStore(directory);
      const service = new RemoteCommunityPairingService(store);
      const started = await service.start(ownerKey, origin, name);
      ref = started.connection.ref;
      communityId = started.connection.remoteCommunityId;
      const approval = new URL(started.approvalUrl);
      expect(approval.origin).toBe(new URL(origin).origin);
      const apiBase = `/api/v1/communities/${started.connection.remoteCommunityId}`;
      const approved = await fetch(new URL(`${apiBase}/pairings/approve`, origin), {
        method: 'POST',
        headers: { cookie, origin: new URL(origin).origin, 'content-type': 'application/json' },
        body: JSON.stringify({ pairingId: approval.searchParams.get('pairingId') }),
      });
      expect(approved.status).toBe(200);
      const completed = await service.poll(ref, ownerKey);
      expect(completed.status).toBe('connected');
      const restarted = new RemoteCommunityPairingService(new RemoteConnectionStore(directory));
      expect((await restarted.status(ref, ownerKey)).connectedHumanMemberId).toBeTruthy();
      const secret = await new RemoteConnectionStore(directory).personalToken(ref, ownerKey);
      expect(secret.length).toBeGreaterThan(30);
      expect(JSON.stringify(completed)).not.toContain(secret);
      expect(JSON.stringify(await restarted.list(ownerKey))).not.toContain(secret);
      expect(
        await readFile(join(directory, 'communities', 'remote', 'connections.json'), 'utf8')
      ).not.toContain(secret);
    } finally {
      const apiBase = communityId ? `/api/v1/communities/${communityId}` : null;
      const grants = apiBase
        ? await fetch(new URL(`${apiBase}/me/grants`, origin), { headers: { cookie } })
        : null;
      if (grants?.ok) {
        const data = (await grants.json()) as {
          grants: Array<{ id: string; installName: string }>;
        };
        for (const grant of data.grants.filter((item) => item.installName === name)) {
          await fetch(new URL(`${apiBase}/me/grants/${grant.id}`, origin), {
            method: 'DELETE',
            headers: { cookie, origin: new URL(origin).origin },
          });
        }
      }
      if (ref) await new RemoteConnectionStore(directory).disconnect(ref, ownerKey);
      await rm(directory, { recursive: true, force: true });
    }
  });
});

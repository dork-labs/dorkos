import { describe, expect, it, vi } from 'vitest';
import { runCommunityLiveOwnerProof } from '../../scripts/community-deploy-live-proof.js';

const communityId = '7ea92c45-1e1d-4bb8-9602-e10816488828';
const memberId = '9ce578bc-4084-4ddf-8447-321cdacbe33a';
const channelId = 'b21ab2b5-cbfa-4f22-b71e-ae56f0f44634';
const attachmentId = '6a154a24-eea3-4ef8-9b5b-beb77214a7d1';
const entryId = '2357098b-84d5-43c0-a678-fc3863e33d2b';

function harness(
  options: { corruptFile?: boolean; publicFile?: boolean; failSetup?: boolean } = {}
) {
  let stored = new Uint8Array();
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    if (path.endsWith('/bootstrap/preflight')) {
      if (options.failSetup) return Response.json({ error: 'secret-from-server' }, { status: 403 });
      return Response.json(
        {},
        { headers: { 'set-cookie': 'community_bootstrap=bootstrap-cookie; HttpOnly; Secure' } }
      );
    }
    if (path.endsWith('/bootstrap/complete')) {
      expect(headers.get('cookie')).toContain('community_bootstrap=bootstrap-cookie');
      return Response.json(
        { community: { id: communityId }, memberId, channelId },
        { status: 201 }
      );
    }
    if (path.endsWith('/sign-in/email')) {
      return Response.json(
        {},
        {
          headers: {
            'set-cookie': '__Secure-better-auth.session_token=session-secret; HttpOnly; Secure',
          },
        }
      );
    }
    if (path.endsWith('/attachments') && init?.method === 'POST') {
      expect(headers.get('cookie')).toContain('session-secret');
      stored = new Uint8Array(init.body as Uint8Array);
      return Response.json({ attachment: { id: attachmentId } }, { status: 201 });
    }
    if (path.endsWith('/entries')) {
      expect(JSON.parse(String(init?.body)).attachmentIds).toEqual([attachmentId]);
      return Response.json({ entry: { id: entryId } }, { status: 201 });
    }
    if (path.endsWith(`/attachments/${attachmentId}`)) {
      if (!headers.has('cookie') && !options.publicFile) {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }
      return new Response(options.corruptFile ? 'wrong bytes' : stored);
    }
    throw new Error('Unexpected path');
  });
  const run = () =>
    runCommunityLiveOwnerProof({
      appName: 'dorkos-gate-012345abcdef',
      bootstrapSecret: 'setup-secret',
      signal: new AbortController().signal,
      fetch,
    });
  return { fetch, run };
}

describe('credentialed Community HTTP proof', () => {
  it('creates through atomic setup and proves an authenticated file round trip without leaking secrets', async () => {
    const { run, fetch } = harness();
    const receipt = await run();
    expect(receipt).toEqual({
      communityId,
      channelId,
      attachmentId,
      entryId,
      ownerCreated: true,
      privateFileRoundTrip: true,
      anonymousDownloadDenied: true,
    });
    expect(fetch).toHaveBeenCalledTimes(7);
    for (const [url, init] of fetch.mock.calls) {
      expect(String(url).startsWith('https://dorkos-gate-012345abcdef.fly.dev/api/')).toBe(true);
      expect(init?.redirect).toBe('error');
    }
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      'setup-secret',
      'session-secret',
      'bootstrap-cookie',
      '@',
      'Release acceptance file',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('fails when downloaded bytes are not the uploaded private file', async () => {
    await expect(harness({ corruptFile: true }).run()).rejects.toThrow('file-integrity');
  });

  it('fails if the file can be downloaded without a session', async () => {
    await expect(harness({ publicFile: true }).run()).rejects.toThrow('http-status');
  });

  it('does not create an account when bootstrap preflight is refused', async () => {
    const { run, fetch } = harness({ failSetup: true });
    await expect(run()).rejects.toThrow('http-status');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an existing production app before any network request', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    await expect(
      runCommunityLiveOwnerProof({
        appName: 'dorkos-community',
        bootstrapSecret: 'x',
        signal: new AbortController().signal,
        fetch,
      })
    ).rejects.toThrow('disposable-origin');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sanitizes network errors rather than emitting request credentials', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error('session-secret setup-secret'));
    const failure = await runCommunityLiveOwnerProof({
      appName: 'dorkos-gate-012345abcdef',
      bootstrapSecret: 'setup-secret',
      signal: new AbortController().signal,
      fetch,
    }).catch((error: unknown) => error);
    expect(String(failure)).toContain('owner-or-file');
    expect(String(failure)).not.toContain('secret');
  });
});

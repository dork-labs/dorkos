import { describe, expect, it, vi } from 'vitest';
import {
  runCommunityLiveOwnerProof,
  runCommunityLiveSecondMemberProof,
} from '../../scripts/community-deploy-live-proof.js';

const communityId = '7ea92c45-1e1d-4bb8-9602-e10816488828';
const ownerMemberId = '9ce578bc-4084-4ddf-8447-321cdacbe33a';
const secondMemberId = '4f0f3a53-0f64-4d69-9d1e-3a4b5c6d7e8f';
const channelId = 'b21ab2b5-cbfa-4f22-b71e-ae56f0f44634';
const attachmentId = '6a154a24-eea3-4ef8-9b5b-beb77214a7d1';
const entryId = '2357098b-84d5-43c0-a678-fc3863e33d2b';
const replyId = '0d1e2f3a-4b5c-4d6e-8f70-8192a3b4c5d6';
const INVITE_TOKEN = 'invite-token-secret';
const APP = 'dorkos-gate-012345abcdef';

type Faults = {
  /** The member downloads different bytes from the ones the owner uploaded. */
  corruptMemberFile?: boolean;
  /** An anonymous download succeeds once a member has joined. */
  publicAfterJoin?: boolean;
  /** The channel page does not contain the owner's post. */
  hideOwnerPost?: boolean;
  /** Redemption is refused. */
  refuseRedeem?: boolean;
  /** A signed-in account that has not joined can download the private file. */
  openToSignedIn?: boolean;
  /** The member's reply lands as a new top-level post instead of in the owner's thread. */
  replyTopLevel?: boolean;
};

/**
 * A fake Community that tells its two sessions apart by cookie, in the same fetch-mock style as
 * `community-deploy-live-proof.test.ts`. It checks every call the second person makes carries the
 * member's session, not the owner's, and that the join runs preflight, sign-up, bind, redeem.
 */
function community(faults: Faults = {}) {
  let stored = new Uint8Array();
  const calls: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const cookie = new Headers(init?.headers).get('cookie') ?? '';
    const method = init?.method ?? 'GET';
    const owner = cookie.includes('owner-session');
    const member = cookie.includes('member-session');
    calls.push(`${method} ${path.replace(`/api/v1/communities/${communityId}`, '')}`);
    if (path.endsWith('/bootstrap/preflight'))
      return Response.json({}, { headers: { 'set-cookie': 'community_bootstrap=b; HttpOnly' } });
    if (path.endsWith('/bootstrap/complete'))
      return Response.json(
        { community: { id: communityId }, memberId: ownerMemberId, channelId },
        { status: 201 }
      );
    if (path.endsWith('/sign-in/email'))
      return Response.json(
        {},
        { headers: { 'set-cookie': '__Secure-better-auth.session_token=owner-session; HttpOnly' } }
      );
    if (path.endsWith('/invites') && method === 'POST') {
      expect(owner).toBe(true);
      expect(JSON.parse(String(init?.body))).toEqual({ channelId, seats: 1, expiresInDays: 1 });
      return Response.json({ invite: { id: 'i' }, token: INVITE_TOKEN }, { status: 201 });
    }
    if (path.endsWith('/invites/preflight')) {
      // A fresh browser: the owner's session must not ride along.
      expect(cookie).toBe('');
      expect(JSON.parse(String(init?.body))).toEqual({ token: INVITE_TOKEN });
      return Response.json(
        { granted: true },
        { headers: { 'set-cookie': 'community_admission=admission-grant; HttpOnly' } }
      );
    }
    if (path.endsWith('/sign-up/email')) {
      expect(cookie).toContain('admission-grant');
      return Response.json(
        {},
        { headers: { 'set-cookie': '__Secure-better-auth.session_token=member-session; HttpOnly' } }
      );
    }
    if (path.endsWith('/invites/bind')) {
      expect(member).toBe(true);
      return Response.json({ bound: true });
    }
    if (path.endsWith('/invites/redeem')) {
      expect(member).toBe(true);
      if (faults.refuseRedeem) return Response.json({ error: 'nope' }, { status: 409 });
      return Response.json({ memberId: secondMemberId });
    }
    if (path.endsWith('/attachments') && method === 'POST') {
      stored = new Uint8Array(init?.body as Uint8Array);
      return Response.json({ attachment: { id: attachmentId } }, { status: 201 });
    }
    if (path.endsWith('/entries') && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { parentEntryId?: string };
      if (member) {
        expect(body.parentEntryId).toBe(entryId);
        return Response.json(
          { entry: { id: replyId, parentEntryId: faults.replyTopLevel ? null : entryId } },
          { status: 201 }
        );
      }
      return Response.json({ entry: { id: entryId } }, { status: 201 });
    }
    if (path.endsWith('/entries') && method === 'GET') {
      expect(member).toBe(true);
      return Response.json({
        entries: faults.hideOwnerPost ? [] : [{ id: entryId, parentEntryId: null }],
        nextCursor: null,
      });
    }
    if (path.endsWith(`/attachments/${attachmentId}`)) {
      const joined = calls.includes('POST /invites/redeem');
      if (!cookie && !(faults.publicAfterJoin && joined))
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      if (member && !joined && !faults.openToSignedIn)
        return Response.json({ error: 'Not a member' }, { status: 403 });
      return new Response(member && faults.corruptMemberFile ? 'wrong bytes' : stored);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  const run = async () => {
    const signal = new AbortController().signal;
    const { owner } = await runCommunityLiveOwnerProof({
      appName: APP,
      bootstrapSecret: 'setup-secret',
      signal,
      fetch,
    });
    return runCommunityLiveSecondMemberProof(owner, { appName: APP, signal, fetch });
  };
  return { fetch, calls, run };
}

describe('second-member Community HTTP proof', () => {
  it('joins with a one-time invite, reads, replies, and downloads the private file', async () => {
    // Catches the join order, the reply thread or the file check silently changing.
    const { run, calls } = community();
    const { receipt, access } = await run();
    expect(receipt).toEqual({
      secondMemberId,
      secondMemberReplyEntryId: replyId,
      secondMemberProof: true,
    });
    expect(calls.slice(7)).toEqual([
      'POST /invites',
      'POST /invites/preflight',
      'POST /api/auth/sign-up/email',
      `GET /attachments/${attachmentId}`,
      'POST /invites/bind',
      'POST /invites/redeem',
      `GET /channels/${channelId}/entries`,
      `POST /channels/${channelId}/entries`,
      `GET /attachments/${attachmentId}`,
      `GET /attachments/${attachmentId}`,
    ]);
    expect(access).toMatchObject({
      origin: `https://${APP}.fly.dev`,
      communityId,
      channelId,
      inviteLink: `https://${APP}.fly.dev/c/${communityId}/join#invite=${INVITE_TOKEN}`,
    });
    expect(access.owner.email).not.toBe(access.member.email);
    expect(access.owner.password).not.toBe(access.member.password);
  });

  it('keeps every credential and the invitation out of the receipt', async () => {
    // Catches a receipt field that would carry a password, email, session or the invite token.
    const { receipt, access } = await community().run();
    const serialized = JSON.stringify(receipt);
    for (const forbidden of [
      access.owner.password,
      access.member.password,
      access.owner.email,
      access.member.email,
      INVITE_TOKEN,
      'member-session',
      'owner-session',
      'admission-grant',
      '@',
    ])
      expect(serialized).not.toContain(forbidden);
  });

  it('fails when the member downloads different bytes from the owner upload', async () => {
    // Catches a proof that only checks the status, not the file's sha256.
    await expect(community({ corruptMemberFile: true }).run()).rejects.toThrow(
      'member-file-integrity'
    );
  });

  it('fails when an anonymous download is no longer refused after a member joins', async () => {
    // Catches a membership change that opens the private file to everyone.
    await expect(community({ publicAfterJoin: true }).run()).rejects.toThrow(
      'member-anonymous-download'
    );
  });

  it('fails when the member cannot see the owner post', async () => {
    // Catches a member admitted to the community but not to the channel.
    await expect(community({ hideOwnerPost: true }).run()).rejects.toThrow('member-read');
  });

  it('fails when a signed-in account that has not joined can download the private file', async () => {
    // Catches file access granted to any account on the server rather than to members.
    await expect(community({ openToSignedIn: true }).run()).rejects.toThrow('non-member-download');
  });

  it('fails when the reply does not land in the owner thread', async () => {
    // Catches a reply accepted as a new top-level post, which would not prove threading.
    await expect(community({ replyTopLevel: true }).run()).rejects.toThrow('member-reply');
  });

  it('names only the failing step when the server refuses the join', async () => {
    // Catches a refusal reported with server text instead of a fixed step.
    const failure = await community({ refuseRedeem: true })
      .run()
      .catch((error: unknown) => error);
    expect(String(failure)).toBe(
      'CommunityLiveProofError: Community live proof failed (member-join)'
    );
  });

  it('sanitizes a network error that carries the invitation', async () => {
    // Catches a fetch error message (which can hold a URL or token) reaching the gate's output.
    const { fetch, run } = community();
    const real = fetch.getMockImplementation()!;
    fetch.mockImplementation(async (input, init) => {
      if (String(input).endsWith('/invites/preflight'))
        throw new Error(`connect failed ${INVITE_TOKEN}`);
      return real(input, init);
    });
    const failure = await run().catch((error: unknown) => error);
    expect(String(failure)).toContain('member-join');
    expect(String(failure)).not.toContain(INVITE_TOKEN);
  });
});

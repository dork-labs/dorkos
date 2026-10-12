/**
 * A Community on loopback, for contract files that drive the space routes
 * (`/api/community-connections`, `/api/communities`) through a real pairing,
 * the real adapter and the real event stream, with nothing leaving the machine.
 *
 * It speaks just enough of the v1 wire contract (`@dorkos/shared/community-wire`)
 * for one person's connection: discovery, a pairing it approves at once, the
 * access check, one channel with one message, the read cursor, joining and
 * leaving, the roster, posting, files, the event stream's snapshot, the
 * redaction feed, the moderation reads and writes, and revoking the grant. It
 * serves any number of communities, each by its own id, on one origin, so a
 * test can pair an official space and another one beside it. Anything else
 * answers the Community's coded 404.
 *
 * Loopback over plain HTTP is the one origin the pairing service accepts
 * without TLS (`parseCommunityLink`), which is what makes this possible from a
 * contract server.
 *
 * @module http/__tests__/contract/fake-community
 */
import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

/** The one channel every fake community has. */
export const FAKE_CHANNEL_ID = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

/** A fixed moment, so every answer that names one is the same each run. */
const AT = '2026-09-23T12:00:00.000Z';

/** A running fake Community. */
export interface FakeCommunity {
  /** Its origin, e.g. `http://127.0.0.1:53511`. */
  readonly origin: string;
  /** The canonical link for one community it serves: `<origin>/c/<id>`. */
  link(communityId: string): string;
  /** Stop it. */
  close(): Promise<void>;
}

function channel() {
  return {
    id: FAKE_CHANNEL_ID,
    name: 'general',
    description: null,
    visibility: 'public',
    archived: false,
    createdAt: AT,
    joined: true,
    unreadCount: 1,
  };
}

function entry(text = 'Welcome in.', seq = 1) {
  return {
    id: `entry-${seq}`,
    channelId: FAKE_CHANNEL_ID,
    seq,
    authorMemberId: 'member-kai',
    authorDisplayName: 'Kai',
    authorKind: 'human',
    text,
    mentions: [],
    parentEntryId: null,
    threadRootEntryId: null,
    createdAt: AT,
    cursor: `resume-${seq}`,
    attachments: [],
  };
}

const MEMBER = {
  memberId: 'member-ria',
  kind: 'human',
  displayName: 'Ria',
  handle: 'ria',
  role: 'member',
  ownerMemberId: null,
  joinedAt: AT,
};

const CAPABILITIES = { read: true, post: true, enrollAgent: true, stream: true };

/** The bytes every file download answers with. */
export const FAKE_ATTACHMENT_BYTES = 'hello from the space';

/**
 * Start a fake Community on a free loopback port.
 *
 * @returns The running fake.
 */
export async function startFakeCommunity(): Promise<FakeCommunity> {
  let origin = '';
  const open = new Set<ServerResponse>();
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    for await (const chunk of req) void chunk;
    const url = new URL(req.url ?? '/', 'http://community.test');
    const send = (value: unknown, status = 200): void => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(value));
    };
    const notFound = (): void => send({ code: 'NOT_FOUND', message: 'Not found.' }, 404);
    const tenant = /^\/api\/v1\/communities\/([0-9a-f-]{36})(\/.*)$/.exec(url.pathname);
    if (!tenant) return notFound();
    // A tenant path is the plain v1 path with the community's id after `/api/v1`.
    const [, communityId, below] = tenant as unknown as [string, string, string];
    const route = `${req.method ?? 'GET'} /api/v1${below}`;

    if (route === 'GET /api/v1/community')
      return send({ id: communityId, name: 'Space', description: null, createdAt: AT });
    if (route === 'POST /api/v1/pairings/start') {
      const pairingId = randomUUID();
      return send(
        {
          pairingId,
          approvalUrl: `${origin}/c/${communityId}/pairing?pairingId=${pairingId}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
        },
        201
      );
    }
    // The member approves in the Community's own page before the first poll.
    if (route === 'POST /api/v1/pairings/poll')
      return send({ status: 'approved', code: 'one-time-code' });
    if (route === 'POST /api/v1/pairings/exchange')
      return send({
        token: `grant-${communityId}`,
        grant: {
          id: randomUUID(),
          memberId: 'member-ria',
          installName: 'Contract desktop',
          scopes: ['read', 'post', 'enroll-agent'],
          lifecycle: 'active',
          capabilities: CAPABILITIES,
          createdAt: AT,
        },
      });

    if (req.headers.authorization !== `Bearer grant-${communityId}`)
      return send({ code: 'UNAUTHENTICATED', message: 'Sign in.' }, 401);

    const channelPath = `/api/v1/channels/${FAKE_CHANNEL_ID}`;
    switch (route) {
      case 'GET /api/v1/me/connection-access':
        return send({
          access: {
            state: 'verified',
            effective: CAPABILITIES,
            lastKnown: { lifecycle: 'active', capabilities: CAPABILITIES, verifiedAt: AT },
          },
        });
      case 'GET /api/v1/attention':
        return send({ unreadCount: 1, mentionCount: 0 });
      case 'GET /api/v1/owner-replacement':
        return send({ open: null, completed: null });
      case 'GET /api/v1/channels':
        return send({ channels: [channel()] });
      case `GET ${channelPath}`:
      case `POST ${channelPath}/join`:
      case `POST ${channelPath}/leave`:
        return send({ channel: channel() });
      case `GET ${channelPath}/entries`:
        return send({ entries: [entry()], nextCursor: null });
      case `POST ${channelPath}/entries`: {
        const posted = entry('Posted.', 2);
        return send({ entry: posted, cursor: posted.cursor }, 201);
      }
      case `GET ${channelPath}/read-cursor`:
        return send({ cursor: 'resume-1', unreadCount: 1 });
      case `PUT ${channelPath}/read-cursor`:
        return send({ cursor: 'resume-1', unreadCount: 0 });
      case `GET ${channelPath}/members`:
        return send({ members: [MEMBER] });
      case `GET ${channelPath}/redactions`:
        return send({ redactions: [], nextCursor: 'redactions-0', hasMore: false });
      case `POST ${channelPath}/attachments`:
        return send(
          {
            attachment: {
              id: 'attachment-1',
              name: 'note.txt',
              contentType: 'text/plain',
              byteSize: 5,
              checksum: 'checksum-1',
              createdAt: AT,
            },
          },
          201
        );
      case 'GET /api/v1/attachments/attachment-1':
        res.setHeader('content-type', 'application/octet-stream');
        return res.end(FAKE_ATTACHMENT_BYTES);
      case `GET ${channelPath}/events`:
        // The snapshot, then hold the stream open until the reader leaves.
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({
            type: 'snapshot',
            channel: channel(),
            entries: [entry()],
            capturedSeq: 1,
            cursor: 'resume-1',
          })}\n\n`
        );
        open.add(res);
        res.once('close', () => open.delete(res));
        return;
      case 'GET /api/v1/agents':
        return send({ agents: [] });
      case 'GET /api/v1/me/standing':
        return send({ mutedUntil: null });
      case `GET ${channelPath}/slow-mode`:
        return send({ seconds: 0 });
      case 'GET /api/v1/rules':
        return send({ text: 'Be kind.', version: 1, acceptedVersion: 0 });
      case 'POST /api/v1/rules/accept':
        return send({ text: 'Be kind.', version: 1, acceptedVersion: 1 });
      case 'PATCH /api/v1/me':
        return send({ member: { ...MEMBER, displayName: 'Ria Renamed' } });
      case 'POST /api/v1/entries/entry-1/reports':
        return send({ reported: true }, 201);
      case 'DELETE /api/v1/me/connection':
        res.statusCode = 204;
        return res.end();
      default:
        return notFound();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('The fake Community has no port');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    link: (communityId) => `${origin}/c/${communityId}`,
    close: async () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

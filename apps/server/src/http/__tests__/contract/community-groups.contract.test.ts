/**
 * Contract for the space route groups, which move to Hono together in
 * DOR-2815: a person's connections to spaces (`/api/community-connections`)
 * and the owner-qualified views of them (`/api/communities`), with the room
 * event stream. That PR must pass this file unchanged.
 *
 * Nothing here leaves the machine. Every space is a fake Community on loopback
 * (`fake-community.ts`), which the pairing service accepts over plain HTTP, so
 * the real pairing, the encrypted connection store, the native adapter and the
 * stream all run. Its official space is one of those fakes.
 *
 * Two servers:
 *
 * 1. Login off, with an official space configured, driven in order: with
 *    spaces off every route refuses but what the official space needs (the
 *    list, starting from its link, navigation, and every route about its
 *    connection); the owner, agent, remote-caller and owner-changed bars; the
 *    official space paired and read with spaces off; another space paired and
 *    every route answered with spaces on, the room stream's head and first
 *    frames included; spaces off again, which narrows everything back to the
 *    official space; and a disconnect.
 * 2. Login on: no credential is refused at the session gate before the spaces
 *    gate; an API key is not the person, so it is refused at the cookie bar;
 *    the owner's cookie is answered.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CommunityConnectionListResponseSchema,
  CommunityConnectionPollResponseSchema,
  CommunityConnectionStartResponseSchema,
  CommunityConnectionStatusResponseSchema,
  CommunityDisconnectImpactSchema,
  CommunityDisconnectResponseSchema,
} from '@dorkos/shared/community-connections';
import {
  CommunityNavigationResolveResponseSchema,
  CommunityNavigationStateSchema,
} from '@dorkos/shared/community-navigation';
import {
  RemoteCommunityAttachmentResponseSchema,
  RemoteCommunityDisplayNameResponseSchema,
  RemoteCommunityEnrollmentsResponseSchema,
  RemoteCommunityEventSchema,
  RemoteCommunityHistoryResponseSchema,
  RemoteCommunityMembersResponseSchema,
  RemoteCommunityPostResponseSchema,
  RemoteCommunityReadCursorSchema,
  RemoteCommunityRoomResponseSchema,
  RemoteCommunityRoomsResponseSchema,
  RemoteCommunityRulesResponseSchema,
  RemoteCommunityStandingSchema,
} from '@dorkos/shared/community-views';
import {
  BOOT_HOOK_TIMEOUT_MS,
  bootComposedServer,
  checkContractCase,
  type ComposedServer,
  type ContractCase,
} from './harness.js';
import {
  FAKE_ATTACHMENT_BYTES,
  FAKE_CHANNEL_ID,
  startFakeCommunity,
  type FakeCommunity,
} from './fake-community.js';

/** The official space's community, and another one on the same fake server. */
const OFFICIAL_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
/** A host name the server is told it answers to, which is not this computer. */
const PROXIED_HOST = 'dorkos.contract.example';

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = { error: 'Not found', code: 'API_NOT_FOUND' };
const SPACES_DISABLED = {
  error: 'Spaces are switched off. Turn them on in Settings → Advanced → Experiments.',
  code: 'SPACES_DISABLED',
};
const NO_CONNECTION = { error: 'Space connection not found.' };
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const AGENT_REFUSED = { error: 'An agent cannot manage space connections.' };
const REMOTE_REFUSED = { error: 'Manage space connections from this machine.' };
const OWNER_CHANGED = {
  error: 'The local owner changed. Reload to see spaces for the current account.',
  code: 'COMMUNITY_OWNER_CHANGED',
};
const PERSON_REQUIRED = {
  code: 'COMMUNITY_PERSON_REQUIRED',
  error: 'Only you can do this in a space, not an agent.',
};
const NAVIGATION_STATE = CommunityNavigationStateSchema;
const EMPTY_LIST = { connections: [] };

/** A request against a server this file booted, with the case fields that vary. */
type Ask = Omit<ContractCase, 'name'>;

/** Send one case. */
async function check(server: ComposedServer | undefined, ask: Ask): Promise<void> {
  await checkContractCase(server!.baseUrl, { name: ask.path, ...ask });
}

/** Send one setup request and return its JSON body, failing loudly on a refusal. */
async function setup(
  server: ComposedServer | undefined,
  method: string,
  url: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ json: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(new URL(url, server!.baseUrl), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} answered ${res.status}: ${text.slice(0, 300)}`);
  return { json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, headers: res.headers };
}

/** Turn the spaces experiment on or off, as Settings does. */
async function spaces(
  server: ComposedServer | undefined,
  enabled: boolean,
  headers: Record<string, string> = {}
): Promise<void> {
  await setup(server, 'PATCH', '/api/config', { spaces: { enabled } }, headers);
}

/** Pair a space from its link and poll once: the fake approves before the first poll. */
async function pair(server: ComposedServer | undefined, link: string): Promise<string> {
  const started = await setup(server, 'POST', '/api/community-connections', {
    url: link,
    installName: 'Contract desktop',
  });
  const ref = (started.json.connection as { ref: string }).ref;
  await setup(server, 'POST', `/api/community-connections/${ref}/poll`);
  return ref;
}

/** The first `count` event-stream frames a server sends, its status and headers, then leave. */
function firstFrames(
  server: ComposedServer | undefined,
  url: string,
  count: number
): Promise<{ status: number; headers: http.IncomingHttpHeaders; frames: string[] }> {
  return new Promise((resolve, reject) => {
    const req = http.get(new URL(url, server!.baseUrl), (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        text += chunk;
        const frames = text.split('\n\n').slice(0, -1);
        if (frames.length < count) return;
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          frames: frames.slice(0, count),
        });
        req.destroy();
      });
      res.on('error', () => undefined);
    });
    req.on('error', (error) => {
      if (!req.destroyed) reject(error);
    });
  });
}

/** One frame's event name and its parsed data. */
function readFrame(frame: string): { event: string; data: unknown } {
  const lines = frame.split('\n');
  const event = lines.find((line) => line.startsWith('event: '))!.slice('event: '.length);
  const data = JSON.parse(lines.find((line) => line.startsWith('data: '))!.slice('data: '.length));
  return { event, data };
}

/** A body schema that also pins which space a qualified answer is about. */
function about<T extends z.ZodType>(schema: T, ref: () => string) {
  return schema.refine((body) => (body as { community?: string }).community === ref());
}

describe('contract: the space routes, driven by hand (login off)', () => {
  let fake: FakeCommunity;
  let server: ComposedServer | undefined;
  let officialRef = '';
  let otherRef = '';

  beforeAll(async () => {
    fake = await startFakeCommunity();
    server = await bootComposedServer({
      DORKOS_OFFICIAL_SPACE_URL: fake.link(OFFICIAL_ID),
      DORKOS_TRUSTED_HOSTS: PROXIED_HOST,
    });
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
    await fake?.close();
  }, 30_000);

  it('refuses every route but the official space’s while spaces are off', async () => {
    for (const [method, path, body] of [
      ['HEAD', '/api/community-connections'],
      ['POST', '/api/community-connections'],
      ['POST', '/api/community-connections', { url: fake.link(OTHER_ID), installName: 'Mine' }],
      ['DELETE', '/api/community-connections'],
      ['POST', '/api/community-connections/navigation'],
      ['GET', '/api/community-connections/navigation/installation'],
      ['POST', '/api/community-connections/navigation/move', { ref: 'remote_x', direction: 'up' }],
      ['POST', '/api/community-connections/navigation/move'],
      ['PUT', '/api/community-connections/navigation/destination', { ref: 'remote_x' }],
      ['GET', '/api/community-connections/navigation/remote_x/destination'],
      ['GET', '/api/community-connections/navigation/remote_x/other'],
      ['GET', '/api/community-connections/remote_x'],
      ['POST', '/api/community-connections/remote_x/poll'],
      ['DELETE', '/api/community-connections/remote_x'],
      ['GET', '/api/community-connections/remote_x/nope'],
      ['GET', '/api/communities'],
      ['GET', '/api/communities/remote_x/rooms'],
      ['GET', `/api/communities/remote_x/rooms/${FAKE_CHANNEL_ID}/events`],
      ['POST', '/api/communities/remote_x/rules/accept', { version: 1 }],
      ['GET', '/api/communities/remote_x/nope'],
    ] as const) {
      await check(server, {
        method,
        path,
        body,
        expect: {
          status: 404,
          ...(method === 'HEAD' ? { body: '' } : { headers: JSON_TYPE, body: SPACES_DISABLED }),
        },
      });
    }
  });

  it('lets through what the official space needs while spaces are off', async () => {
    await check(server, {
      path: '/api/community-connections',
      expect: { status: 200, headers: JSON_TYPE, body: EMPTY_LIST },
    });
    await check(server, {
      path: '/api/community-connections/',
      expect: { status: 200, body: EMPTY_LIST },
    });
    // Starting from the official link passes the gate, so the route's own check answers.
    await check(server, {
      method: 'POST',
      path: '/api/community-connections',
      body: { url: fake.link(OFFICIAL_ID) },
      expect: { status: 400, body: { error: 'Enter a valid space address and install name.' } },
    });
    await check(server, {
      path: '/api/community-connections/navigation',
      expect: { status: 200, headers: JSON_TYPE, schema: NAVIGATION_STATE },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/community-connections/navigation/installation',
      body: { destination: { path: '/tasks', search: { view: 'board' } } },
      expect: { status: 200, schema: NAVIGATION_STATE },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/community-connections/navigation/installation',
      body: { destination: 'nowhere' },
      expect: {
        status: 400,
        body: { error: 'Choose a valid local installation destination.' },
      },
    });
  });

  it('refuses a caller that is not this install’s owner, at this machine', async () => {
    await check(server, {
      path: '/api/community-connections',
      headers: AGENT,
      expect: { status: 403, headers: JSON_TYPE, body: AGENT_REFUSED },
    });
    await check(server, {
      path: '/api/community-connections/navigation',
      headers: AGENT,
      expect: { status: 403, body: AGENT_REFUSED },
    });
    await check(server, {
      path: '/api/community-connections',
      headers: { host: PROXIED_HOST },
      expect: { status: 403, body: REMOTE_REFUSED },
    });
    await check(server, {
      path: '/api/community-connections',
      headers: { 'x-dorkos-community-owner': 'someone-else' },
      expect: { status: 409, body: OWNER_CHANGED },
    });
    await check(server, {
      path: '/api/community-connections',
      headers: { host: 'evil.example.com' },
      expect: { status: 403, headers: JSON_TYPE },
    });
  });

  it('pairs the official space with spaces off, and answers about it alone', async () => {
    await check(server, {
      method: 'POST',
      path: '/api/community-connections',
      body: { url: fake.link(OFFICIAL_ID), installName: 'Contract desktop' },
      expect: { status: 201, headers: JSON_TYPE, schema: CommunityConnectionStartResponseSchema },
    });
    const listed = await setup(server, 'GET', '/api/community-connections');
    const pending = (listed.json.connections as Array<{ ref: string; status: string }>)[0]!;
    expect(pending.status).toBe('pending');
    officialRef = pending.ref;
    await check(server, {
      method: 'POST',
      path: `/api/community-connections/${officialRef}/poll`,
      expect: {
        status: 200,
        schema: CommunityConnectionPollResponseSchema.refine((body) => body.status === 'connected'),
      },
    });
    await check(server, {
      path: '/api/community-connections',
      expect: {
        status: 200,
        schema: CommunityConnectionListResponseSchema.refine(
          (body) =>
            body.connections.length === 1 &&
            body.connections[0]!.ref === officialRef &&
            body.connections[0]!.official === true &&
            body.connections[0]!.status === 'connected'
        ),
      },
    });
    await check(server, {
      path: `/api/community-connections/${officialRef}`,
      expect: { status: 200, schema: CommunityConnectionStatusResponseSchema },
    });
    await check(server, {
      path: `/api/communities/${officialRef}/rooms`,
      expect: {
        status: 200,
        headers: JSON_TYPE,
        schema: about(RemoteCommunityRoomsResponseSchema, () => officialRef),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/community-connections/navigation/move',
      body: { ref: officialRef, direction: 'up' },
      expect: { status: 200, schema: NAVIGATION_STATE },
    });
    await check(server, {
      path: `/api/community-connections/navigation/${officialRef}/destination`,
      expect: { status: 200, schema: CommunityNavigationResolveResponseSchema },
    });
  });

  it('answers every connection route with spaces on', async () => {
    await spaces(server, true);
    otherRef = await pair(server, fake.link(OTHER_ID));
    const base = `/api/community-connections/${otherRef}`;
    await check(server, {
      path: '/api/community-connections',
      expect: {
        status: 200,
        schema: CommunityConnectionListResponseSchema.refine(
          (body) => body.connections.length === 2
        ),
      },
    });
    await check(server, {
      method: 'POST',
      path: '/api/community-connections',
      body: { url: 'https://', installName: 'Mine' },
      expect: { status: 400, body: { error: 'Enter a valid space address and install name.' } },
    });
    await check(server, {
      method: 'POST',
      path: '/api/community-connections',
      body: { url: 'http://example.com/c/x', installName: 'Mine' },
      expect: { status: 400, body: { error: 'Enter an accessible HTTPS space address.' } },
    });
    await check(server, {
      method: 'POST',
      path: '/api/community-connections',
      headers: { 'content-type': 'application/json' },
      body: '{"url":',
      expect: { status: 500, schema: z.object({ code: z.literal('INTERNAL_ERROR') }).loose() },
    });
    await check(server, {
      path: base,
      expect: { status: 200, schema: CommunityConnectionStatusResponseSchema },
    });
    await check(server, {
      path: `${base}/`,
      expect: { status: 200, schema: CommunityConnectionStatusResponseSchema },
    });
    await check(server, {
      method: 'POST',
      path: `${base}/poll`,
      expect: { status: 200, schema: CommunityConnectionPollResponseSchema },
    });
    await check(server, {
      path: `${base}/disconnect-impact`,
      expect: { status: 200, headers: JSON_TYPE, schema: CommunityDisconnectImpactSchema },
    });
    await check(server, {
      path: `${base}/wake-agents-from`,
      expect: { status: 200, body: { wakeAgentsFrom: 'members' } },
    });
    await check(server, {
      method: 'PUT',
      path: `${base}/wake-agents-from`,
      body: { wakeAgentsFrom: 'me' },
      expect: { status: 200, body: { wakeAgentsFrom: 'me' } },
    });
    await check(server, {
      method: 'PUT',
      path: `${base}/wake-agents-from`,
      body: { wakeAgentsFrom: 'everyone' },
      expect: {
        status: 400,
        body: { error: 'Choose who can wake your agents: me or members.' },
      },
    });
    await check(server, {
      path: `${base}/answer-in`,
      expect: { status: 200, body: { answerIn: [] } },
    });
    await check(server, {
      method: 'PUT',
      path: `${base}/answer-in`,
      body: { answerIn: ['#Help', 'help', 'welcome'] },
      expect: { status: 200, body: { answerIn: ['help', 'welcome'] } },
    });
    await check(server, {
      method: 'PUT',
      path: `${base}/answer-in`,
      body: { answerIn: ['not a name'] },
      expect: {
        status: 400,
        body: { error: 'List up to 20 channel names, like help or welcome.' },
      },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/community-connections/navigation/destination',
      body: { ref: otherRef, roomId: FAKE_CHANNEL_ID, threadId: null, scrollAnchorEntryId: null },
      expect: { status: 200, schema: NAVIGATION_STATE },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/community-connections/navigation/destination',
      body: { ref: otherRef },
      expect: { status: 400, body: { error: 'Choose a valid space to open.' } },
    });
    await check(server, {
      method: 'POST',
      path: '/api/community-connections/navigation/move',
      body: { ref: otherRef, direction: 'sideways' },
      expect: { status: 400, body: { error: 'Choose a connected space and move direction.' } },
    });
    await check(server, {
      path: `/api/community-connections/navigation/${otherRef}/destination`,
      expect: {
        status: 200,
        schema: CommunityNavigationResolveResponseSchema.refine(
          (body) => body.destination?.roomId === FAKE_CHANNEL_ID
        ),
      },
    });
    // A ref that is not path-safe, and one that names no connection.
    for (const ref of ['bad.ref', 'remote_unknown']) {
      for (const [method, suffix] of [
        ['GET', ''],
        ['POST', '/poll'],
        ['POST', '/cancel'],
        ['GET', '/disconnect-impact'],
        ['GET', '/wake-agents-from'],
        ['GET', '/answer-in'],
        ['DELETE', ''],
      ] as const) {
        await check(server, {
          method,
          path: `/api/community-connections/${ref}${suffix}`,
          expect: { status: 404, body: NO_CONNECTION },
        });
      }
    }
    await check(server, {
      path: '/api/community-connections/navigation/bad.ref/destination',
      expect: { status: 404, body: NO_CONNECTION },
    });
    await check(server, {
      path: `${base}/nope`,
      expect: { status: 404, body: NOT_FOUND },
    });
    await check(server, {
      method: 'PATCH',
      path: '/api/community-connections',
      expect: { status: 404, body: NOT_FOUND },
    });
  });

  it('answers every remote community route with spaces on', async () => {
    const base = `/api/communities/${otherRef}`;
    const room = `${base}/rooms/${FAKE_CHANNEL_ID}`;
    const other = () => otherRef;
    await check(server, {
      path: `${base}/rooms`,
      expect: {
        status: 200,
        headers: JSON_TYPE,
        schema: about(RemoteCommunityRoomsResponseSchema, other),
      },
    });
    await check(server, {
      path: room,
      expect: { status: 200, schema: RemoteCommunityRoomResponseSchema },
    });
    await check(server, {
      path: `${base}/rooms/not-a-room`,
      expect: { status: 404, body: { error: 'Room not found.' } },
    });
    await check(server, {
      path: `${room}/entries`,
      expect: { status: 200, schema: about(RemoteCommunityHistoryResponseSchema, other) },
    });
    await check(server, {
      path: `${room}/entries?limit=5&cursor=resume-1`,
      expect: { status: 200, schema: about(RemoteCommunityHistoryResponseSchema, other) },
    });
    for (const limit of ['0', '101', 'many']) {
      await check(server, {
        path: `${room}/entries?limit=${limit}`,
        expect: { status: 400, body: { error: 'Use a history limit from 1 through 100.' } },
      });
    }
    await check(server, {
      path: `${room}/read-cursor`,
      expect: { status: 200, body: { cursor: 'resume-1', unreadCount: 1 } },
    });
    await check(server, {
      method: 'PUT',
      path: `${room}/read-cursor`,
      body: { cursor: 'resume-1' },
      expect: { status: 200, schema: RemoteCommunityReadCursorSchema },
    });
    await check(server, {
      method: 'PUT',
      path: `${room}/read-cursor`,
      body: {},
      expect: { status: 400, body: { error: 'A cursor is required.' } },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/membership`,
      expect: { status: 200, schema: RemoteCommunityRoomResponseSchema },
    });
    await check(server, {
      method: 'DELETE',
      path: `${room}/membership`,
      expect: { status: 204, body: '' },
    });
    await check(server, {
      path: `${room}/members`,
      expect: { status: 200, schema: about(RemoteCommunityMembersResponseSchema, other) },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/entries`,
      body: { text: 'Posted.', idempotencyKey: randomUUID() },
      expect: { status: 201, headers: JSON_TYPE, schema: RemoteCommunityPostResponseSchema },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/entries`,
      body: { text: '' },
      expect: { status: 400, body: { error: 'Enter a message with a valid retry key.' } },
    });
    const file = {
      'content-type': 'application/octet-stream',
      'x-file-name': 'note.txt',
      'x-file-content-type': 'text/plain',
      'x-file-size': '5',
      'idempotency-key': 'upload-1',
    };
    await check(server, {
      method: 'POST',
      path: `${room}/attachments`,
      headers: file,
      body: 'hello',
      expect: { status: 201, schema: RemoteCommunityAttachmentResponseSchema },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/attachments`,
      headers: { ...file, 'content-type': 'text/plain' },
      body: 'hello',
      expect: { status: 400, body: { error: 'Provide valid file metadata and a retry key.' } },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/attachments`,
      headers: { ...file, 'x-file-name': '%E0%A4%A' },
      body: 'hello',
      expect: { status: 400, body: { error: 'Provide valid file metadata and a retry key.' } },
    });
    await check(server, {
      path: `${room}/attachments/attachment-1`,
      expect: {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': 'attachment',
          'x-content-type-options': 'nosniff',
          'cache-control': 'private, no-store',
        },
        body: FAKE_ATTACHMENT_BYTES,
      },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/deliveries/unknown-key/retry`,
      expect: { status: 404, body: { error: 'Delivery not found.' } },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/deliveries/${'k'.repeat(129)}/retry`,
      expect: { status: 400, body: { error: 'Use valid space, room, and delivery identifiers.' } },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/halt`,
      expect: { status: 200, schema: z.object({ stopped: z.unknown() }).strict() },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/agents/agent-x/halt`,
      expect: { status: 200, schema: z.object({ stopped: z.unknown() }).strict() },
    });
    await check(server, {
      path: `${base}/agents`,
      expect: {
        status: 200,
        schema: RemoteCommunityEnrollmentsResponseSchema.refine(
          (body) => body.community === otherRef && body.agents.length === 0
        ),
      },
    });
    await check(server, {
      method: 'POST',
      path: `${base}/agents/agent-x/enroll`,
      expect: { status: 404, body: { error: 'Local agent not found.' } },
    });
    await check(server, {
      method: 'POST',
      path: `${base}/agents/agent-x/enroll`,
      body: { handle: 'Not A Handle' },
      expect: { status: 400, body: { error: 'Use a valid space handle.' } },
    });
    await check(server, {
      method: 'DELETE',
      path: `${base}/agents/agent-x`,
      expect: { status: 404, body: { error: 'Agent enrollment not found.' } },
    });
    for (const method of ['POST', 'DELETE']) {
      await check(server, {
        method,
        path: `${room}/agents/agent-x/membership`,
        expect: { status: 404, body: { error: 'Active agent enrollment not found.' } },
      });
    }
    // The person's own side of the space's moderation.
    await check(server, {
      path: `${room}/standing`,
      expect: { status: 200, schema: about(RemoteCommunityStandingSchema, other) },
    });
    await check(server, {
      method: 'POST',
      path: `${base}/rules/accept`,
      body: { version: 1 },
      expect: { status: 200, schema: about(RemoteCommunityRulesResponseSchema, other) },
    });
    await check(server, {
      method: 'POST',
      path: `${base}/rules/accept`,
      body: { version: 0 },
      expect: { status: 400, body: { error: 'Read the rules first.' } },
    });
    await check(server, {
      method: 'PUT',
      path: `${base}/me/display-name`,
      body: { displayName: 'Ria Renamed' },
      expect: {
        status: 200,
        schema: about(RemoteCommunityDisplayNameResponseSchema, other),
      },
    });
    await check(server, {
      method: 'PUT',
      path: `${base}/me/display-name`,
      body: { displayName: '' },
      expect: { status: 400, body: { error: 'Use letters, numbers and spaces, up to 128.' } },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/entries/entry-1/reports`,
      body: { reason: 'spam' },
      expect: { status: 204, body: '' },
    });
    await check(server, {
      method: 'POST',
      path: `${room}/entries/entry-1/reports`,
      body: { reason: 'boredom' },
      expect: {
        status: 400,
        body: { error: 'Pick a reason. Notes are up to 1,000 characters.' },
      },
    });
    // An approval token is not the person: the conduct routes refuse it, the others do not.
    await check(server, {
      path: `${room}/standing`,
      headers: { 'x-dorkos-approval': 'a-token' },
      expect: { status: 403, body: PERSON_REQUIRED },
    });
    await check(server, {
      path: `${base}/rooms`,
      headers: { 'x-dorkos-approval': 'a-token' },
      expect: { status: 200, schema: RemoteCommunityRoomsResponseSchema },
    });
    // The owner bars, before anything is read.
    await check(server, {
      path: `${base}/rooms`,
      headers: AGENT,
      expect: { status: 403, body: AGENT_REFUSED },
    });
    await check(server, {
      method: 'POST',
      path: `${base}/rules/accept`,
      headers: AGENT,
      body: { version: 1 },
      expect: { status: 403, body: AGENT_REFUSED },
    });
    await check(server, {
      path: `${base}/rooms`,
      headers: { host: PROXIED_HOST },
      expect: { status: 403, body: REMOTE_REFUSED },
    });
    await check(server, {
      path: `${base}/rooms`,
      headers: { 'x-dorkos-community-owner': 'someone-else' },
      expect: { status: 409, body: OWNER_CHANGED },
    });
    // A ref with no connection.
    for (const path of [
      '/api/communities/remote_unknown/rooms',
      `/api/communities/remote_unknown/rooms/${FAKE_CHANNEL_ID}/events`,
      '/api/communities/remote_unknown/agents',
    ]) {
      await check(server, { path, expect: { status: 404, body: NO_CONNECTION } });
    }
    await check(server, {
      path: `${base}/nope`,
      expect: { status: 404, body: NOT_FOUND },
    });
  });

  it('streams a room: the head, the snapshot, then the deliveries', async () => {
    const { status, headers, frames } = await firstFrames(
      server,
      `/api/communities/${otherRef}/rooms/${FAKE_CHANNEL_ID}/events`,
      2
    );
    expect(status).toBe(200);
    expect(headers['content-type']).toBe('text/event-stream');
    expect(headers['cache-control']).toBe('no-cache, no-transform');
    expect(headers['x-content-type-options']).toBe('nosniff');
    const [snapshot, deliveries] = frames.map(readFrame);
    expect(snapshot!.event).toBe('snapshot');
    expect(RemoteCommunityEventSchema.parse(snapshot!.data)).toMatchObject({
      type: 'snapshot',
      room: { community: otherRef, roomId: FAKE_CHANNEL_ID },
      cursor: 'resume-1',
      lastRemoteSeq: 1,
      stale: false,
      redactionCursor: 'redactions-0',
    });
    expect(deliveries!.event).toBe('deliveries');
    expect(RemoteCommunityEventSchema.parse(deliveries!.data)).toMatchObject({
      type: 'deliveries',
    });
    // The server is still answering after the client left.
    await check(server, {
      path: `/api/communities/${otherRef}/rooms`,
      expect: { status: 200, schema: RemoteCommunityRoomsResponseSchema },
    });
  });

  it('narrows back to the official space when spaces go off again', async () => {
    await spaces(server, false);
    await check(server, {
      path: '/api/community-connections',
      expect: {
        status: 200,
        schema: CommunityConnectionListResponseSchema.refine(
          (body) => body.connections.map((connection) => connection.ref).join() === officialRef
        ),
      },
    });
    await check(server, {
      path: '/api/community-connections/navigation',
      expect: {
        status: 200,
        schema: NAVIGATION_STATE.refine(
          (body) =>
            !body.order.includes(otherRef as never) &&
            body.destinations.every((item) => item.ref === officialRef)
        ),
      },
    });
    for (const [method, path, body] of [
      ['GET', `/api/community-connections/${otherRef}`],
      ['GET', `/api/community-connections/${otherRef}/wake-agents-from`],
      ['GET', `/api/community-connections/navigation/${otherRef}/destination`],
      ['POST', '/api/community-connections/navigation/move', { ref: otherRef, direction: 'up' }],
      ['GET', `/api/communities/${otherRef}/rooms`],
      ['GET', `/api/communities/${otherRef}/rooms/${FAKE_CHANNEL_ID}/events`],
    ] as const) {
      await check(server, { method, path, body, expect: { status: 404, body: SPACES_DISABLED } });
    }
    await check(server, {
      path: `/api/community-connections/${officialRef}/wake-agents-from`,
      expect: { status: 200, body: { wakeAgentsFrom: 'me' } },
    });
    await check(server, {
      path: `/api/communities/${officialRef}/rooms/${FAKE_CHANNEL_ID}`,
      expect: { status: 200, schema: RemoteCommunityRoomResponseSchema },
    });
    await check(server, {
      method: 'PUT',
      path: '/api/community-connections/navigation/destination',
      body: {
        ref: officialRef,
        roomId: FAKE_CHANNEL_ID,
        threadId: null,
        scrollAnchorEntryId: null,
      },
      expect: { status: 200, schema: NAVIGATION_STATE },
    });
  });

  it('disconnects a space with spaces on, and forgets it', async () => {
    await spaces(server, true);
    await check(server, {
      method: 'DELETE',
      path: `/api/community-connections/${otherRef}`,
      expect: {
        status: 200,
        headers: JSON_TYPE,
        schema: CommunityDisconnectResponseSchema.refine((body) => body.remoteRevoked === true),
      },
    });
    await check(server, {
      path: `/api/community-connections/${otherRef}`,
      expect: { status: 404, body: NO_CONNECTION },
    });
    await check(server, {
      path: `/api/communities/${otherRef}/rooms`,
      expect: { status: 404, body: NO_CONNECTION },
    });
  });
});

describe('contract: the space routes with login on', () => {
  let server: ComposedServer | undefined;
  let cookie: Record<string, string>;
  let apiKey: Record<string, string>;
  const OWNER = {
    email: `owner-${randomUUID().slice(0, 8)}@dork.test`,
    password: 'a-long-password-1',
  };
  const AUTH_REQUIRED = z.object({ code: z.literal('AUTH_REQUIRED') }).loose();
  const COOKIE_REQUIRED = {
    error: 'Only a person signed in to DorkOS can change community connections',
    code: 'operator_cookie_required',
  };

  beforeAll(async () => {
    server = await bootComposedServer();
    const origin = { origin: server.baseUrl };
    await setup(server, 'POST', '/api/auth/sign-up/email', { ...OWNER, name: 'Owner' }, origin);
    await setup(server, 'PATCH', '/api/config', { auth: { enabled: true } });
    const signedIn = await setup(server, 'POST', '/api/auth/sign-in/email', OWNER, origin);
    cookie = {
      cookie: signedIn.headers
        .getSetCookie()
        .map((value) => value.split(';')[0]!)
        .join('; '),
    };
    const created = await setup(
      server,
      'POST',
      '/api/auth/api-key/create',
      { name: 'c' },
      { ...cookie, ...origin }
    );
    apiKey = { authorization: `Bearer ${created.json.key as string}` };
  }, BOOT_HOOK_TIMEOUT_MS);
  afterAll(async () => {
    await server?.close();
  }, 30_000);

  const ROUTES = [
    ['GET', '/api/community-connections'],
    ['GET', '/api/community-connections/navigation'],
    ['GET', '/api/community-connections/remote_x'],
    ['GET', '/api/communities/remote_x/rooms'],
    ['GET', `/api/communities/remote_x/rooms/${FAKE_CHANNEL_ID}/events`],
  ] as const;

  it('refuses no credential at the session gate, ahead of the spaces gate', async () => {
    for (const [method, path] of ROUTES) {
      await check(server, { method, path, expect: { status: 401, schema: AUTH_REQUIRED } });
    }
    await check(server, {
      path: '/api/community-connections',
      headers: cookie,
      expect: { status: 404, body: SPACES_DISABLED },
    });
  });

  it('refuses an API key at the cookie bar, and answers the owner’s cookie', async () => {
    await spaces(server, true, { ...cookie, origin: server!.baseUrl });
    for (const [method, path] of ROUTES) {
      await check(server, {
        method,
        path,
        headers: apiKey,
        expect: { status: 403, headers: JSON_TYPE, body: COOKIE_REQUIRED },
      });
    }
    await check(server, {
      path: '/api/community-connections',
      headers: { ...apiKey, ...AGENT },
      expect: { status: 403, body: COOKIE_REQUIRED },
    });
    await check(server, {
      path: '/api/community-connections',
      headers: cookie,
      expect: { status: 200, body: EMPTY_LIST },
    });
    await check(server, {
      path: '/api/community-connections/navigation',
      headers: cookie,
      expect: { status: 200, schema: NAVIGATION_STATE },
    });
    await check(server, {
      path: '/api/communities/remote_x/rooms',
      headers: cookie,
      expect: { status: 404, body: NO_CONNECTION },
    });
    await check(server, {
      path: '/api/community-connections',
      headers: { ...cookie, ...AGENT },
      expect: { status: 403, body: AGENT_REFUSED },
    });
  });
});

/**
 * Contract for the API a paired DorkOS app uses on a space (specs/server-merge step 1,
 * DOR-2875): the calls `apps/server/src/services/communities/remote/` makes, at the
 * community-scoped paths it sends them to, with the connection bearer a pairing hands out. Each
 * answer is held to the shared wire schema the app parses it with, so an installed app keeps
 * working against a space that moves. A deliberate change updates this file in the same PR and
 * says so in the PR description.
 */
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { CommunityAgentEnrollmentSecretResponseSchema } from '@dorkos/shared/community-private-wire';
import {
  CommunityWireAgentAvailabilityReportResponseSchema,
  CommunityWireAgentListResponseSchema,
  CommunityWireAttentionResponseSchema,
  CommunityWireChannelListResponseSchema,
  CommunityWireChannelResponseSchema,
  CommunityWireChannelSlowModeSchema,
  CommunityWireCommunitySchema,
  CommunityWireConnectionAccessResponseSchema,
  CommunityWireEntryPageSchema,
  CommunityWireEntryPostResponseSchema,
  CommunityWireHostAccessResponseSchema,
  CommunityWireMemberListResponseSchema,
  CommunityWireOwnerReplacementNoticeResponseSchema,
  CommunityWirePairingStartResponseSchema,
  CommunityWireReadCursorResponseSchema,
  CommunityWireRedactionPageSchema,
  CommunityWireRulesSchema,
  CommunityWireSpaceFeaturesResponseSchema,
  CommunityWireStandingSchema,
  CommunityWireThreadSummaryListSchema,
} from '@dorkos/shared/community-wire';
import { pairInstall } from '../tenancy-test-harness.js';
import { contractSuite, type ContractCase } from './contract.js';
import { startSpace, type SpaceFixture } from './space-fixture.js';

type Case = ContractCase<SpaceFixture>;

const base = (f: SpaceFixture) => `/api/v1/communities/${f.communityId}`;
const channel = (f: SpaceFixture) => `${base(f)}/channels/${f.channelId}`;
const asApp = (f: SpaceFixture) => ({ authorization: `Bearer ${f.kept.bearer}` });

/** The verifier a second install holds while it pairs; the space sees only its hash. */
const VERIFIER = randomBytes(32).toString('base64url');
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

const UNAUTHENTICATED = { status: 401, match: { code: 'UNAUTHENTICATED' } };

/**
 * The channel member list as every app released before agent availability (DOR-2877) parses it:
 * strict, so one field more fails the whole list. Frozen here, not imported, because the shared
 * schema has since grown optional fields that this copy must keep refusing.
 */
const ReleasedMemberListSchema = z.strictObject({
  members: z.array(
    z.strictObject({
      memberId: z.string().min(1),
      kind: z.enum(['human', 'agent']),
      displayName: z.string().min(1),
      handle: z.string(),
      role: z.enum(['owner', 'admin', 'member']).nullable(),
      ownerMemberId: z.string().min(1).nullable(),
      ownerDisplayName: z.string().min(1).nullable().optional(),
      joinedAt: z.iso.datetime(),
    })
  ),
});

/** Reads the app makes with its bearer, and the schema it parses each answer with. */
const reads: [string, (f: SpaceFixture) => string, Case['expect']['schema']][] = [
  ['the channel list', (f) => `${base(f)}/channels`, CommunityWireChannelListResponseSchema],
  ['one channel', channel, CommunityWireChannelResponseSchema],
  ['a page of entries', (f) => `${channel(f)}/entries?limit=50`, CommunityWireEntryPageSchema],
  [
    'thread summaries',
    (f) => `${channel(f)}/threads?roots=${f.kept.entryId}`,
    CommunityWireThreadSummaryListSchema,
  ],
  [
    'the redaction feed',
    (f) => `${channel(f)}/redactions?from=end`,
    CommunityWireRedactionPageSchema,
  ],
  ['channel members', (f) => `${channel(f)}/members`, CommunityWireMemberListResponseSchema],
  // An app from before availability asks for nothing more and must get nothing more.
  [
    'channel members, as a released app parses them',
    (f) => `${channel(f)}/members`,
    ReleasedMemberListSchema,
  ],
  [
    'channel members with availability',
    (f) => `${channel(f)}/members?include=availability`,
    CommunityWireMemberListResponseSchema,
  ],
  ['the space features', (f) => `${base(f)}/features`, CommunityWireSpaceFeaturesResponseSchema],
  ['the read position', (f) => `${channel(f)}/read-cursor`, CommunityWireReadCursorResponseSchema],
  ['slow mode', (f) => `${channel(f)}/slow-mode`, CommunityWireChannelSlowModeSchema],
  ["the owner's agents", (f) => `${base(f)}/agents`, CommunityWireAgentListResponseSchema],
  ['attention', (f) => `${base(f)}/attention`, CommunityWireAttentionResponseSchema],
  ['standing', (f) => `${base(f)}/me/standing`, CommunityWireStandingSchema],
  ['the rules', (f) => `${base(f)}/rules`, CommunityWireRulesSchema],
  [
    'the owner-replacement notice',
    (f) => `${base(f)}/owner-replacement`,
    CommunityWireOwnerReplacementNoticeResponseSchema,
  ],
  [
    'connection access',
    (f) => `${base(f)}/me/connection-access`,
    CommunityWireConnectionAccessResponseSchema,
  ],
  ['host access', (f) => `${base(f)}/me/host-access`, CommunityWireHostAccessResponseSchema],
];

const pairing: Case[] = [
  {
    name: 'GET /community answers who the space is, to anyone',
    path: (f) => `${base(f)}/community`,
    expect: { status: 200, schema: CommunityWireCommunitySchema },
  },
  {
    name: 'GET /community-names/:name of a name nobody holds is not found',
    path: '/api/v1/community-names/nobody-has-this',
    expect: { status: 404, match: { code: 'NOT_FOUND' } },
  },
  {
    name: 'POST /pairings/start opens a pairing for a browser to approve',
    method: 'POST',
    path: (f) => `${base(f)}/pairings/start`,
    body: { installName: 'Contract install', challenge: CHALLENGE, scopes: ['read', 'post'] },
    expect: { status: 201, schema: CommunityWirePairingStartResponseSchema },
    keep: (f, body) => {
      f.kept.pairingId = (body as { pairingId: string }).pairingId;
    },
  },
  {
    name: 'POST /pairings/poll before approval says it is still waiting',
    method: 'POST',
    path: (f) => `${base(f)}/pairings/poll`,
    body: (f: SpaceFixture) => ({ pairingId: f.kept.pairingId, verifier: VERIFIER }),
    expect: { status: 200, match: { status: 'pending' } },
  },
  {
    name: 'POST /pairings/poll with the wrong verifier is refused',
    method: 'POST',
    path: (f) => `${base(f)}/pairings/poll`,
    body: (f: SpaceFixture) => ({
      pairingId: f.kept.pairingId,
      verifier: randomBytes(32).toString('base64url'),
    }),
    expect: { status: 403, match: { code: 'FORBIDDEN' } },
  },
  {
    name: 'POST /pairings/cancel ends the waiting pairing, answering nothing',
    method: 'POST',
    path: (f) => `${base(f)}/pairings/cancel`,
    body: (f: SpaceFixture) => ({ pairingId: f.kept.pairingId, verifier: VERIFIER }),
    expect: { status: 204, text: /^$/u },
  },
];

const refusals: Case[] = [
  {
    name: 'a read without the bearer is refused',
    path: (f) => `${base(f)}/channels`,
    expect: UNAUTHENTICATED,
  },
  {
    name: 'a read with a bearer nobody issued is refused',
    path: (f) => `${base(f)}/channels`,
    headers: { authorization: 'Bearer not-a-connection' },
    expect: UNAUTHENTICATED,
  },
  {
    name: 'a community that does not exist is not found',
    path: '/api/v1/communities/00000000-0000-4000-8000-000000000000/channels',
    headers: asApp,
    expect: { status: 404, match: { code: 'NOT_FOUND' } },
  },
];

const posting: Case[] = [
  {
    name: 'POST /channels/:id/entries posts as the paired member',
    method: 'POST',
    path: (f) => `${channel(f)}/entries`,
    headers: asApp,
    body: { text: 'Hello from the app', idempotencyKey: 'contract-post-1' },
    expect: { status: 201, schema: CommunityWireEntryPostResponseSchema },
    keep: (f, body) => {
      const posted = body as { entry: { id: string }; cursor: string };
      f.kept.entryId = posted.entry.id;
      f.kept.cursor = posted.cursor;
    },
  },
  {
    name: 'POST /channels/:id/entries with the same idempotency key answers the same entry',
    method: 'POST',
    path: (f) => `${channel(f)}/entries`,
    headers: asApp,
    body: { text: 'Hello from the app', idempotencyKey: 'contract-post-1' },
    expect: { status: 200, schema: CommunityWireEntryPostResponseSchema },
  },
  {
    name: 'PUT /channels/:id/read-cursor moves the read position',
    method: 'PUT',
    path: (f) => `${channel(f)}/read-cursor`,
    headers: asApp,
    body: (f: SpaceFixture) => ({ cursor: f.kept.cursor }),
    expect: {
      status: 200,
      schema: CommunityWireReadCursorResponseSchema,
      match: { unreadCount: 0 },
    },
  },
];

/** Agent availability (DOR-2877): the capability flag, and the report a paired app sends. */
const availability: Case[] = [
  {
    name: 'GET /features says the space understands reports, DMs and administration, to anyone',
    path: (f) => `${base(f)}/features`,
    expect: {
      status: 200,
      body: { features: { agentAvailability: true, agentDms: true, administer: true } },
    },
  },
  {
    name: 'POST /agents enrolls an agent to report for',
    method: 'POST',
    path: (f) => `${base(f)}/agents`,
    headers: asApp,
    body: { localAgentId: 'contract-agent', displayName: 'Contract agent' },
    expect: { status: 201, schema: CommunityAgentEnrollmentSecretResponseSchema },
    keep: (f, body) => {
      f.kept.agentId = (body as { agent: { memberId: string } }).agent.memberId;
    },
  },
  {
    name: 'POST /agents/availability records the agents this installation enrolled',
    method: 'POST',
    path: (f) => `${base(f)}/agents/availability`,
    headers: asApp,
    body: (f: SpaceFixture) => ({
      agents: [
        { agentId: f.kept.agentId, runsOn: 'computer' },
        { agentId: '00000000-0000-4000-8000-000000000000', runsOn: 'computer' },
      ],
    }),
    expect: {
      status: 200,
      headers: { 'content-type': /^application\/json\b/u },
      schema: CommunityWireAgentAvailabilityReportResponseSchema,
      match: { refused: ['00000000-0000-4000-8000-000000000000'] },
    },
  },
  {
    name: 'POST /channels/:id/agents places the reported agent in the channel',
    method: 'POST',
    path: (f) => `${channel(f)}/agents`,
    headers: asApp,
    body: (f: SpaceFixture) => ({ agentId: f.kept.agentId }),
    expect: { status: 200, body: { joined: true } },
  },
  {
    name: 'GET /channels/:id/members?include=availability shows the agent as available',
    path: (f) => `${channel(f)}/members?include=availability`,
    headers: asApp,
    expect: {
      status: 200,
      schema: CommunityWireMemberListResponseSchema,
      match: {
        members: [
          { kind: 'human' },
          { kind: 'agent', runsOn: 'computer', availability: 'available' },
        ],
      },
    },
  },
  {
    name: 'GET /channels/:id/members without asking still parses as a released app reads it',
    path: (f) => `${channel(f)}/members`,
    headers: asApp,
    expect: { status: 200, schema: ReleasedMemberListSchema },
  },
  {
    name: 'POST /agents/availability with anything but availability is refused',
    method: 'POST',
    path: (f) => `${base(f)}/agents/availability`,
    headers: asApp,
    body: (f: SpaceFixture) => ({
      agents: [{ agentId: f.kept.agentId, runsOn: 'computer', displayName: 'Leak' }],
    }),
    expect: { status: 400 },
  },
  {
    name: 'POST /agents/availability without the bearer is refused',
    method: 'POST',
    path: (f) => `${base(f)}/agents/availability`,
    body: { agents: [] },
    expect: UNAUTHENTICATED,
  },
];

const streams: Case[] = [
  {
    name: 'GET /channels/:id/events opens a live stream',
    path: (f) => `${channel(f)}/events`,
    headers: asApp,
    expect: { status: 200, headers: { 'content-type': /^text\/event-stream\b/u } },
  },
];

const leaving: Case[] = [
  {
    name: 'DELETE /me/connection ends this connection, answering nothing',
    method: 'DELETE',
    path: (f) => `${base(f)}/me/connection`,
    headers: asApp,
    expect: { status: 204, text: /^$/u },
  },
  {
    name: 'the ended connection is refused',
    path: (f) => `${base(f)}/channels`,
    headers: asApp,
    expect: UNAUTHENTICATED,
  },
];

contractSuite(
  'the API a paired DorkOS app uses',
  async () => {
    const space = await startSpace('promises_app');
    const { h, communityId, operatorCookie } = space.fixture;
    space.fixture.kept.bearer = await pairInstall(h, communityId, operatorCookie);
    return space;
  },
  [
    ...pairing,
    ...refusals,
    ...posting,
    ...reads.map(([what, path, schema]): Case => ({
      name: `GET ${what}`,
      path,
      headers: asApp,
      expect: { status: 200, headers: { 'content-type': /^application\/json\b/u }, schema },
    })),
    ...availability,
    ...streams,
    ...leaving,
  ]
);

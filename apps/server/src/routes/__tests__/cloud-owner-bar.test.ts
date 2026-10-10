/**
 * Every DorkOS account write is for the owner of this DorkOS and
 * nobody else (DOR-2652); every read stays open.
 *
 * Driven route by route over the real cloud router, with the services each
 * write would reach replaced by spies. A refused caller must get the plain
 * sentence AND leave its write's spy untouched; an allowed one must reach it.
 * The table is the whole surface, so a write added to `routes/cloud.ts` or
 * `routes/cloud-communities.ts` without the bar has to be added here to be
 * covered, and the reads below pin that the bar did not spread to them.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import express from 'express';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';

const manager = vi.hoisted(() => ({
  startLink: vi.fn(async () => ({})),
  getStatus: vi.fn(() => ({ state: 'idle' })),
  unlink: vi.fn(async () => undefined),
  cancelLink: vi.fn(async () => ({ state: 'idle' })),
  getSummary: vi.fn(() => ({ linked: true, accountLabel: null, lastHeartbeatAt: null })),
  checkLink: vi.fn(async () => ({ linked: true, accountLabel: null, lastHeartbeatAt: null })),
}));
vi.mock('../../services/core/auth/cloud-link.js', () => ({
  getCloudLinkManager: () => manager,
}));

const plan = vi.hoisted(() => ({
  readPlanOverview: vi.fn(async () => null),
  readUsage: vi.fn(async () => null),
  readNudge: vi.fn(async () => null),
  listMembers: vi.fn(async () => null),
  listOrgs: vi.fn(async () => null),
  listSeats: vi.fn(async () => null),
  assignSeat: vi.fn(async () => ({})),
  releaseSeat: vi.fn(async () => undefined),
}));
vi.mock('../../services/core/cloud/plan.js', () => plan);

vi.mock('../../services/core/cloud/v1-client.js', () => ({
  isCloudLinked: () => true,
  problemOf: () => null,
  isAbsent: () => false,
}));

const billing = vi.hoisted(() => ({
  readOffers: vi.fn(async () => null),
  openBillingPage: vi.fn(async () => 'https://account.example.invalid/page'),
  requestAccountExport: vi.fn(async () => ({
    requestedAt: '2026-10-01T00:00:00Z',
    readyAt: null,
    downloadUrl: null,
  })),
  requestAccountDeletion: vi.fn(async () => ({
    requestedAt: '2026-10-01T00:00:00Z',
    confirmationSentTo: 'p***@example.invalid',
    confirmBy: null,
  })),
}));
vi.mock('../../services/core/cloud/billing-pages.js', () => billing);

vi.mock('../../services/core/cloud/credits-availability.js', () => ({
  creditsKilled: () => false,
}));
vi.mock('../../services/core/cloud/credits-runtimes.js', () => ({
  creditsStatus: async () => ({}),
  creditsRuntimeViews: () => [],
}));
const credits = vi.hoisted(() => ({
  // The default route asks whether a change changes anything before it asks
  // whether a whole-runtime switch would cut a reply off.
  creditsIsDefaultFor: vi.fn(() => false),
  setCreditsDefault: vi.fn(),
  undoFilledDefaults: vi.fn(() => []),
  dismissCreditsNotice: vi.fn(),
}));
vi.mock('../../services/core/cloud/credits-defaults.js', () => credits);

const hosted = vi.hoisted(() => ({
  startCommunity: vi.fn(async () => ({ community: {}, claimReady: false })),
  takeClaimLink: vi.fn(async () => ({ claimUrl: 'https://x.example.invalid', expiresAt: '' })),
  keepCommunity: vi.fn(async () => ({ community: {}, heldCommunityIds: [] })),
  restoreCommunity: vi.fn(async () => ({})),
  startMove: vi.fn(),
  cancelMove: vi.fn(async () => ({})),
  readMove: vi.fn(async () => null),
  readHostedCommunities: vi.fn(async () => null),
  checkCommunityName: vi.fn(async () => null),
  readAccountSignInOrigins: vi.fn(async () => null),
}));
vi.mock('../../services/core/cloud/hosted-communities.js', () => hosted);

const moveUploads = vi.hoisted(() => ({
  // Refused as an empty file, the way staging refuses one: reaching it is all
  // these tests need to see.
  stageArchive: vi.fn(async () => {
    const { StagingError } = await import('../../services/core/cloud/community-move-upload.js');
    throw new StagingError('empty');
  }),
  uploads: {
    retry: vi.fn(() => false),
    discard: vi.fn(),
    progress: vi.fn(() => null),
    begin: vi.fn(),
  },
}));
vi.mock('../../services/core/cloud/community-move-upload.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/cloud/community-move-upload.js')>()),
  stageArchive: moveUploads.stageArchive,
  communityMoveUploads: moveUploads.uploads,
}));

/** Whether login is on, read by the person bar exactly as `sessionGate` reads it. */
const posture = vi.hoisted(() => ({ authEnabled: false }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    // Spaces on (DOR-2740): the hosted-community routes exist only then.
    get: (key: string) =>
      key === 'auth'
        ? { enabled: posture.authEnabled }
        : key === 'spaces'
          ? { enabled: true }
          : undefined,
    onChange: () => () => {},
  },
}));

/** The account that owns this install. */
const OWNER_ID = 'user_owner';
/** What `readOwnerAccount` answers; `null` when no owner account can be read. */
const owner = vi.hoisted(() => ({
  account: { id: 'user_owner', name: 'Owner' } as { id: string; name: string } | null,
}));
// Legacy-key startup migration is outside this owner-bar fixture. Keep its
// config-write import from loading the owner predicate before the account mock.
vi.mock('../../services/core/auth/seed-legacy-mcp-key.js', () => ({
  seedLegacyMcpApiKey: vi.fn(async () => undefined),
}));
vi.mock('../../services/core/auth/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../services/core/auth/index.js')>()),
  readOwnerAccount: () => owner.account,
}));

import cloudRouter from '../cloud.js';

/** Who `sessionGate` resolved, as a test sets it; nobody by default (login off). */
let signedInUser: { userId: string; credential: 'cookie' | 'api-key' } | undefined;

const app = express();
app.use(express.json());
app.use((_req, res, next) => {
  if (signedInUser) res.locals.user = signedInUser;
  next();
});
app.use('/api/cloud', cloudRouter);
const server = listeningServer(app);

/** One account write: how to call it, and the spy it reaches when allowed. */
interface Write {
  name: string;
  method: 'post' | 'put';
  path: string;
  body?: object;
  effect: Mock;
  /** Completes "Only the owner of this DorkOS can …". */
  action: string;
}

const WRITES: Write[] = [
  {
    name: 'start a link',
    method: 'post',
    path: '/link/start',
    effect: manager.startLink,
    action: 'link this computer to a DorkOS account',
  },
  {
    name: 'cancel a link',
    method: 'post',
    path: '/link/cancel',
    effect: manager.cancelLink,
    action: 'stop linking this computer to a DorkOS account',
  },
  {
    name: 'unlink',
    method: 'post',
    path: '/unlink',
    effect: manager.unlink,
    action: 'unlink this computer from its DorkOS account',
  },
  {
    name: 'check the link',
    method: 'post',
    path: '/link/check',
    effect: manager.checkLink,
    action: 'check this computer’s DorkOS account link',
  },
  {
    name: 'assign a seat',
    method: 'post',
    path: '/seats/seat_1/assign',
    body: { subject: { kind: 'user', id: 'acct_1' } },
    effect: plan.assignSeat,
    action: 'change who holds a seat',
  },
  {
    name: 'release a seat',
    method: 'post',
    path: '/seats/seat_1/release',
    effect: plan.releaseSeat,
    action: 'change who holds a seat',
  },
  ...(['portal', 'topup', 'checkout'] as const).map((page): Write => ({
    name: `open the ${page} page`,
    method: 'post',
    path: `/billing/${page}`,
    body: page === 'checkout' ? { skuId: 'sku_1' } : {},
    effect: billing.openBillingPage,
    action: 'open billing for the DorkOS account',
  })),
  {
    name: 'request an export',
    method: 'post',
    path: '/account/export',
    effect: billing.requestAccountExport,
    action: 'export the DorkOS account’s data',
  },
  {
    name: 'request deletion',
    method: 'post',
    path: '/account/deletion',
    effect: billing.requestAccountDeletion,
    action: 'delete the DorkOS account',
  },
  {
    name: 'choose a credits default',
    method: 'put',
    path: '/credits/default',
    body: { runtime: 'claude-code', useCredits: false },
    effect: credits.setCreditsDefault,
    action: 'choose what runs on DorkOS credits',
  },
  {
    name: 'undo the credits DorkOS filled',
    method: 'post',
    path: '/credits/undo-filled',
    effect: credits.undoFilledDefaults,
    action: 'choose what runs on DorkOS credits',
  },
  {
    name: 'dismiss a credits notice',
    method: 'post',
    path: '/credits/notices/dismiss',
    body: { kind: 'offer' },
    effect: credits.dismissCreditsNotice,
    action: 'dismiss a note about DorkOS credits',
  },
  {
    name: 'start a space',
    method: 'post',
    path: '/communities',
    body: { idempotencyKey: 'k1', name: 'Team' },
    effect: hosted.startCommunity,
    action: 'start a space on the DorkOS account',
  },
  {
    name: 'start a move',
    method: 'post',
    path: '/communities/moves?idempotencyKey=k1&name=Team',
    effect: moveUploads.stageArchive,
    action: 'move a space to the DorkOS account',
  },
  {
    name: 'cancel a move',
    method: 'post',
    path: '/communities/moves/move_1/cancel',
    effect: hosted.cancelMove,
    action: 'move a space to the DorkOS account',
  },
  {
    name: 'resend a move',
    method: 'post',
    path: '/communities/moves/move_1/upload',
    effect: moveUploads.uploads.retry,
    action: 'move a space to the DorkOS account',
  },
  {
    name: 'take a claim link',
    method: 'post',
    path: '/communities/c_1/claim-link',
    effect: hosted.takeClaimLink,
    action: 'open the link that makes someone a space’s owner',
  },
  {
    name: 'keep a space',
    method: 'post',
    path: '/communities/c_1/keep',
    body: { expectedHeldCommunityIds: [] },
    effect: hosted.keepCommunity,
    action: 'choose which spaces stay open',
  },
  {
    name: 'reopen a space',
    method: 'post',
    path: '/communities/c_1/restore',
    effect: hosted.restoreCommunity,
    action: 'choose which spaces stay open',
  },
];

/** Send one write, with whatever headers a posture adds. */
function send(write: Write, headers: Record<string, string> = {}) {
  const req = request(server)[write.method](`/api/cloud${write.path}`);
  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  return write.body === undefined ? req : req.send(write.body);
}

/** The sentence and code a refused caller got, whichever shape the route answers in. */
function refusalOf(body: { code?: unknown; message?: unknown; error?: unknown }) {
  return { code: body.code, sentence: body.message ?? body.error };
}

describe('the DorkOS account owner bar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    posture.authEnabled = false;
    signedInUser = undefined;
  });

  describe.each(WRITES)('$name', (write) => {
    it('refuses an agent with a plain sentence, and does nothing', async () => {
      const res = await send(write, { 'x-dorkos-agent': 'agent-token-abc' }).expect(403);
      const { code, sentence } = refusalOf(res.body);
      expect(code).toBe('person_only');
      expect(sentence).toMatch(/^Only you can .+\.$/);
      expect(write.effect).not.toHaveBeenCalled();
    });

    it('refuses a caller holding an approval token', async () => {
      await send(write, { 'x-dorkos-approval': 'approval-token-abc' }).expect(403);
      expect(write.effect).not.toHaveBeenCalled();
    });

    it('with login on, refuses the owner’s API key without a browser session', async () => {
      posture.authEnabled = true;
      signedInUser = { userId: OWNER_ID, credential: 'api-key' };
      const res = await send(write).expect(403);
      expect(refusalOf(res.body).code).toBe('person_only');
      expect(write.effect).not.toHaveBeenCalled();
    });

    it('with login on, refuses a signed-in person who does not own this install', async () => {
      posture.authEnabled = true;
      signedInUser = { userId: 'user_member', credential: 'cookie' };
      const res = await send(write).expect(403);
      expect(refusalOf(res.body)).toEqual({
        code: 'owner_only',
        sentence: `Only the owner of this DorkOS can ${write.action}.`,
      });
      expect(write.effect).not.toHaveBeenCalled();
    });

    it('with login on, lets the owner signed in to the app through', async () => {
      posture.authEnabled = true;
      signedInUser = { userId: OWNER_ID, credential: 'cookie' };
      const res = await send(write);
      expect(res.status).not.toBe(403);
      expect(write.effect).toHaveBeenCalled();
    });

    it('with login on, refuses everyone when no owner account can be read', async () => {
      posture.authEnabled = true;
      signedInUser = { userId: OWNER_ID, credential: 'cookie' };
      owner.account = null;
      try {
        const res = await send(write).expect(403);
        expect(refusalOf(res.body).code).toBe('owner_only');
        expect(write.effect).not.toHaveBeenCalled();
      } finally {
        owner.account = { id: OWNER_ID, name: 'Owner' };
      }
    });

    it('with login off, lets the person at this computer through', async () => {
      const res = await send(write);
      expect(res.status).not.toBe(403);
      expect(write.effect).toHaveBeenCalled();
    });
  });

  describe('reads a member or an agent may still make', () => {
    it.each([
      '/link/status',
      '/status',
      '/plan',
      '/usage',
      '/nudge',
      '/orgs',
      '/orgs/org_1/seats',
      '/orgs/org_1/members',
      '/offers',
      '/credits',
      '/communities',
      '/communities/sign-in',
      '/communities/moves/move_1',
    ])('GET %s answers an agent', async (path) => {
      const res = await request(server)
        .get(`/api/cloud${path}`)
        .set('x-dorkos-agent', 'agent-token-abc');
      expect(res.status).toBe(200);
    });

    it('answers a signed-in person who does not own this install', async () => {
      posture.authEnabled = true;
      signedInUser = { userId: 'user_member', credential: 'cookie' };
      await request(server).get('/api/cloud/plan').expect(200);
      await request(server).get('/api/cloud/credits').expect(200);
    });
    describe('the code waiting for approval', () => {
      const waiting = {
        state: 'pending',
        pending: {
          userCode: 'WXYZ7890',
          verificationUri: 'https://x/activate',
          expiresAt: 'later',
        },
      };

      it('is shown to the person at this computer, so every tab shows the one code', async () => {
        manager.getStatus.mockReturnValueOnce(waiting);
        const res = await request(server).get('/api/cloud/link/status').expect(200);
        expect(res.body.pending.userCode).toBe('WXYZ7890');
      });

      it('is never shown to an agent, which could approve it with an account of its own', async () => {
        manager.getStatus.mockReturnValueOnce(waiting);
        const res = await request(server)
          .get('/api/cloud/link/status')
          .set('x-dorkos-agent', 'agent-token-abc')
          .expect(200);
        expect(res.body).toEqual({ state: 'pending' });
      });

      it('is never shown to a signed-in person who does not own this install', async () => {
        posture.authEnabled = true;
        signedInUser = { userId: 'user_member', credential: 'cookie' };
        manager.getStatus.mockReturnValueOnce(waiting);
        const res = await request(server).get('/api/cloud/link/status').expect(200);
        expect(res.body.pending).toBeUndefined();
      });
    });
  });
});

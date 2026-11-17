/** X uploads and posts that reach past the owner's account need the agent's own grant, through the real execution-authority seam (DOR-4332). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connections, eq } from '@dorkos/db';
import { ConnectorExecutionTargetSchema } from '@dorkos/shared/connector-schemas';
import { ConnectorExecutionAuthorizationService } from '../execution/authorization-service.js';
import { createServerPrincipal } from '../principal/server-principal.js';
import {
  CONNECTION_ID,
  idOf,
  levelHarness,
  levelIds,
  OWNER,
} from './helpers/access-levels-harness.js';

const UPLOADS = [
  'TWITTER_UPLOAD_MEDIA',
  'TWITTER_UPLOAD_LARGE_MEDIA',
  'TWITTER_INITIALIZE_MEDIA_UPLOAD',
] as const;
const APPEND = 'TWITTER_APPEND_MEDIA_UPLOAD';
const POST = 'TWITTER_CREATION_OF_A_POST';
const opened: ReturnType<typeof levelHarness>[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.db.$client.close();
});

async function setup(toolkit = 'twitter') {
  const h = levelHarness({ type: 'composio' });
  opened.push(h);
  h.db.update(connections).set({ toolkit }).where(eq(connections.id, CONNECTION_ID)).run();
  h.catalog.splice(
    0,
    h.catalog.length,
    ...[...UPLOADS, APPEND, POST, 'GOOGLEDRIVE_UPLOAD_FILE'].map((slug) => ({
      slug,
      classification: 'write' as const,
    }))
  );
  const list = vi.mocked(h.provider.listOperationSchemas).getMockImplementation()!;
  vi.spyOn(h.provider, 'listOperationSchemas').mockImplementation(async (request) => {
    const result = await list(request);
    if (result.status !== 'ok') return result;
    return {
      ...result,
      page: {
        ...result.page,
        operations: result.page.operations.map((operation) => ({
          ...operation,
          inputSchema: { type: 'object', additionalProperties: true },
        })),
      },
    };
  });
  const snapshot = await h.preview();
  await h.service.apply(OWNER, {
    previewId: snapshot.previewId,
    grants: [
      {
        agentId: 'writer',
        operationRevisionIds: levelIds(snapshot, 'read-write'),
        level: 'read-write',
      },
      {
        agentId: 'exact',
        operationRevisionIds: snapshot.candidates.map((row) => row.operationRevisionId),
      },
    ],
    everyAgent: { operationRevisionIds: levelIds(snapshot, 'read-write'), level: 'read-write' },
  });
  const authorization = new ConnectorExecutionAuthorizationService(h.db, h.registry, {
    ownsAgent: () => true,
  });
  return (agentId: string, slug: string, args: Record<string, unknown>) =>
    authorization.prepare({
      capabilityId: 'connectors.execute_write',
      principal: createServerPrincipal({
        kind: 'agent',
        owner: OWNER,
        agentId,
        agentPath: `/agents/${agentId}`,
      }),
      target: ConnectorExecutionTargetSchema.parse({
        connectionId: CONNECTION_ID,
        operationRevisionId: idOf(snapshot, slug),
        arguments: args,
      }),
    });
}

const SHARED_UPLOAD = {
  payload: {
    code: 'CONNECTOR_GRANT_REQUIRED',
    error:
      'This X upload would let other accounts use your media, so it needs to be given to this agent on its own.',
  },
};
const HIDDEN_POST = {
  payload: {
    code: 'CONNECTOR_GRANT_REQUIRED',
    error:
      'This X post would be promoted-only and stay off your timeline, so it needs to be given to this agent on its own.',
  },
};
/** Broad access: the agent's own level, and the owner's every-agent share. */
const BROAD = ['writer', 'reader'] as const;

const SHARING = UPLOADS.flatMap(
  (slug) =>
    [
      [slug, { media: '/tmp/a.png', additional_owners: ['2244994945'] }],
      [slug, { media: '/tmp/a.png', shared: true }],
      [slug, { media: '/tmp/a.png', additionalOwners: '2244994945' }],
      [slug, { media: '/tmp/a.png', shared: 'yes' }],
      // A value the check can't read counts as set.
      [slug, { media: '/tmp/a.png', additional_owners: { id: '2244994945' } }],
      [slug, { media: '/tmp/a.png', shared: {} }],
    ] as const
);

describe('an X upload shared with other accounts needs the agent’s own grant', () => {
  it.each(
    BROAD.flatMap((agentId) => SHARING.map(([slug, args]) => [agentId, slug, args] as const))
  )('refuses %s running %s with %o', async (agentId, slug, args) => {
    const run = await setup();
    await expect(run(agentId, slug, args)).rejects.toMatchObject(SHARED_UPLOAD);
  });

  it.each(SHARING)('runs %s with %o for its own exact grant', async (slug, args) => {
    const run = await setup();
    await expect(run('exact', slug, args)).resolves.toMatchObject({ agentId: 'exact' });
  });

  it.each(
    UPLOADS.flatMap(
      (slug) =>
        [
          [slug, { media: '/tmp/a.png' }],
          [slug, { media: '/tmp/a.png', additional_owners: [], shared: false }],
          [slug, { media: '/tmp/a.png', additional_owners: [''], shared: 'false' }],
        ] as const
    )
  )('runs %s at write with %o', async (slug, args) => {
    const run = await setup();
    await expect(run('writer', slug, args)).resolves.toMatchObject({ agentId: 'writer' });
  });

  it('lets the append step run, since it shares nothing', async () => {
    const run = await setup();
    await expect(
      run('writer', APPEND, { id: '1146654567674912769', media: 'AAAA', segment_index: 0 })
    ).resolves.toMatchObject({ agentId: 'writer' });
  });
});

describe('a promoted-only X post needs the agent’s own grant', () => {
  it.each(BROAD)('refuses a nullcast post for %s', async (agentId) => {
    const run = await setup();
    await expect(run(agentId, POST, { text: 'Hello', nullcast: true })).rejects.toMatchObject(
      HIDDEN_POST
    );
  });

  it('runs a nullcast post for its own exact grant', async () => {
    const run = await setup();
    await expect(run('exact', POST, { text: 'Hello', nullcast: true })).resolves.toMatchObject({
      agentId: 'exact',
    });
  });

  it('runs an ordinary post at write', async () => {
    const run = await setup();
    await expect(run('writer', POST, { text: 'Hello', nullcast: false })).resolves.toMatchObject({
      agentId: 'writer',
    });
  });
});

describe('other apps are untouched', () => {
  it('leaves a Drive upload with a shared flag to the usual rules', async () => {
    const run = await setup('googledrive');
    await expect(
      run('writer', 'GOOGLEDRIVE_UPLOAD_FILE', { name: 'a.txt', shared: true })
    ).resolves.toMatchObject({ agentId: 'writer' });
  });
});

/** GitHub workflow-file policy crosses the real reconciliation and execution-authority seam. */
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

const CONTENTS = 'GITHUB_CREATE_OR_UPDATE_FILE_CONTENTS';
const TREE = 'GITHUB_CREATE_A_TREE';
const MULTIPLE = 'GITHUB_COMMIT_MULTIPLE_FILES';
const DELETE = 'GITHUB_DELETE_A_FILE';
const opened: ReturnType<typeof levelHarness>[] = [];
afterEach(() => {
  for (const h of opened.splice(0)) h.db.$client.close();
});

async function setup() {
  const h = levelHarness({ type: 'composio' });
  opened.push(h);
  h.db
    .update(connections)
    .set({ toolkit: 'github' })
    .where(eq(connections.id, CONNECTION_ID))
    .run();
  h.catalog.splice(
    0,
    h.catalog.length,
    ...[CONTENTS, TREE, MULTIPLE, DELETE, 'GitHubCreateOrUpdateFileContents'].map((slug) => ({
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
      { agentId: 'exact', operationRevisionIds: levelIds(snapshot, 'read-write') },
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

describe('workflow files need the agent’s own exact grant', () => {
  it.each([
    '.github/workflows/ci.yml',
    './.GitHub/Workflows/ci.yml',
    '/.github//workflows/a.yml',
    '/./.github/workflows/b.yml',
  ])('refuses a level holding a workflow path %s', async (path) => {
    const run = await setup();
    await expect(run('writer', CONTENTS, { path })).rejects.toMatchObject({
      payload: {
        code: 'CONNECTOR_GRANT_REQUIRED',
        error: 'Changing workflow files needs this action given to this agent on its own.',
      },
    });
  });
  it('recognizes a normalized action spelling at execution too', async () => {
    const run = await setup();
    await expect(
      run('writer', 'GitHubCreateOrUpdateFileContents', { path: '.github/workflows/ci.yml' })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
  });
  it('allows a level to edit an ordinary file', async () => {
    const run = await setup();
    await expect(run('writer', CONTENTS, { path: 'src/x.ts' })).resolves.toMatchObject({
      agentId: 'writer',
    });
  });
  it('allows the agent’s own exact grant to edit workflow files', async () => {
    const run = await setup();
    await expect(
      run('exact', CONTENTS, { path: '.github/workflows/ci.yml' })
    ).resolves.toMatchObject({ agentId: 'exact' });
  });
  it('refuses a workflow file held only through every-agent sharing', async () => {
    const run = await setup();
    await expect(
      run('reader', CONTENTS, { path: '.github/workflows/ci.yml' })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
  });
  it('refuses a tree containing one workflow among ordinary files', async () => {
    const run = await setup();
    await expect(
      run('writer', TREE, { tree: [{ path: 'src/x.ts' }, { path: '.github/workflows/ci.yml' }] })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
  });
  it.each([
    [MULTIPLE, { upserts: [{ path: 'src/x.ts' }, { path: '.github/workflows/ci.yml' }] }],
    [MULTIPLE, { deletes: ['src/x.ts', './.github/workflows/ci.yml'] }],
    [DELETE, { path: '.github/workflows/ci.yml' }],
  ] as const)('refuses workflow changes through %s', async (slug, args) => {
    const run = await setup();
    await expect(run('writer', slug, args)).rejects.toMatchObject({
      payload: { code: 'CONNECTOR_GRANT_REQUIRED' },
    });
  });
});

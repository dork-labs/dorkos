/** Repository-control policy crosses the real reconciliation and execution-authority seam. */
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

async function setup(toolkit = 'github') {
  const h = levelHarness({ type: 'composio' });
  opened.push(h);
  h.db.update(connections).set({ toolkit }).where(eq(connections.id, CONNECTION_ID)).run();
  h.catalog.splice(
    0,
    h.catalog.length,
    ...[
      CONTENTS,
      TREE,
      MULTIPLE,
      DELETE,
      'GitHubCreateOrUpdateFileContents',
      'GITHUB_MCP_CREATE_OR_UPDATE_FILE',
      'GITHUB_MCP_PUSH_FILES',
      'GITLAB_SAVE_FILE',
      'GITEA_SAVE_FILE',
      'DROPBOX_SAVE_FILE',
      'GITLAB_CREATE_COMMIT',
      'GITLAB_CREATE_FILE',
      'GITEA_CHANGE_REPOSITORY_FILES',
      'GITEA_UPSERT_REPOSITORY_FILE',
    ].map((slug) => ({
      slug,
      classification: 'write' as const,
    })),
    { slug: 'GITHUB_MERGE_A_PULL_REQUEST', classification: 'destructive' }
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
      capabilityId:
        slug === 'GITHUB_MERGE_A_PULL_REQUEST'
          ? 'connectors.execute_destructive'
          : 'connectors.execute_write',
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
        error:
          'Changing repository control files needs this action given to this agent on its own.',
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

describe('repository-control paths need the agent’s own exact grant', () => {
  it.each(['.github', '.github/workflows'])('refuses a nested tree entry at %s', async (path) => {
    const run = await setup();
    await expect(
      run('writer', TREE, { tree: [{ path, type: 'tree', mode: '040000', sha: 'tree-sha' }] })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
  });
  it.each([
    ['GITHUB_MCP_CREATE_OR_UPDATE_FILE', { path: '.github/actions/action.yml' }],
    ['GITHUB_MCP_PUSH_FILES', { files: [{ path: 'src/x.ts' }, { path: '.github/CODEOWNERS' }] }],
  ] as const)('refuses repository controls through github_mcp action %s', async (slug, args) => {
    const run = await setup('github_mcp');
    await expect(run('writer', slug, args)).rejects.toMatchObject({
      payload: { code: 'CONNECTOR_GRANT_REQUIRED' },
    });
  });
  it.each([
    '.github/config.yml',
    '.gitlab-ci.yml',
    '.gitlab/ci/build.yml',
    '.gitea/workflows/ci.yml',
    '.forgejo/workflows/ci.yml',
    'bitbucket-pipelines.yml',
    '.circleci/config.yml',
    '.buildkite/pipeline.yml',
  ])('refuses a control path on a made-up GitLab action: %s', async (path) => {
    const run = await setup('gitlab');
    await expect(
      run('writer', 'GITLAB_SAVE_FILE', { input: { files: [{ repositoryPath: path }] } })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
  });
  it.each([
    '%2Egithub%2Fworkflows%2Fx.yml',
    '%252Egithub%252Fworkflows%252Fx.yml',
    '.github\\workflows\\x.yml',
    ' .github /workflows/x.yml',
    'src/../.github/workflows/x.yml',
  ])('refuses a disguised or undecodable control path %s', async (path) => {
    const run = await setup('gitlab');
    await expect(
      run('writer', 'GITLAB_SAVE_FILE', { destinationPaths: [path] })
    ).rejects.toMatchObject({ payload: { code: 'CONNECTOR_GRANT_REQUIRED' } });
  });
  it('allows an exact grant to use nested control paths on another toolkit', async () => {
    const run = await setup('github_mcp');
    await expect(
      run('exact', 'GITHUB_MCP_PUSH_FILES', { files: [{ path: '.github/CODEOWNERS' }] })
    ).resolves.toMatchObject({ agentId: 'exact' });
  });
  it('allows ordinary paths and does not treat file content as a path', async () => {
    const run = await setup('gitlab');
    await expect(
      run('writer', 'GITLAB_SAVE_FILE', {
        files: [{ path: 'src/./nested/../x.ts', content: '.github/workflows/ci.yml' }],
      })
    ).resolves.toMatchObject({ agentId: 'writer' });
  });
});

describe('more repository controls and ordinary percent filenames', () => {
  it.each([
    'CODEOWNERS',
    'docs/CODEOWNERS',
    '.github/CODEOWNERS',
    '.gitlab/CODEOWNERS',
    'Jenkinsfile',
    'azure-pipelines.yml',
    'azure-pipelines.yaml',
    '.travis.yml',
    '.drone.yml',
    '.woodpecker.yml',
    '.woodpecker.yaml',
    '.appveyor.yml',
    '.woodpecker/',
    '.woodpecker/pipeline.yml',
    'appveyor.yml',
    '.semaphore/',
    '.semaphore/semaphore.yml',
    'cloudbuild.yaml',
    'cloudbuild.yml',
  ])('requires an exact action for control file %s regardless of case', async (path) => {
    const run = await setup();
    for (const spelling of [path, path.toUpperCase()]) {
      await expect(run('writer', CONTENTS, { path: spelling })).rejects.toMatchObject({
        payload: { code: 'CONNECTOR_GRANT_REQUIRED' },
      });
    }
  });
  it.each([
    '/Reports/50% off.pdf',
    '/Reports/50%25 off.pdf',
    '%broken/path',
    'src/CODEOWNERS',
    '/Q3 50% plan/Jenkinsfile',
    '50%%2F.github/workflows/x.yml',
    '50%%252F.github/workflows/x.yml',
    '%FF%2F.github/workflows/x.yml',
  ])('allows an ordinary Dropbox path %s through a level', async (path) => {
    const run = await setup('dropbox');
    await expect(run('writer', 'DROPBOX_SAVE_FILE', { path })).resolves.toMatchObject({
      agentId: 'writer',
    });
  });
  it.each([
    '%2Egithub%2Fworkflows%2Fx.yml',
    '%2Egithub%2Fworkflows%2F50% off.yml',
    '%252Egithub%252Fworkflows%252F50% off.yml',
    '.github/workflows/50% off.yml',
  ])('keeps encoded or mixed percent control path %s explicit', async (path) => {
    const run = await setup('dropbox');
    await expect(run('writer', 'DROPBOX_SAVE_FILE', { path })).rejects.toMatchObject({
      payload: { code: 'CONNECTOR_GRANT_REQUIRED' },
    });
  });
  it.each([
    ['gitlab', 'GITLAB_SAVE_FILE', { actions: [{ file_path: '.gitlab-ci.yml' }] }],
    [
      'gitlab',
      'GITLAB_SAVE_FILE',
      { actions: [{ file_path: 'ci/new.yml', previous_path: '.gitlab-ci.yml' }] },
    ],
    [
      'gitea',
      'GITEA_SAVE_FILE',
      { files: [{ path: 'ci/new.yml', from_path: '.gitea/workflows/ci.yml' }] },
    ],
    ['gitea', 'GITEA_SAVE_FILE', { filepath: '.gitea/workflows/ci.yml' }],
  ] as const)('checks real path keys for %s action %s: %j', async (toolkit, slug, args) => {
    const run = await setup(toolkit);
    await expect(run('writer', slug, args)).rejects.toMatchObject({
      payload: { code: 'CONNECTOR_GRANT_REQUIRED' },
    });
  });
});

// Keys confirmed against each action's real Composio input schema.
const historyChanges = [
  ['github', MULTIPLE, { force: true }],
  ['github', MULTIPLE, { base_branch: 'main' }],
  ['gitlab', 'GITLAB_CREATE_COMMIT', { force: true }],
  ['gitlab', 'GITLAB_CREATE_COMMIT', { start_branch: 'main' }],
  ['gitlab', 'GITLAB_CREATE_FILE', { start_branch: 'main' }],
  ['gitea', 'GITEA_CHANGE_REPOSITORY_FILES', { force_push: true }],
  ['gitea', 'GITEA_CHANGE_REPOSITORY_FILES', { new_branch: 'topic' }],
  ['gitea', 'GITEA_UPSERT_REPOSITORY_FILE', { force_push: true }],
  ['gitea', 'GITEA_UPSERT_REPOSITORY_FILE', { new_branch: 'topic' }],
] as const;

describe('repository history and branch arguments need exact grants', () => {
  it.each(historyChanges)(
    'refuses a level for %s action %s with %j',
    async (toolkit, slug, args) => {
      const run = await setup(toolkit);
      await expect(run('writer', slug, args)).rejects.toMatchObject({
        payload: {
          code: 'CONNECTOR_GRANT_REQUIRED',
          error:
            'Changing repository control files needs this action given to this agent on its own.',
        },
      });
    }
  );
  it.each(historyChanges)(
    'allows an exact grant for %s action %s with %j',
    async (toolkit, slug, args) => {
      const run = await setup(toolkit);
      await expect(run('exact', slug, args)).resolves.toMatchObject({ agentId: 'exact' });
    }
  );
  it('checks nested history arguments inside objects and arrays', async () => {
    const run = await setup();
    await expect(run('writer', MULTIPLE, { options: [{ force: true }] })).rejects.toMatchObject({
      payload: { code: 'CONNECTOR_GRANT_REQUIRED' },
    });
  });
  it.each([
    { force: false, force_push: false },
    { new_branch: '', start_branch: '', base_branch: '' },
    { force: 'true', force_push: 'true', new_branch: null, start_branch: false },
    { content: 'force: true', branch: 'main', forceful: true },
  ])('allows ordinary file changes with %j', async (args) => {
    const run = await setup();
    await expect(run('writer', MULTIPLE, args)).resolves.toMatchObject({ agentId: 'writer' });
  });
  it('allows an exact grant of GITHUB_MERGE_A_PULL_REQUEST', async () => {
    const run = await setup();
    await expect(
      run('exact', 'GITHUB_MERGE_A_PULL_REQUEST', { pull_number: 7 })
    ).resolves.toMatchObject({ agentId: 'exact' });
  });
});

/**
 * Contract for the route groups that read and write folders on this machine,
 * which move to Hono together in DOR-2798: directory, git, workspaces,
 * projects, read cursors, session locations, templates, harness and shapes.
 * That PR must pass this file unchanged.
 *
 * Most of these routes take a path from the caller, so the boundary refusals
 * are the heart of it: a folder outside `DORKOS_BOUNDARY` (the repository root
 * here, see `harness.ts`), a `..` walk out of it, a NUL byte, and a path
 * parameter that decodes to a traversal. The composed server runs with a fresh
 * data directory and login off, so lists start empty and the caller is the
 * person at the keyboard unless a case sends an agent header.
 *
 * Nothing here writes into the repository except a few throwaway folders under
 * the git-ignored `.temp/`, removed afterwards. The harness sync and adopt cases
 * aim at a folder with no harness manifest, so they refuse before writing.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';
import { z } from 'zod';
import { BrowseDirectoryResponseSchema, GitStatusResponseSchema } from '@dorkos/shared/schemas';
import {
  ProjectListResponseSchema,
  ProjectResolveResponseSchema,
} from '@dorkos/shared/project-schemas';
import { ReadCursorSchema } from '@dorkos/shared/read-cursor-schemas';
import { TemplateCatalogSchema } from '@dorkos/shared/template-catalog';
import { HarnessStatusResponseSchema } from '@dorkos/shared/harness-schemas';
import { WorktreeScanResultSchema } from '@dorkos/shared/workspace';
import { contractSuite } from './harness.js';
import { problemBody, validationProblemBody } from '@dorkos/http-kit';

/** The repository root: the composed server's directory boundary. */
const REPO_ROOT = realpathSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..')
);
/** Where the folders this file creates go, git-ignored. */
const SCRATCH = path.join(REPO_ROOT, '.temp');
mkdirSync(SCRATCH, { recursive: true });
/** A folder name `POST /api/directory` accepts: kebab-case, starting with a letter. */
const NEW_FOLDER = `contract-${randomUUID().slice(0, 8)}`;
/** A parent `POST /api/directory` has to make on the way. */
const NEW_PARENT = path.join(SCRATCH, `${NEW_FOLDER}-parent`);
/**
 * A repository of its own inside the boundary, so the project lookup answers
 * the same in a plain checkout and in a worktree (whose main checkout can sit
 * outside the boundary).
 */
const NESTED_REPO = path.join(SCRATCH, `${NEW_FOLDER}-repo`);
mkdirSync(path.join(NESTED_REPO, 'src'), { recursive: true });
execFileSync('git', ['init', '--quiet', NESTED_REPO]);
afterAll(() => {
  for (const made of [path.join(SCRATCH, NEW_FOLDER), NEW_PARENT, NESTED_REPO]) {
    rmSync(made, { recursive: true, force: true });
  }
});

/** A folder inside the boundary with no harness manifest. */
const NO_MANIFEST = path.join(REPO_ROOT, 'apps/server/src');

const JSON_TYPE = { 'content-type': /^application\/json\b/ };
const NOT_FOUND = problemBody('not_found', {
  detail: 'This server has no API route at that path.',
});
const OUTSIDE = {
  error: 'Access denied: path outside directory boundary',
  code: 'OUTSIDE_BOUNDARY',
};
const NULL_BYTE = { error: 'Invalid path: null bytes not allowed', code: 'NULL_BYTE' };
const GIT_OUTSIDE = problemBody('outside_boundary', {
  detail: 'Pick a folder inside the ones DorkOS may use.',
});
const GIT_NULL_BYTE = problemBody('invalid_request', {
  detail: 'That path has a character paths can’t hold.',
});
const NO_WORKSPACE = problemBody('not_found', { detail: 'No workspace with that id.' });
/** An agent header this machine never minted: the caller is a machine, unverified. */
const AGENT = { 'X-DorkOS-Agent': 'not-a-real-token' };
const CROSS_SITE = { 'Sec-Fetch-Site': 'cross-site' };
const q = encodeURIComponent;

/** A template `POST /api/templates` accepts. */
const TEMPLATE = {
  id: `contract-${randomUUID().slice(0, 8)}`,
  name: 'Contract template',
  description: 'Made by the contract suite',
  source: 'github:dork-labs/contract',
  category: 'general',
};

contractSuite('workspace, project, git, directory, template, shape and harness groups', [
  // directory
  {
    name: 'GET /api/directory lists the boundary root with no way up',
    path: '/api/directory',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: BrowseDirectoryResponseSchema.extend({
        path: z.literal(REPO_ROOT),
        parent: z.null(),
      }),
    },
  },
  {
    name: 'GET /api/directory lists a folder inside the boundary, folders only, hidden ones left out',
    path: `/api/directory?path=${q(REPO_ROOT)}`,
    expect: {
      status: 200,
      schema: BrowseDirectoryResponseSchema.refine(
        (body) =>
          body.entries.some((entry) => entry.name === 'apps') &&
          !body.entries.some((entry) => entry.name.startsWith('.')) &&
          !body.entries.some((entry) => entry.name === 'package.json')
      ),
    },
  },
  {
    name: 'GET /api/directory shows hidden folders when asked',
    path: `/api/directory?path=${q(REPO_ROOT)}&showHidden=true`,
    expect: {
      status: 200,
      schema: BrowseDirectoryResponseSchema.refine((body) =>
        body.entries.some((entry) => entry.name === '.temp')
      ),
    },
  },
  {
    name: 'GET /api/directory offers the way up from a folder below the root',
    path: `/api/directory?path=${q(path.join(REPO_ROOT, 'apps'))}`,
    expect: {
      status: 200,
      schema: BrowseDirectoryResponseSchema.extend({
        path: z.literal(path.join(REPO_ROOT, 'apps')),
        parent: z.literal(REPO_ROOT),
      }),
    },
  },
  {
    name: 'GET /api/directory/ answers with a trailing slash',
    path: '/api/directory/',
    expect: { status: 200, schema: BrowseDirectoryResponseSchema },
  },
  {
    name: 'GET /api/directory refuses a folder outside the boundary',
    path: '/api/directory?path=/etc',
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/directory refuses a walk out of the boundary',
    path: `/api/directory?path=${q(`${REPO_ROOT}/../../..`)}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/directory refuses a NUL byte',
    path: `/api/directory?path=${q(`${REPO_ROOT}/a\0b`)}`,
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'GET /api/directory answers 404 for a folder that does not exist',
    path: `/api/directory?path=${q(path.join(REPO_ROOT, 'no-such-folder'))}`,
    expect: { status: 404, body: { error: 'Directory not found' } },
  },
  {
    name: 'GET /api/directory refuses a file',
    path: `/api/directory?path=${q(path.join(REPO_ROOT, 'package.json'))}`,
    expect: { status: 400, body: { error: 'Not a directory' } },
  },
  {
    name: 'GET /api/directory refuses an empty path',
    path: '/api/directory?path=',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { path: ['Too small: expected string to have >=1 characters'] },
      }),
    },
  },
  {
    name: 'GET /api/directory refuses a repeated path',
    path: `/api/directory?path=${q(REPO_ROOT)}&path=${q(REPO_ROOT)}`,
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { path: ['Invalid input: expected string, received array'] },
      }),
    },
  },
  {
    name: 'GET /api/directory/default answers the default working directory',
    path: '/api/directory/default',
    expect: { status: 200, headers: JSON_TYPE, body: { path: REPO_ROOT } },
  },
  {
    name: 'HEAD /api/directory/default answers the GET’s status and type with no body',
    method: 'HEAD',
    path: '/api/directory/default',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'POST /api/directory refuses a body without its fields',
    method: 'POST',
    path: '/api/directory',
    body: {},
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: {
          parentPath: ['Invalid input: expected string, received undefined'],
          folderName: ['Invalid input: expected string, received undefined'],
        },
      }),
    },
  },
  {
    name: 'POST /api/directory refuses a request with no body',
    method: 'POST',
    path: '/api/directory',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: ['Invalid input: expected object, received undefined'],
        fieldErrors: {},
      }),
    },
  },
  {
    name: 'POST /api/directory refuses a folder name that is not kebab-case',
    method: 'POST',
    path: '/api/directory',
    body: { parentPath: SCRATCH, folderName: 'Not Kebab' },
    expect: {
      status: 400,
      body: {
        error:
          'Invalid folder name. Lowercase letters, numbers, and hyphens only. Must start with a letter.',
      },
    },
  },
  {
    name: 'POST /api/directory refuses a parent outside the boundary',
    method: 'POST',
    path: '/api/directory',
    body: { parentPath: '/tmp', folderName: 'contract-escape' },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/directory refuses a NUL byte in the parent',
    method: 'POST',
    path: '/api/directory',
    body: { parentPath: `${SCRATCH}\0`, folderName: 'contract-nul' },
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'POST /api/directory makes a missing parent inside the boundary on the way',
    method: 'POST',
    path: '/api/directory',
    body: { parentPath: NEW_PARENT, folderName: 'contract-child' },
    expect: { status: 201, body: { path: path.join(NEW_PARENT, 'contract-child') } },
  },
  {
    name: 'POST /api/directory creates a folder inside the boundary',
    method: 'POST',
    path: '/api/directory',
    body: { parentPath: SCRATCH, folderName: NEW_FOLDER },
    expect: { status: 201, headers: JSON_TYPE, body: { path: path.join(SCRATCH, NEW_FOLDER) } },
  },
  {
    name: 'POST /api/directory refuses a folder that already exists (after the case above)',
    method: 'POST',
    path: '/api/directory',
    body: { parentPath: SCRATCH, folderName: NEW_FOLDER },
    expect: { status: 409, body: { error: 'Directory already exists' } },
  },
  {
    name: 'PUT /api/directory is not a route',
    method: 'PUT',
    path: '/api/directory',
    body: {},
    expect: { status: 404, body: NOT_FOUND },
  },

  // git
  {
    name: 'GET /api/git/status answers the status of a repository inside the boundary',
    path: `/api/git/status?dir=${q(REPO_ROOT)}`,
    expect: { status: 200, headers: JSON_TYPE, schema: GitStatusResponseSchema },
  },
  {
    name: 'GET /api/git/status/ answers the default directory with a trailing slash',
    path: '/api/git/status/',
    expect: { status: 200, schema: GitStatusResponseSchema },
  },
  {
    name: 'HEAD /api/git/status answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/git/status',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/git/status answers not_git_repo for a folder that is no repository',
    path: `/api/git/status?dir=${q(SCRATCH)}`,
    expect: {
      status: 200,
      schema: z.union([GitStatusResponseSchema, z.object({ error: z.literal('not_git_repo') })]),
    },
  },
  {
    name: 'GET /api/git/status refuses a folder outside the boundary',
    path: '/api/git/status?dir=/etc',
    expect: { status: 403, body: GIT_OUTSIDE },
  },
  {
    name: 'GET /api/git/status refuses a walk out of the boundary',
    path: `/api/git/status?dir=${q(`${REPO_ROOT}/../..`)}`,
    expect: { status: 403, body: GIT_OUTSIDE },
  },
  {
    name: 'GET /api/git/status refuses a NUL byte with a 400',
    path: `/api/git/status?dir=${q(`${REPO_ROOT}\0`)}`,
    expect: { status: 400, body: GIT_NULL_BYTE },
  },
  {
    name: 'GET /api/git/status refuses a repeated dir',
    path: '/api/git/status?dir=a&dir=b',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { dir: ['Invalid input: expected string, received array'] },
      }),
    },
  },
  {
    name: 'GET /api/git is not a route',
    path: '/api/git',
    expect: { status: 404, body: NOT_FOUND },
  },

  // workspaces
  {
    name: 'GET /api/workspaces lists no workspaces on a fresh install',
    path: '/api/workspaces',
    expect: { status: 200, headers: JSON_TYPE, body: { workspaces: [] } },
  },
  {
    name: 'GET /api/workspaces/ answers with a trailing slash',
    path: '/api/workspaces/?projectKey=nothing-here',
    expect: { status: 200, body: { workspaces: [] } },
  },
  {
    name: 'HEAD /api/workspaces answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/workspaces',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/workspaces refuses a repeated projectKey',
    path: '/api/workspaces?projectKey=a&projectKey=b',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { projectKey: ['Invalid input: expected string, received array'] },
      }),
    },
  },
  {
    name: 'GET /api/workspaces/scan scans the workspace root',
    path: '/api/workspaces/scan',
    expect: { status: 200, headers: JSON_TYPE, schema: WorktreeScanResultSchema },
  },
  {
    name: 'GET /api/workspaces/resolve answers no workspace for a folder outside every one',
    path: `/api/workspaces/resolve?path=${q(REPO_ROOT)}`,
    expect: { status: 200, body: { workspace: null } },
  },
  {
    name: 'GET /api/workspaces/resolve refuses a missing path',
    path: '/api/workspaces/resolve',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { path: ['Invalid input: expected string, received undefined'] },
      }),
    },
  },
  {
    name: 'POST /api/workspaces/ports answers 404 for a folder in no managed workspace',
    method: 'POST',
    path: '/api/workspaces/ports',
    body: { path: REPO_ROOT },
    expect: {
      status: 404,
      body: problemBody('not_found', { detail: 'That path isn’t inside a managed workspace.' }),
    },
  },
  {
    name: 'POST /api/workspaces/ports refuses a request with no body',
    method: 'POST',
    path: '/api/workspaces/ports',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: ['Invalid input: expected object, received undefined'],
        fieldErrors: {},
      }),
    },
  },
  {
    name: 'POST /api/workspaces refuses a body without its fields',
    method: 'POST',
    path: '/api/workspaces',
    body: {},
    expect: {
      status: 400,
      schema: z.object({ code: z.literal('invalid_request'), issues: z.unknown() }).loose(),
    },
  },
  {
    name: 'POST /api/workspaces refuses a request with no body',
    method: 'POST',
    path: '/api/workspaces',
    expect: {
      status: 400,
      schema: z.object({ code: z.literal('invalid_request'), issues: z.unknown() }).loose(),
    },
  },
  {
    name: 'GET /api/workspaces/:id answers 404 for an unknown workspace',
    path: '/api/workspaces/no-such-workspace',
    expect: { status: 404, body: NO_WORKSPACE },
  },
  {
    name: 'GET /api/workspaces/:id decodes an encoded slash and still answers 404',
    path: '/api/workspaces/..%2F..%2Fetc',
    expect: { status: 404, body: NO_WORKSPACE },
  },
  {
    name: 'POST /api/workspaces/:id/pin answers 404 for an unknown workspace',
    method: 'POST',
    path: '/api/workspaces/no-such-workspace/pin',
    body: { pinned: true },
    expect: { status: 404, body: NO_WORKSPACE },
  },
  {
    name: 'POST /api/workspaces/:id/pin refuses a body without pinned',
    method: 'POST',
    path: '/api/workspaces/no-such-workspace/pin',
    body: { pinned: 'yes' },
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { pinned: ['Invalid input: expected boolean, received string'] },
      }),
    },
  },
  {
    name: 'DELETE /api/workspaces/:id answers 404 for an unknown workspace',
    method: 'DELETE',
    path: '/api/workspaces/no-such-workspace?force=true',
    expect: { status: 404, body: NO_WORKSPACE },
  },
  {
    name: 'DELETE /api/workspaces/:id refuses an empty approvedRemoveHooks',
    method: 'DELETE',
    path: '/api/workspaces/no-such-workspace?approvedRemoveHooks=',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: {
          approvedRemoveHooks: ['Too small: expected string to have >=1 characters'],
        },
      }),
    },
  },

  // projects
  {
    name: 'GET /api/projects lists the known projects',
    path: '/api/projects',
    expect: { status: 200, headers: JSON_TYPE, schema: ProjectListResponseSchema },
  },
  {
    name: 'HEAD /api/projects answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/projects',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'GET /api/projects/resolve names the project a folder belongs to',
    path: `/api/projects/resolve?cwd=${q(path.join(NESTED_REPO, 'src'))}`,
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: ProjectResolveResponseSchema.extend({
        project: z.object({ root: z.literal(NESTED_REPO) }).loose(),
      }),
    },
  },
  {
    name: 'GET /api/projects/resolve/ answers with a trailing slash',
    path: `/api/projects/resolve/?cwd=${q(NESTED_REPO)}`,
    expect: { status: 200, schema: ProjectResolveResponseSchema },
  },
  {
    name: 'GET /api/projects/resolve refuses a folder outside the boundary',
    path: '/api/projects/resolve?cwd=/etc',
    expect: { status: 403, body: GIT_OUTSIDE },
  },
  {
    name: 'GET /api/projects/resolve refuses a walk out of the boundary',
    path: `/api/projects/resolve?cwd=${q(`${REPO_ROOT}/../..`)}`,
    expect: { status: 403, body: GIT_OUTSIDE },
  },
  {
    name: 'GET /api/projects/resolve refuses a NUL byte with a 400',
    path: `/api/projects/resolve?cwd=${q(`${REPO_ROOT}\0`)}`,
    expect: { status: 400, body: GIT_NULL_BYTE },
  },
  {
    name: 'GET /api/projects/resolve refuses a missing cwd',
    path: '/api/projects/resolve',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { cwd: ['Invalid input: expected string, received undefined'] },
      }),
    },
  },
  {
    // A page on another site names itself in `Referer`, which makes the request
    // another device (ADR 261015-125850 rule 1): the session gate asks it for a
    // person session, with login off, before the route reads anything.
    name: 'GET /api/projects/resolve refuses a cross-site request at the session gate before reading anything',
    path: `/api/projects/resolve?cwd=${q(REPO_ROOT)}`,
    headers: { ...CROSS_SITE, Referer: 'https://elsewhere.example/page' },
    expect: { status: 401, body: { error: 'Unauthorized', code: 'AUTH_REQUIRED' } },
  },
  {
    // The route's own refusal still stands for a cross-site request the gate
    // cannot tell apart from this computer: one that names no page.
    name: 'GET /api/projects/resolve refuses a cross-site request that names no page before reading anything',
    path: `/api/projects/resolve?cwd=${q(REPO_ROOT)}`,
    headers: CROSS_SITE,
    expect: {
      status: 403,
      schema: z.object({ code: z.literal('person_only') }).loose(),
    },
  },
  {
    name: 'GET /api/projects/resolve refuses an agent',
    path: `/api/projects/resolve?cwd=${q(REPO_ROOT)}`,
    headers: AGENT,
    expect: {
      status: 403,
      body: problemBody('person_only', {
        detail: 'DorkOS looked nothing up. Only a person can look up a project by folder.',
      }),
    },
  },

  // read cursors
  {
    name: 'GET /api/read-cursors/:kind/:id answers null for a thread never read',
    path: '/api/read-cursors/session/contract-session',
    expect: { status: 200, headers: JSON_TYPE, body: { cursor: null } },
  },
  {
    name: 'PUT /api/read-cursors/:kind/:id moves the caller’s cursor',
    method: 'PUT',
    path: '/api/read-cursors/session/contract-session',
    body: { lastReadSeq: 4 },
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: ReadCursorSchema.extend({
        threadKind: z.literal('session'),
        threadId: z.literal('contract-session'),
        lastReadSeq: z.literal(4),
      }),
    },
  },
  {
    name: 'GET /api/read-cursors/:kind/:id/ reads it back with a trailing slash (after the case above)',
    path: '/api/read-cursors/session/contract-session/',
    expect: {
      status: 200,
      schema: z.object({ cursor: ReadCursorSchema.extend({ lastReadSeq: z.literal(4) }) }),
    },
  },
  {
    name: 'PUT /api/read-cursors/:kind/:id never moves a cursor back (after the cases above)',
    method: 'PUT',
    path: '/api/read-cursors/session/contract-session',
    body: { lastReadSeq: 1 },
    expect: { status: 200, schema: ReadCursorSchema.extend({ lastReadSeq: z.literal(4) }) },
  },
  {
    name: 'GET /api/read-cursors/:kind/:id decodes the id',
    path: '/api/read-cursors/session/a%20b',
    expect: { status: 200, body: { cursor: null } },
  },
  {
    name: 'GET /api/read-cursors/:kind/:id refuses an unknown kind',
    path: '/api/read-cursors/channel/x',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: {
          kind: ['Invalid option: expected one of "room"|"session"|"inbox"|"room-thread"'],
        },
      }),
    },
  },
  {
    name: 'PUT /api/read-cursors/:kind/:id refuses a request with no body',
    method: 'PUT',
    path: '/api/read-cursors/session/contract-session',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: ['Invalid input: expected object, received undefined'],
        fieldErrors: {},
      }),
    },
  },
  {
    name: 'PUT /api/read-cursors/:kind/:id refuses a negative position',
    method: 'PUT',
    path: '/api/read-cursors/session/contract-session',
    body: { lastReadSeq: -1 },
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { lastReadSeq: ['Too small: expected number to be >=0'] },
      }),
    },
  },
  {
    name: 'PUT /api/read-cursors/room/:id answers the room’s 404 for a room the caller cannot see',
    method: 'PUT',
    path: '/api/read-cursors/room/no-such-room',
    body: { lastReadSeq: 1 },
    expect: { status: 404, schema: z.object({ code: z.literal('room_not_found') }).loose() },
  },
  {
    name: 'GET /api/read-cursors/:kind/:id refuses an agent it cannot verify',
    path: '/api/read-cursors/session/contract-session',
    headers: AGENT,
    expect: {
      status: 401,
      schema: z.object({ code: z.literal('agent_identity_unverified') }).loose(),
    },
  },
  {
    name: 'GET /api/read-cursors/:kind is not a route',
    path: '/api/read-cursors/session',
    expect: { status: 404, body: NOT_FOUND },
  },

  // session locations
  {
    name: 'POST /api/session-locations saves a folder inside the boundary',
    method: 'POST',
    path: '/api/session-locations',
    body: { cwd: REPO_ROOT },
    expect: { status: 201, headers: JSON_TYPE, schema: z.object({ id: z.uuid() }).strict() },
  },
  {
    name: 'POST /api/session-locations/ answers the saved folder again (after the case above)',
    method: 'POST',
    path: '/api/session-locations/',
    body: { cwd: REPO_ROOT },
    expect: { status: 200, schema: z.object({ id: z.uuid() }).strict() },
  },
  {
    name: 'POST /api/session-locations refuses a folder outside the boundary',
    method: 'POST',
    path: '/api/session-locations',
    body: { cwd: '/etc' },
    expect: { status: 403, body: GIT_OUTSIDE },
  },
  {
    name: 'POST /api/session-locations refuses a walk out of the boundary',
    method: 'POST',
    path: '/api/session-locations',
    body: { cwd: `${REPO_ROOT}/../..` },
    expect: { status: 403, body: GIT_OUTSIDE },
  },
  {
    name: 'POST /api/session-locations refuses a NUL byte with a 400',
    method: 'POST',
    path: '/api/session-locations',
    body: { cwd: `${REPO_ROOT}\0` },
    expect: { status: 400, body: GIT_NULL_BYTE },
  },
  {
    name: 'POST /api/session-locations refuses an unknown field',
    method: 'POST',
    path: '/api/session-locations',
    body: { cwd: REPO_ROOT, extra: true },
    expect: {
      status: 400,
      body: problemBody('invalid_request', { detail: 'Choose a valid chat folder.' }),
    },
  },
  {
    name: 'POST /api/session-locations refuses a request with no body',
    method: 'POST',
    path: '/api/session-locations',
    expect: {
      status: 400,
      body: problemBody('invalid_request', { detail: 'Choose a valid chat folder.' }),
    },
  },
  {
    name: 'GET /api/session-locations/:id answers 404 for an id that is not a UUID',
    path: '/api/session-locations/not-a-uuid',
    expect: { status: 404, body: problemBody('not_found', { detail: 'Chat folder not found.' }) },
  },
  {
    name: 'GET /api/session-locations/:id answers 404 for a UUID nobody saved',
    path: `/api/session-locations/${randomUUID()}`,
    expect: { status: 404, body: problemBody('not_found', { detail: 'Chat folder not found.' }) },
  },
  {
    name: 'GET /api/session-locations/:id refuses a cross-site request',
    path: `/api/session-locations/${randomUUID()}`,
    headers: CROSS_SITE,
    expect: {
      status: 403,
      body: problemBody('person_only', { detail: 'Open DorkOS to choose a chat folder.' }),
    },
  },
  {
    name: 'POST /api/session-locations refuses an agent',
    method: 'POST',
    path: '/api/session-locations',
    headers: AGENT,
    body: { cwd: REPO_ROOT },
    expect: {
      status: 403,
      body: problemBody('person_only', { detail: 'Only a person can choose a chat folder.' }),
    },
  },
  {
    name: 'GET /api/session-locations refuses an agent before finding no route',
    path: '/api/session-locations',
    headers: AGENT,
    expect: {
      status: 403,
      schema: z.object({ code: z.literal('person_only') }).loose(),
    },
  },
  {
    name: 'GET /api/session-locations is not a route',
    path: '/api/session-locations',
    expect: { status: 404, body: NOT_FOUND },
  },

  // templates
  {
    name: 'GET /api/templates answers the built-in catalog',
    path: '/api/templates',
    expect: { status: 200, headers: JSON_TYPE, schema: TemplateCatalogSchema },
  },
  {
    name: 'HEAD /api/templates answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/templates',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'POST /api/templates adds a template',
    method: 'POST',
    path: '/api/templates',
    body: TEMPLATE,
    expect: {
      status: 201,
      headers: JSON_TYPE,
      body: { ...TEMPLATE, builtin: false, tags: [] },
    },
  },
  {
    name: 'GET /api/templates/ lists it with a trailing slash (after the case above)',
    path: '/api/templates/',
    expect: {
      status: 200,
      schema: TemplateCatalogSchema.refine((body) =>
        body.templates.some((entry) => entry.id === TEMPLATE.id)
      ),
    },
  },
  {
    name: 'POST /api/templates refuses an id already taken (after the cases above)',
    method: 'POST',
    path: '/api/templates',
    body: TEMPLATE,
    expect: {
      status: 409,
      body: problemBody('conflict', {
        detail: `A template called '${TEMPLATE.id}' already exists. Pick another id.`,
      }),
    },
  },
  {
    name: 'POST /api/templates refuses a built-in id',
    method: 'POST',
    path: '/api/templates',
    body: { ...TEMPLATE, id: 'blank' },
    expect: {
      status: 409,
      body: problemBody('conflict', {
        detail: `A built-in template is called 'blank'. Pick another id.`,
      }),
    },
  },
  {
    name: 'POST /api/templates refuses a request with no body',
    method: 'POST',
    path: '/api/templates',
    expect: {
      status: 400,
      schema: z.object({ code: z.literal('invalid_request'), issues: z.unknown() }).loose(),
    },
  },
  {
    name: 'DELETE /api/templates/:id refuses a built-in template',
    method: 'DELETE',
    path: '/api/templates/blank',
    expect: {
      status: 403,
      body: problemBody('forbidden', { detail: 'Built-in templates can’t be deleted.' }),
    },
  },
  {
    name: 'DELETE /api/templates/:id removes a template (after the cases above)',
    method: 'DELETE',
    path: `/api/templates/${TEMPLATE.id}`,
    expect: { status: 200, headers: JSON_TYPE, body: { deleted: TEMPLATE.id } },
  },
  {
    name: 'DELETE /api/templates/:id answers 404 for a template that is gone (after the case above)',
    method: 'DELETE',
    path: `/api/templates/${TEMPLATE.id}`,
    expect: {
      status: 404,
      body: problemBody('not_found', { detail: `No template is called '${TEMPLATE.id}'.` }),
    },
  },
  {
    name: 'DELETE /api/templates/:id decodes the id',
    method: 'DELETE',
    path: '/api/templates/a%20b',
    expect: {
      status: 404,
      body: problemBody('not_found', { detail: `No template is called 'a b'.` }),
    },
  },
  {
    name: 'GET /api/templates/:id is not a route',
    path: '/api/templates/blank',
    expect: { status: 404, body: NOT_FOUND },
  },

  // harness
  {
    name: 'GET /api/harness/status reads a project’s agent files',
    path: `/api/harness/status?projectPath=${q(REPO_ROOT)}`,
    expect: { status: 200, headers: JSON_TYPE, schema: HarnessStatusResponseSchema },
  },
  {
    name: 'GET /api/harness/status refuses a missing projectPath',
    path: '/api/harness/status',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { projectPath: ['Invalid input: expected string, received undefined'] },
      }),
    },
  },
  {
    name: 'GET /api/harness/status refuses a relative projectPath',
    path: '/api/harness/status?projectPath=apps',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: [],
        fieldErrors: { projectPath: ['projectPath must be an absolute path'] },
      }),
    },
  },
  {
    name: 'GET /api/harness/status refuses a folder outside the boundary',
    path: '/api/harness/status?projectPath=/etc',
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/harness/status refuses a walk out of the boundary',
    path: `/api/harness/status?projectPath=${q(`${REPO_ROOT}/../..`)}`,
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'GET /api/harness/status refuses a NUL byte',
    path: `/api/harness/status?projectPath=${q(`${REPO_ROOT}\0`)}`,
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'GET /api/harness/status refuses a file',
    path: `/api/harness/status?projectPath=${q(path.join(REPO_ROOT, 'package.json'))}`,
    expect: { status: 400, body: { error: 'Not a directory' } },
  },
  {
    name: 'GET /api/harness/status answers 404 for a folder that does not exist',
    path: `/api/harness/status?projectPath=${q(path.join(REPO_ROOT, 'no-such-folder'))}`,
    expect: { status: 404, body: { error: 'Project directory not found' } },
  },
  {
    name: 'POST /api/harness/sync refuses a folder with nothing set up',
    method: 'POST',
    path: '/api/harness/sync',
    body: { projectPath: NO_MANIFEST },
    expect: {
      status: 409,
      body: {
        error: 'DorkOS isn’t sharing agent files for this folder yet',
        code: 'harness_not_set_up',
        message: 'Run `dorkos harness sync --fix` in this folder to set it up.',
      },
    },
  },
  {
    name: 'POST /api/harness/sync refuses a request with no body',
    method: 'POST',
    path: '/api/harness/sync',
    expect: {
      status: 400,
      body: validationProblemBody({
        formErrors: ['Invalid input: expected object, received undefined'],
        fieldErrors: {},
      }),
    },
  },
  {
    name: 'POST /api/harness/sync refuses a folder outside the boundary',
    method: 'POST',
    path: '/api/harness/sync',
    body: { projectPath: '/etc' },
    expect: { status: 403, body: OUTSIDE },
  },
  {
    name: 'POST /api/harness/sync refuses an agent before reading the body',
    method: 'POST',
    path: '/api/harness/sync',
    headers: AGENT,
    expect: {
      status: 403,
      body: {
        error: 'Only a person can sync agent files',
        code: 'operator_only_harness_sync',
        message:
          'This writes into your project and removes files DorkOS put there, so it is a ' +
          'decision a person makes in DorkOS rather than something an agent does on your behalf.',
      },
    },
  },
  {
    name: 'POST /api/harness/adopt refuses a folder with nothing set up',
    method: 'POST',
    path: '/api/harness/adopt',
    body: { projectPath: NO_MANIFEST, name: 'some-skill' },
    expect: { status: 409, schema: z.object({ code: z.literal('harness_not_set_up') }).loose() },
  },
  {
    name: 'POST /api/harness/adopt refuses a NUL byte',
    method: 'POST',
    path: '/api/harness/adopt',
    body: { projectPath: `${REPO_ROOT}\0`, name: 'some-skill' },
    expect: { status: 400, body: NULL_BYTE },
  },
  {
    name: 'POST /api/harness/adopt refuses an agent',
    method: 'POST',
    path: '/api/harness/adopt',
    headers: AGENT,
    body: { projectPath: NO_MANIFEST, name: 'some-skill' },
    expect: {
      status: 403,
      schema: z.object({ code: z.literal('operator_only_harness_adopt') }).loose(),
    },
  },
  {
    name: 'GET /api/harness/sync is not a route',
    path: '/api/harness/sync',
    expect: { status: 404, body: NOT_FOUND },
  },

  // shapes
  {
    name: 'GET /api/shapes lists the installed Shapes',
    path: '/api/shapes',
    expect: {
      status: 200,
      headers: JSON_TYPE,
      schema: z.object({ shapes: z.array(z.object({ name: z.string() }).loose()) }),
    },
  },
  {
    name: 'HEAD /api/shapes/ answers the GET’s status with no body',
    method: 'HEAD',
    path: '/api/shapes/',
    expect: { status: 200, headers: JSON_TYPE, body: '' },
  },
  {
    name: 'POST /api/shapes/:name/apply refuses a name that decodes to a traversal',
    method: 'POST',
    path: '/api/shapes/..%2F..%2Fsecret/apply',
    expect: {
      status: 400,
      body: problemBody('invalid_request', {
        detail: "'../../secret' isn’t a Shape name. Use lowercase letters, digits and dashes.",
      }),
    },
  },
  {
    name: 'POST /api/shapes/:name/apply answers 404 for a Shape that is not installed',
    method: 'POST',
    path: '/api/shapes/ghost/apply',
    expect: {
      status: 404,
      body: problemBody('not_found', { detail: "No Shape called 'ghost' is installed." }),
    },
  },
  {
    name: 'POST /api/shapes/:name/fork answers 404 for a Shape that is not installed',
    method: 'POST',
    path: '/api/shapes/ghost/fork',
    expect: {
      status: 404,
      body: problemBody('not_found', { detail: "No Shape called 'ghost' is installed." }),
    },
  },
  {
    name: 'POST /api/shapes/:name/fork refuses a target name that is not a slug',
    method: 'POST',
    path: '/api/shapes/ghost/fork',
    body: { as: '../escape' },
    expect: {
      status: 400,
      body: problemBody('invalid_request', {
        detail: "'../escape' isn’t a Shape name. Use lowercase letters, digits and dashes.",
      }),
    },
  },
  {
    name: 'POST /api/shapes/:name/fork refuses a malformed body',
    method: 'POST',
    path: '/api/shapes/ghost/fork',
    body: { captureCurrent: 'yes' },
    expect: {
      status: 400,
      schema: z.object({ code: z.literal('invalid_request'), issues: z.unknown() }).loose(),
    },
  },
  {
    name: 'GET /api/shapes/:name is not a route',
    path: '/api/shapes/ghost',
    expect: { status: 404, body: NOT_FOUND },
  },
]);

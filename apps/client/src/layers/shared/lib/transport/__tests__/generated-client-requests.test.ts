/**
 * The slices that moved onto the generated API client in DOR-5473 batch 4 send
 * exactly the requests their hand-written calls did: URL, method and body.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountSigninMethods } from '../account-signin-methods';
import { createFrameBridgeMethods } from '../frame-bridge-methods';
import { createOnboardingMethods } from '../onboarding-methods';
import { createProfileMethods } from '../profile-methods';
import { createProjectMethods } from '../project-methods';
import { createSessionLocationMethods } from '../session-location-methods';
import { createTeamMethods } from '../team-methods';
import { createWorkQueueMethods } from '../work-queue-methods';
import { answer, firstRequest } from './request-stub';

const base = '/api';

afterEach(() => vi.unstubAllGlobals());

interface Case {
  name: string;
  reply: unknown;
  send: () => Promise<unknown>;
  url: string;
  method: string;
  body?: string;
}

const cases: Case[] = [
  {
    name: 'lists projects',
    reply: { projects: [] },
    send: () => createProjectMethods(base).listProjects(),
    url: '/api/projects',
    method: 'GET',
  },
  {
    name: 'resolves a project with an escaped cwd',
    reply: { project: null },
    send: () => createProjectMethods(base).resolveProject('/my repo+2'),
    url: '/api/projects/resolve?cwd=%2Fmy+repo%2B2',
    method: 'GET',
  },
  {
    name: 'reads the team roster',
    reply: {},
    send: () => createTeamMethods(base).getTeamRoster(),
    url: '/api/team',
    method: 'GET',
  },
  {
    name: "reads a member's rooms at an encoded id",
    reply: {},
    send: () => createTeamMethods(base).listMemberRooms('a/b c'),
    url: '/api/team/a%2Fb%20c/rooms',
    method: 'GET',
  },
  {
    name: 'records the first-run pick',
    reply: { path: 'none', runtime: 'claude-code' },
    send: () => createOnboardingMethods(base).chooseFirstRunPath({ path: 'none' }),
    url: '/api/onboarding/first-run',
    method: 'POST',
    body: '{"path":"none"}',
  },
  {
    name: 'saves a chat folder',
    reply: { id: 'x' },
    send: () => createSessionLocationMethods(base).createSessionLocation('/repo'),
    url: '/api/session-locations',
    method: 'POST',
    body: '{"cwd":"/repo"}',
  },
  {
    name: 'reads a saved chat folder at an encoded id',
    reply: { cwd: '/repo' },
    send: () => createSessionLocationMethods(base).getSessionLocation('a b'),
    url: '/api/session-locations/a%20b',
    method: 'GET',
  },
  {
    name: 'reads the sign-in policy',
    reply: { deniedOrganizations: [], folders: [], accounts: [] },
    send: () => createAccountSigninMethods(base).getClaudeSigninPolicy(),
    url: '/api/runtimes/claude-code/signins',
    method: 'GET',
  },
  {
    name: 'denies an organization',
    reply: { ok: true },
    send: () =>
      createAccountSigninMethods(base).changeClaudeSigninPolicy({
        action: 'add-org',
        orgId: 'o1',
        label: 'Acme',
      }),
    url: '/api/runtimes/claude-code/signins/organizations',
    method: 'POST',
    body: '{"orgId":"o1","label":"Acme"}',
  },
  {
    name: 'allows an organization again at an encoded id',
    reply: { ok: true },
    send: () =>
      createAccountSigninMethods(base).changeClaudeSigninPolicy({
        action: 'remove-org',
        orgId: 'o 1',
      }),
    url: '/api/runtimes/claude-code/signins/organizations/o%201',
    method: 'DELETE',
  },
  {
    name: 'excludes a sign-in folder',
    reply: { ok: true },
    send: () =>
      createAccountSigninMethods(base).changeClaudeSigninPolicy({
        action: 'exclude-folder',
        accountId: 'acc',
      }),
    url: '/api/runtimes/claude-code/signins/folders',
    method: 'POST',
    body: '{"accountId":"acc"}',
  },
  {
    name: 'allows a sign-in folder again at an encoded id',
    reply: { ok: true },
    send: () =>
      createAccountSigninMethods(base).changeClaudeSigninPolicy({
        action: 'allow-folder',
        accountId: 'a/c',
      }),
    url: '/api/runtimes/claude-code/signins/folders/a%2Fc',
    method: 'DELETE',
  },
  {
    name: "asks for a page's frame-bridge status",
    reply: {},
    send: () =>
      createFrameBridgeMethods(base).getFrameBridgeStatus({
        kind: 'proxy',
        port: 5173,
        path: '/',
      }),
    url: '/api/workbench/bridge',
    method: 'POST',
    body: '{"kind":"proxy","port":5173,"path":"/"}',
  },
  {
    name: 'renames the operator',
    reply: {},
    send: () => createProfileMethods(base).updateProfile('Sam'),
    url: '/api/profile',
    method: 'PATCH',
    body: '{"displayName":"Sam"}',
  },
  {
    name: "removes the operator's avatar",
    reply: undefined,
    send: () => createProfileMethods(base).deleteProfileAvatar(),
    url: '/api/profile/avatar',
    method: 'DELETE',
  },
  {
    name: "reads an agent's work queue at an encoded id",
    reply: {},
    send: () => createWorkQueueMethods(base).getWorkQueue('a b'),
    url: '/api/agents/a%20b/work-queue',
    method: 'GET',
  },
  {
    name: "changes an agent's work-queue settings",
    reply: {},
    send: () => createWorkQueueMethods(base).updateWorkQueue('a', { enabled: true }),
    url: '/api/agents/a/work-queue',
    method: 'PATCH',
    body: '{"enabled":true}',
  },
  {
    name: 'stops every work queue',
    reply: { stopped: true },
    send: () => createWorkQueueMethods(base).setWorkQueuesStopped(true),
    url: '/api/work-queues/stop',
    method: 'PUT',
    body: '{"stopped":true}',
  },
  {
    name: 'reorders a work queue',
    reply: {},
    send: () => createWorkQueueMethods(base).reorderWorkQueue('a', ['i1', 'i2']),
    url: '/api/agents/a/work-queue/order',
    method: 'PUT',
    body: '{"itemIds":["i1","i2"]}',
  },
  {
    name: 'adds a work item',
    reply: {},
    send: () => createWorkQueueMethods(base).addWorkItem('a', { title: 'Ship', prompt: 'Ship it' }),
    url: '/api/agents/a/work-queue/items',
    method: 'POST',
    body: '{"title":"Ship","prompt":"Ship it"}',
  },
  {
    name: 'removes a work item at an encoded id',
    reply: undefined,
    send: () => createWorkQueueMethods(base).removeWorkItem('a', 'i/1'),
    url: '/api/agents/a/work-queue/items/i%2F1',
    method: 'DELETE',
  },
];

describe('transport slices on the generated client', () => {
  it.each(cases)('$name', async ({ reply, send, url, method, body }) => {
    const fetchMock =
      reply === undefined
        ? (() => {
            const mock = answer(null);
            mock.mockImplementation(async () => new Response(null, { status: 204 }));
            return mock;
          })()
        : answer(reply);
    await send();
    const sent = firstRequest(fetchMock);
    // `fetch` sends GET when no method is named.
    expect({ url: sent.url, method: sent.method ?? 'GET', body: sent.body }).toEqual({
      url,
      method,
      body,
    });
  });
});

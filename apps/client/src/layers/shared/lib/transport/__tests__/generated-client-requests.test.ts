/**
 * The calls that moved onto the generated API client (DOR-5473) send exactly
 * the requests their hand-written calls did: method, URL and body (each key
 * below), JSON typing, the cookie, and the window's own `X-Client-Id` header
 * where one was sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountSigninMethods } from '../account-signin-methods';
import { createComputerMethods } from '../computer-methods';
import { createFrameBridgeMethods } from '../frame-bridge-methods';
import { createOnboardingMethods } from '../onboarding-methods';
import { createPermissionMethods } from '../permission-methods';
import { createProfileMethods } from '../profile-methods';
import { createProjectMethods } from '../project-methods';
import { createQueuedChatMethods } from '../queued-chat-methods';
import { createRemoteAccessMethods } from '../remote-access-methods';
import { createSessionLocationMethods } from '../session-location-methods';
import { createTasksMethods } from '../task-methods';
import { createTeamMethods } from '../team-methods';
import { createWorkQueueMethods } from '../work-queue-methods';
import { answer } from './request-stub';

afterEach(() => vi.unstubAllGlobals());

const base = '/api';
const window1 = () => 'window-1';
const computer = createComputerMethods(base, window1);
const perms = createPermissionMethods(base);
const signin = createAccountSigninMethods(base);
const profile = createProfileMethods(base);
const tasks = createTasksMethods(base);
const queue = createWorkQueueMethods(base);
const locations = createSessionLocationMethods(base);
const input = {
  leaseId: 'l1',
  generation: 2,
  kind: 'pointer',
  x: 1,
  y: 2,
  action: 'move',
} as const;

/** Calls that name this window in their own `X-Client-Id` header. */
const ownHeader: Record<string, () => Promise<unknown>> = {
  'GET /api/computers': () => computer.getComputer(),
  'POST /api/computers': () => computer.createComputer(),
  'POST /api/computers/start': () => computer.startComputer(),
  'POST /api/computers/stop': () => computer.stopComputer(),
  'POST /api/computers/sign-in': () => computer.signInComputer(),
  'POST /api/computers/sessions': () => computer.createComputerSession(),
  'POST /api/computers/control': () => computer.acquireComputerControl(),
  'DELETE /api/computers/control {"leaseId":"l1"}': () => computer.releaseComputerControl('l1'),
  [`POST /api/computers/input ${JSON.stringify(input)}`]: () => computer.sendComputerInput(input),
  'GET /api/computers/frame': () => computer.getComputerFrame(),
  // Both ids are escaped now; the hand-written call sent the session id raw.
  'POST /api/sessions/chat%20a/queue/m%2F1/steer': () =>
    createQueuedChatMethods(base, window1).steerQueuedChatMessage('chat a', 'm/1'),
};

const plain: Record<string, () => Promise<unknown>> = {
  'GET /api/projects': () => createProjectMethods(base).listProjects(),
  'GET /api/projects/resolve?cwd=%2Fmy+repo%2B2': () =>
    createProjectMethods(base).resolveProject('/my repo+2'),
  'GET /api/team': () => createTeamMethods(base).getTeamRoster(),
  'GET /api/team/a%2Fb%20c/rooms': () => createTeamMethods(base).listMemberRooms('a/b c'),
  'POST /api/onboarding/first-run {"path":"none"}': () =>
    createOnboardingMethods(base).chooseFirstRunPath({ path: 'none' }),
  'POST /api/onboarding/welcome': () => createOnboardingMethods(base).postOnboardingWelcome(),
  'POST /api/session-locations {"cwd":"/repo"}': () => locations.createSessionLocation('/repo'),
  'GET /api/session-locations/a%20b': () => locations.getSessionLocation('a b'),
  'POST /api/workbench/bridge {"kind":"proxy","port":5173,"path":"/"}': () =>
    createFrameBridgeMethods(base).getFrameBridgeStatus({ kind: 'proxy', port: 5173, path: '/' }),
  'POST /api/remote-access/enrolment': () => createRemoteAccessMethods(base).startRemoteEnrolment(),
  // Sign-in: the account pin lives only in the body; no pin means no body (DOR-1651).
  'POST /api/runtimes/claude-code/login {"accountId":"two"}': () =>
    signin.delegateRuntimeLogin('claude-code', { accountId: 'two' }),
  'POST /api/runtimes/codex/login': () => signin.delegateRuntimeLogin('codex', {}),
  'GET /api/runtimes/claude-code/signins': () => signin.getClaudeSigninPolicy(),
  'POST /api/runtimes/claude-code/signins/organizations {"orgId":"o1","label":"Acme"}': () =>
    signin.changeClaudeSigninPolicy({ action: 'add-org', orgId: 'o1', label: 'Acme' }),
  'DELETE /api/runtimes/claude-code/signins/organizations/o%201': () =>
    signin.changeClaudeSigninPolicy({ action: 'remove-org', orgId: 'o 1' }),
  'POST /api/runtimes/claude-code/signins/folders {"accountId":"acc"}': () =>
    signin.changeClaudeSigninPolicy({ action: 'exclude-folder', accountId: 'acc' }),
  'DELETE /api/runtimes/claude-code/signins/folders/a%2Fc': () =>
    signin.changeClaudeSigninPolicy({ action: 'allow-folder', accountId: 'a/c' }),
  'POST /api/runtimes/claude-code/signins/a%2Fc/accept': () =>
    signin.changeClaudeSigninPolicy({ action: 'accept', accountId: 'a/c' }),
  // Profile.
  'PATCH /api/profile {"displayName":"Sam"}': () => profile.updateProfile('Sam'),
  'DELETE /api/profile/avatar': () => profile.deleteProfileAvatar(),
  'POST /api/profile/identities/m%2F1': () => profile.setIdentityLinkedToMe('m/1', true),
  'DELETE /api/profile/identities/m%2F1': () => profile.setIdentityLinkedToMe('m/1', false),
  // Work queues.
  'GET /api/agents/a%20b/work-queue': () => queue.getWorkQueue('a b'),
  'PATCH /api/agents/a/work-queue {"enabled":true}': () =>
    queue.updateWorkQueue('a', { enabled: true }),
  'PUT /api/work-queues/stop {"stopped":true}': () => queue.setWorkQueuesStopped(true),
  'PUT /api/agents/a/work-queue/order {"itemIds":["i1","i2"]}': () =>
    queue.reorderWorkQueue('a', ['i1', 'i2']),
  'POST /api/agents/a/work-queue/items {"title":"Ship","prompt":"Ship it"}': () =>
    queue.addWorkItem('a', { title: 'Ship', prompt: 'Ship it' }),
  'DELETE /api/agents/a/work-queue/items/i%2F1': () => queue.removeWorkItem('a', 'i/1'),
  'POST /api/agents/a%201/work-queue/items/i%2F1/requeue': () =>
    queue.requeueWorkItem('a 1', 'i/1'),
  // Tasks. `null` clears a schedule's effort, so it must reach the server as `null`.
  'GET /api/tasks': () => tasks.listTasks(),
  // The task id is escaped now; the hand-written call sent it raw.
  'PATCH /api/tasks/task%20a {"effort":null}': () => tasks.updateTask('task a', { effort: null }),
  'DELETE /api/tasks/t1': () => tasks.deleteTask('t1'),
  'POST /api/tasks/t1/approve-file {"hash":"h1"}': () => tasks.approveTaskFile('t1', null, 'h1'),
  'POST /api/tasks/t1/approve-file {"capAt":"2026-01-01T00:00:00Z","hash":"h1"}': () =>
    tasks.approveTaskFile('t1', '2026-01-01T00:00:00Z', 'h1'),
  'GET /api/tasks/runs?scheduleId=t1&status=failed&limit=5&offset=10': () =>
    tasks.listTaskRuns({ scheduleId: 't1', status: 'failed', limit: 5, offset: 10 }),
  'GET /api/tasks/runs': () => tasks.listTaskRuns(),
  'GET /api/tasks/runs/r1': () => tasks.getTaskRun('r1'),
  'POST /api/tasks/t1/trigger': () => tasks.triggerTask('t1', {}),
  'POST /api/tasks/t1/trigger {"permissionMode":"acceptEdits"}': () =>
    tasks.triggerTask('t1', { permissionMode: 'acceptEdits' }),
  'POST /api/tasks/runs/r1/cancel': () => tasks.cancelTaskRun('r1'),
  // Permissions. `null` puts an area back to its default, so it must reach the server.
  'GET /api/permissions': () => perms.getPermissions(),
  'GET /api/agents/agent%201/permissions': () => perms.getAgentPermissions('agent 1'),
  'GET /api/agents/agent%2F1/level': () => perms.getAgentLevel('agent/1'),
  'PATCH /api/agents/agent%201/permissions {"areas":{"files":null,"web":"ask"},"surface":"agent-page"}':
    () =>
      perms.patchAgentPermissions('agent 1', {
        areas: { files: null, web: 'ask' },
        surface: 'agent-page',
      }),
  'PUT /api/permissions/preset {"preset":"balanced","surface":"settings"}': () =>
    perms.setPermissionPreset({ preset: 'balanced', surface: 'settings' }),
  'PATCH /api/permissions/defaults {"areas":{"files":null},"surface":"settings"}': () =>
    perms.patchPermissionDefaults({ areas: { files: null }, surface: 'settings' }),
  'GET /api/permissions/history': () => perms.getPermissionHistory(),
  'GET /api/permissions/history?cursor=c': () =>
    perms.getPermissionHistory({ agentId: '', cursor: 'c', limit: 0 }),
  'GET /api/permissions/history?agentId=a+1&cursor=c&limit=5': () =>
    perms.getPermissionHistory({ agentId: 'a 1', cursor: 'c', limit: 5 }),
  'POST /api/permissions/history/e%2F1/undo {}': () => perms.undoPermissionChange('e/1'),
};

describe('calls on the generated client', () => {
  it.each([
    ...Object.entries(ownHeader).map(([sent, call]) => [sent, call, 'window-1'] as const),
    ...Object.entries(plain).map(([sent, call]) => [sent, call, null] as const),
  ])('%s', async (sent, call, clientId) => {
    const fetchMock = answer({});
    // `{}` may not parse as the method's answer; only the request matters here.
    await call().catch(() => undefined);
    const [url, init] = fetchMock.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    const body = init?.body === undefined ? '' : ` ${String(init.body)}`;
    expect(`${init?.method ?? 'GET'} ${String(url)}${body}`).toBe(sent);
    expect(headers.get('X-Client-Id')).toBe(clientId);
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(init?.credentials).toBe('include');
  });
});

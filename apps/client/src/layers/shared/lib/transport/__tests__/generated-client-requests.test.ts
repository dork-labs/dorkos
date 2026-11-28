/**
 * The calls that moved onto the generated API client (DOR-5473) send exactly
 * the requests their hand-written calls did: method, URL and body (each key
 * below), JSON typing, the cookie, and the window's own `X-Client-Id` header
 * where one was sent.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAccountSigninMethods } from '../account-signin-methods';
import { createCloudMethods } from '../cloud-methods';
import { createComputerMethods } from '../computer-methods';
import { createConnectorMethods } from '../connector-methods';
import { createFrameBridgeMethods } from '../frame-bridge-methods';
import { createGlobalMcpMethods } from '../global-mcp-methods';
import { createMcpMethods } from '../mcp-methods';
import { createOnboardingMethods } from '../onboarding-methods';
import { createPermissionMethods } from '../permission-methods';
import { createProfileMethods } from '../profile-methods';
import { createProjectMethods } from '../project-methods';
import { createQueuedChatMethods } from '../queued-chat-methods';
import { createRelayMethods } from '../relay-methods';
import { createRemoteAccessMethods } from '../remote-access-methods';
import { createSessionLocationMethods } from '../session-location-methods';
import { createSystemMethods } from '../system-methods';
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
const cloud = createCloudMethods(base);
const system = createSystemMethods(base);
const conn = createConnectorMethods(base);
const relay = createRelayMethods(base, window1);
const mcp = createMcpMethods(base);
const stdio = { transport: 'stdio' as const, command: 'npx', args: [], env: {} };
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
  'GET /api/projects/lookup?cwd=%2Fmy+repo%2B2': () =>
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
  'POST /api/remote-access/mode {"mode":"managed"}': () =>
    createRemoteAccessMethods(base).setRemoteAccessMode('managed'),
  'POST /api/lan-access {"enabled":false}': () =>
    createRemoteAccessMethods(base).setLanAccess(false),
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
  'PUT /api/work-queues/stopped {"stopped":true}': () => queue.setWorkQueuesStopped(true),
  'PUT /api/agents/a/work-queue/order {"itemIds":["i1","i2"]}': () =>
    queue.reorderWorkQueue('a', ['i1', 'i2']),
  'POST /api/agents/a/work-queue/items {"title":"Ship","prompt":"Ship it"}': () =>
    queue.addWorkItem('a', { title: 'Ship', prompt: 'Ship it' }),
  'DELETE /api/agents/a/work-queue/items/i%2F1': () => queue.removeWorkItem('a', 'i/1'),
  'PATCH /api/agents/a%201/work-queue/items/i%2F1 {"status":"queued"}': () =>
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
  'PATCH /api/tasks/runs/r1 {"status":"cancelled"}': () => tasks.cancelTaskRun('r1'),
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
  // Cloud. The bodyless writes send no body, as they always have.
  'POST /api/cloud/link/start': () => cloud.startCloudLink(),
  'GET /api/cloud/link/status': () => cloud.getCloudLinkStatus(),
  'POST /api/cloud/link/cancel': () => cloud.cancelCloudLink(),
  'POST /api/cloud/unlink': () => cloud.unlinkCloud(),
  'GET /api/cloud/status': () => cloud.getCloudStatus(),
  'POST /api/cloud/link/check': () => cloud.checkCloudLink(),
  'GET /api/cloud/offers': () => cloud.getCloudOffers(),
  'POST /api/cloud/seats/s%2F1/assign {"subject":{"kind":"user","id":"u1"}}': () =>
    cloud.assignCloudSeat('s/1', { kind: 'user', id: 'u1' }),
  'POST /api/cloud/billing/portal {}': () => cloud.createCloudBillingSession('portal'),
  'POST /api/cloud/billing/checkout {"skuId":"k1"}': () =>
    cloud.createCloudBillingSession('checkout', 'k1'),
  'POST /api/cloud/account/export': () => cloud.requestCloudAccountExport(),
  'POST /api/cloud/account/deletion': () => cloud.requestCloudAccountDeletion(),
  'PUT /api/cloud/credits/default {"runtime":"codex","useCredits":true}': () =>
    cloud.setCloudCreditsDefault('codex', true),
  'POST /api/cloud/communities {"idempotencyKey":"k","name":"Team"}': () =>
    cloud.startHostedCommunity({ idempotencyKey: 'k', name: 'Team' }),
  'POST /api/cloud/communities/c%2F1/keep {"expectedHeldCommunityIds":["c2"]}': () =>
    cloud.keepHostedCommunity('c/1', ['c2']),
  'POST /api/cloud/communities/c%2F1/restore': () => cloud.restoreHostedCommunity('c/1'),
  'POST /api/cloud/communities/moves/m%2F1/upload': () =>
    cloud.retryHostedCommunityMoveUpload('m/1'),
  // Connectors. A paged list asks for its first page at the full page size.
  'GET /api/connectors/providers': () => conn.getConnectorProviders(),
  'PUT /api/connectors/providers/a%2Fb/credential {"secret":"s"}': () =>
    conn.putConnectorCredential('a/b', 's'),
  'DELETE /api/connectors/providers/a%2Fb/credential': () => conn.deleteConnectorCredential('a/b'),
  'GET /api/connectors/catalog?q=work+mail&cursor=n%2Fp&limit=25': () =>
    conn.getConnectorCatalog({ query: 'work mail', cursor: 'n/p', limit: 25 }),
  'GET /api/connectors/connections?limit=200': () => conn.getConnectorConnections(),
  'GET /api/connectors/connections/c%2F1': () => conn.getConnectorConnection('c/1'),
  'GET /api/connectors/connections/c%2F1/events/definitions?cursor=x%2Fy': () =>
    conn.listConnectionEventDefinitions('c/1', 'x/y'),
  'GET /api/connectors/connections/c%2F1/events/subscriptions': () =>
    conn.listConnectionEventSubscriptions('c/1'),
  'POST /api/connectors/connections/c%2F1/events/subscriptions {"definitionId":"d"}': () =>
    conn.createConnectionEventSubscription('c/1', { definitionId: 'd' } as never),
  'DELETE /api/connectors/connections/c%2F1/events/subscriptions/s%2F1': () =>
    conn.deleteConnectionEventSubscription('c/1', 's/1'),
  'GET /api/connectors/connections/c%2F1/events/source': () => conn.getConnectionEventSource('c/1'),
  'PUT /api/connectors/connections/c%2F1/events/source {"webhookSecret":"w"}': () =>
    conn.configureConnectionEventSource('c/1', { webhookSecret: 'w' } as never),
  'POST /api/connectors/connections {"toolkit":"gmail","idempotencyKey":"k"}': () =>
    conn.startConnectorAuthentication({ toolkit: 'gmail', idempotencyKey: 'k' } as never),
  'GET /api/connectors/authentication-flows/f%2F1': () => conn.pollConnectorAuthentication('f/1'),
  'PATCH /api/connectors/connections/c%2F1 {"label":"Work"}': () =>
    conn.renameConnectorConnection('c/1', { label: 'Work' }),
  'POST /api/connectors/connections/c%2F1/reconnect {"idempotencyKey":"k"}': () =>
    conn.reconnectConnectorConnection('c/1', { idempotencyKey: 'k' } as never),
  'GET /api/connectors/connections/c%2F1/disconnect-impact': () =>
    conn.getConnectorDisconnectImpact('c/1'),
  'GET /api/connectors/apps/g%2Fm/actions?providerInstanceId=p+1': () =>
    conn.getConnectorAppActions('g/m', 'p 1'),
  'DELETE /api/connectors/connections/c%2F1': () => conn.disconnectConnectorConnection('c/1'),
  'GET /api/connectors/agents/a%2F1/connections?limit=200': () =>
    conn.getAgentConnectorConnections('a/1'),
  'GET /api/connectors/every-agent-grants?limit=200': () => conn.getEveryAgentConnectorGrants(),
  'GET /api/connectors/sessions/s%2F1/connections?limit=200': () =>
    conn.getSessionConnectorConnections('s/1'),
  'PUT /api/connectors/sessions/s%2F1/connections/c%2F1 {"on":false}': () =>
    conn.setSessionConnectorAccess('s/1', 'c/1', { on: false }),
  'GET /api/connectors/accessible?agentId=a%2F1': () =>
    conn.getAccessibleConnectorConnections('a/1'),
  'GET /api/connectors/accessible/c%2F1/operations?agentId=a%2F1': () =>
    conn.getAccessibleConnectorOperations('a/1', 'c/1' as never),
  'POST /api/connectors/executions {"agentId":"a"}': () =>
    conn.executeConnector({ agentId: 'a' } as never),
  'GET /api/connectors/usage/agent?agentId=a&cursor=c&limit=5': () =>
    conn.getAgentConnectorUsage({ agentId: 'a', cursor: 'c', limit: 5 }),
  'GET /api/connectors/usage/operator?connectionId=c': () =>
    conn.getOperatorConnectorUsage({ connectionId: 'c' as never }),
  'POST /api/connectors/reconciliation/previews {"connectionId":"c"}': () =>
    conn.previewConnectorReconciliation({ connectionId: 'c' } as never),
  'POST /api/connectors/reconciliation/apply {"previewId":"p"}': () =>
    conn.applyConnectorReconciliation({ previewId: 'p' } as never),
  'DELETE /api/connectors/connections/c%2F1/every-agent': () =>
    conn.stopSharingConnectorWithEveryAgent('c/1'),
  'POST /api/connectors/reviews {"reason":"r"}': () =>
    conn.createConnectorManagementReview({ reason: 'r' } as never),
  'GET /api/connectors/reviews?state=pending&limit=200': () =>
    conn.getConnectorManagementReviews('pending'),
  'GET /api/connectors/reviews/r%2F1': () => conn.getConnectorManagementReview('r/1'),
  'POST /api/connectors/reviews/r%2F1/decision {"decision":"denied"}': () =>
    conn.resolveConnectorManagementReview('r/1', { decision: 'denied' }),
  'POST /api/connectors/agent-requests/q%2F1/decision {"decision":"denied"}': () =>
    conn.resolveConnectorAgentRequest('q/1', { decision: 'denied' }),
  'POST /api/connectors/agent-requests/q%2F1/authentication-flows {"label":"Work"}': () =>
    conn.startConnectorAgentRequestAuthentication('q/1', { label: 'Work' } as never),
  'GET /api/connectors/agent-requests/q%2F1/authentication-flows/f%2F1': () =>
    conn.pollConnectorAgentRequestAuthentication('q/1', 'f/1'),
  'GET /api/connectors/access-changes/x%2F1': () => conn.getAccessChange('x/1'),
  // Files, diffs and system reads. A flag goes out only when it is on.
  'GET /api/directory?path=%2Fa+b&showHidden=true': () => system.browseDirectory('/a b', true),
  'GET /api/directory': () => system.browseDirectory(undefined, false),
  'GET /api/directory/default': () => system.getDefaultCwd(),
  'GET /api/files/content?cwd=%2Fr&path=a+b.md': () => system.readFileContent('/r', 'a b.md'),
  'GET /api/diff/baseline?cwd=%2Fr&path=a&sessionId=s1&mode=head': () =>
    system.readDiffBaseline('/r', 'a', 's1', 'head'),
  'POST /api/diff/baseline/advance {"cwd":"/r","path":"a","sessionId":"s1"}': () =>
    system.advanceDiffBaseline('/r', 'a', 's1'),
  'POST /api/diff/revert {"cwd":"/r","path":"a","sessionId":"s1"}': () =>
    system.revertDiffBaseline('/r', 'a', 's1'),
  'POST /api/files {"cwd":"/r","path":"d","type":"dir"}': () =>
    system.createEntry('/r', 'd', 'dir'),
  'POST /api/files {"cwd":"/r","path":"f","type":"file","content":"x"}': () =>
    system.createEntry('/r', 'f', 'file', 'x'),
  'DELETE /api/files?cwd=%2Fr&path=d&recursive=true': () =>
    system.deleteEntry('/r', 'd', { recursive: true }),
  'DELETE /api/files?cwd=%2Fr&path=f': () => system.deleteEntry('/r', 'f'),
  'POST /api/files/rename {"cwd":"/r","from":"a","to":"b"}': () =>
    system.renameEntry('/r', 'a', 'b'),
  'POST /api/files/reveal {"cwd":"/r","path":"a"}': () => system.revealEntry('/r', 'a'),
  'GET /api/commands?refresh=true&cwd=%2Fr&sessionId=s1&runtime=codex': () =>
    system.getCommands(true, '/r', { sessionId: 's1', runtime: 'codex' }),
  'GET /api/commands': () => system.getCommands(),
  'GET /api/health': () => system.health(),
  'GET /api/keep-awake': () => system.getKeepAwake(),
  'GET /api/templates': () => system.getTemplates(),
  'POST /api/config/mcp/rotate-token': () => system.rotateMcpLocalToken(),
  'POST /api/config/mcp/reveal-token': () => system.revealMcpLocalToken(),
  // Relay connections. A paged list asks for its first page at the full page size.
  'GET /api/relay/adapters?limit=200': () => relay.listRelayAdapters(),
  'GET /api/relay/adapters/catalog?limit=200': () => relay.getAdapterCatalog(),
  'GET /api/relay/bindings?limit=200': () => relay.getBindings(),
  'POST /api/relay/adapters {"type":"telegram","id":"t 1","config":{"token":"x"}}': () =>
    relay.addRelayAdapter('telegram', 't 1', { token: 'x' }),
  'PATCH /api/relay/adapters/t%2F1/config {"config":{"token":"x"}}': () =>
    relay.updateRelayAdapterConfig('t/1', { token: 'x' }),
  // Managed MCP servers. The path-only verbs have always sent `{}`, and still do.
  'GET /api/agents/a%2F1/mcp-servers?limit=200': () => mcp.listAgentMcpServers('a/1'),
  [`POST /api/agents/a%2F1/mcp-servers {"name":"fs","connection":${JSON.stringify(stdio)}}`]: () =>
    mcp.addAgentMcpServer({ agentId: 'a/1', name: 'fs', connection: stdio }),
  'POST /api/agents/a/mcp-servers/s%2F1/import {}': () =>
    mcp.importAgentMcpServer({ agentId: 'a', name: 's/1' }),
  'PATCH /api/agents/a/mcp-servers/s%2F1 {"enabled":false}': () =>
    mcp.updateAgentMcpServer({ agentId: 'a', name: 's/1', enabled: false }),
  'DELETE /api/agents/a/mcp-servers/s%2F1': () => mcp.removeAgentMcpServer('a', 's/1'),
  'POST /api/agents/a/mcp-servers/s%2F1/enable {}': () => mcp.enableAgentMcpServer('a', 's/1'),
  'POST /api/agents/a/mcp-servers/s%2F1/disable {}': () => mcp.disableAgentMcpServer('a', 's/1'),
  'POST /api/agents/a/mcp-servers/s%2F1/test {}': () => mcp.testAgentMcpServer('a', 's/1'),
  'PUT /api/agents/a/mcp-servers/s%2F1/client {"clientId":"c"}': () =>
    mcp.setMcpClientCredentials('a', 's/1', { clientId: 'c', clientSecret: '' }),
  'PUT /api/agents/a/mcp-servers/s%2F1/client {"clientId":"c","clientSecret":"k"}': () =>
    mcp.setMcpClientCredentials('a', 's/1', { clientId: 'c', clientSecret: 'k' }),
  'POST /api/mcp-servers/s%2F1/tools': () =>
    createGlobalMcpMethods(base).checkGlobalMcpServerTools('s/1'),
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

describe('a managed MCP change a person confirms', () => {
  type Opts = { approvalToken?: string };
  it.each([
    ['add', (o: Opts) => mcp.addAgentMcpServer({ agentId: 'a', name: 'f', connection: stdio }, o)],
    ['import', (o: Opts) => mcp.importAgentMcpServer({ agentId: 'a', name: 'f' }, o)],
    ['update', (o: Opts) => mcp.updateAgentMcpServer({ agentId: 'a', name: 'f' }, o)],
  ])('%s carries the approval token, and only on the retry', async (_verb, call) => {
    const fetchMock = answer([]);
    await call({});
    await call({ approvalToken: 't-1' });
    const [first, retry] = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers));
    expect(first!.has('X-DorkOS-Approval')).toBe(false);
    expect(retry!.get('X-DorkOS-Approval')).toBe('t-1');
    expect(retry!.get('Content-Type')).toBe('application/json');
  });
});

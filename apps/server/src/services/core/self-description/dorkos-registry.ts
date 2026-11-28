/**
 * The single composition root for DorkOS's Capability Registry (spec
 * `capability-registry`, task 2.3).
 *
 * {@link composeDorkOsCapabilityRegistry} folds the migrated domains — operator,
 * marketplace, and the self-description domain — into ONE immutable registry.
 * Composing them together (rather than one registry per surface) is what restores
 * cross-domain duplicate detection: a tool name or capability id claimed by two
 * different domains throws at boot. It then back-writes the composed registry onto
 * the shared dependency bag so `capabilities.list` can serialize the registry it
 * belongs to (the late-binding self-reference; see `capabilities-domain.ts`).
 *
 * A domain is included only when its service handles are present in `deps`:
 * `operatorDeps` gates the operator domain, `marketplaceDeps` the marketplace
 * domain, `roomDeps` the rooms domain, `sessionCompactionDeps` the session
 * domain, `chatMessageDeps` the chat domain, `auditDeps` the audit domain, `agentPauseDeps` the agent pause domain, `linkDeps` the link domain, `localBrowserDeps` the local browser domain, and the memory, `ui` and self-description
 * domains are always present. Every included
 * domain's `assertDeps` runs inside `composeRegistry`, so a domain admitted
 * without its deps fails fast at boot.
 *
 * @module services/core/self-description/dorkos-registry
 */
import { noopLogger } from '@dorkos/shared/logger';

import {
  composeRegistry,
  isTrustedCaller,
  type CapabilityDeps,
  type CapabilityDomain,
  type CapabilityInvocationObserver,
  type CapabilityRegistry,
} from '../capabilities/index.js';
import { operatorDomain } from '../operator/operator-capabilities.js';
import { operatorActivityDomain } from '../../activity/activity-capability.js';
import { marketplaceDomain } from '../../marketplace-mcp/marketplace-capabilities.js';
import { marketplaceReadsDomain } from '../../marketplace/doors/marketplace-read-capabilities.js';
import { connectorDomain } from '../../connectors/connector-capabilities.js';
import { connectorExecutionDomain } from '../../connectors/execution/execution-capabilities.js';
import { connectorHoldDomain } from '../../connectors/execution/hold-capabilities.js';
import { mcpDomain } from '../../mesh/mcp-capabilities.js';
import { roomsDomain } from '../../rooms/room-capabilities.js';
import { memoryDomain } from '../../memory/memory-capabilities.js';
import { sessionDomain } from '../../session/agent-compaction/compaction-capabilities.js';
import { chatDomain } from '../../session/chat-messages/chat-capabilities.js';
import { todoPromisesDomain } from '../../todos/todo-promise-capabilities.js';
import { env } from '../../../env.js';
import { todosDomain } from '../../todos/todo-capabilities.js';
import { todoPromiseHttpDomain, todoViewDomain } from '../../todos/todo-http-capabilities.js';
import { todoPromiseWriteDomain, todoWriteDomain } from '../../todos/todo-write-capabilities.js';
import { workQueueDomain } from '../../work-queue/work-queue-capabilities.js';
import { workQueuePersonDomain } from '../../work-queue/work-queue-person-capabilities.js';
import { meshDomain } from '../../mesh/doors/mesh-capabilities.js';
import { globalMcpPersonDomain } from '../../mesh/global-mcp/global-mcp-person-capabilities.js';
import { connectionOwnerDomain } from '../../connectors/resources/owner-capabilities.js';
import { connectionManagementDomain } from '../../connectors/resources/owner-management-capabilities.js';
import { connectionListDomain } from '../../connectors/owner-lists/owner-list-capabilities.js';
import { extensionPersonDomain } from '../../extensions/http-capabilities/extension-person-capabilities.js';
import { workClaimDomain } from '../../session/claims/work-claim-capabilities.js';
import { workGraphDomain } from '../../work-graph/work-graph-capabilities.js';
import { heartbeatDomain } from '../../heartbeats/heartbeat-capabilities.js';
import { runsDomain } from '../../runs/run-capabilities.js';
import { taskViewDomain } from '../../tasks/view/task-view-capabilities.js';
import { createSessionReadsDomain } from '../../session/reads/session-read-capabilities.js';
import { auditTrail } from '../../audit/audit-trail.js';
import { runtimeRegistry } from '../runtime-registry.js';
import { runtimeReadsDomain } from '../runtime-doors/runtime-read-capabilities.js';
import { computerReadsDomains } from '../runtime-doors/computer-read-capabilities.js';
import { filesDomain } from '../directory/file-capabilities.js';
import { uiDomain } from '../../session/browser-seat/ui-capabilities.js';
import { capabilitiesDomain } from './capabilities-domain.js';
import { instructionsDomain } from '../../runtimes/context-preview/instructions-capability.js';
import { permissionsDomain } from '../permissions/permission-capabilities.js';
import { permissionViewsDomain } from '../permissions/agent-permission-views.js';
import { auditDomain, readerFor } from '../../audit/audit-capabilities.js';
import { readableSessionIds } from '../../audit/session-visibility.js';
import { chatTitleOf } from '../../session/chat-messages/chat-message-wiring.js';
import { chatHoldsOutsideText } from '../turn-power/chat-outside-words.js';
import { markCallerTurnOutsider } from '../capabilities/mark-caller-turn.js';
import { createWorkGraphReadDomain } from '../../work-graph/reads/work-graph-read-capabilities.js';
import { agentPauseDomain } from '../../mesh/pause/pause-capabilities.js';
import { approvalsDomain } from '../approvals/approval-withdraw-capability.js';
import { linkDomain } from '../links/link-capabilities.js';
import { createLocalBrowserDomain } from '../../session/local-browser/capabilities.js';
import { directoryDomain } from '../directory/directory-capabilities.js';
import { diffDomain } from '../../diff/diff-capabilities.js';
import { workspacesDomain } from '../../workspace/workspace-capabilities.js';
import { templatesDomain } from '../agent-templates/template-catalog.js';
import { sessionRelayDomain } from '../session-relay-doors/session-relay-capabilities.js';

/**
 * The work graph's reads (DOR-4970), handed what they take from other domains
 * here, at the composition root: the audit read side's reader rule, a chat's
 * title and whether it holds outside words, the turn mark, and whether a call
 * names a person (DOR-4972's read reads a caller nobody named as no owner). Each is read
 * when a call runs, never when this module loads.
 */
export const workGraphReadDomain = createWorkGraphReadDomain({
  readerOf: (audit, context) => readerFor(audit, context),
  readable: (reader, chatIds) => readableSessionIds(reader, chatIds),
  titleOf: (chatId) => chatTitleOf(chatId),
  holdsOutsideText: (chatId) => chatHoldsOutsideText(chatId),
  markOutside: (context) => markCallerTurnOutsider(context, { kind: 'chat' }),
  // A userId is not proof of the person: a program key resolves to one, and so do `/mcp`
  // calls and an agent's tool call in a chat (Security, DOR-4972).
  namesPerson: (context) =>
    context?.request?.personOnRestPath === true || isTrustedCaller(context?.trusted),
});

/**
 * The app's chat reads (DOR-4978), handed the session read guard's rule and the
 * runtime registry's two lookups here, at the composition root. Each is read
 * when a call runs, never when this module loads.
 */
export const sessionReadsDomain = createSessionReadsDomain({
  mayRead: (context, chatId) =>
    readableSessionIds(readerFor({ accounts: auditTrail()?.accounts }, context), [chatId]).has(
      chatId
    ),
  runtimeTypeOf: (chatId) => runtimeRegistry.getSessionRuntimeType(chatId),
  settingsOf: (chatId) => runtimeRegistry.getSessionSettings(chatId),
});

/**
 * Compose the whole DorkOS capability registry from whichever domains `deps`
 * enables, then back-write it onto `deps` for the self-description capability.
 *
 * @param deps - The boot-time dependency bag. `operatorDeps` includes the
 *   operator domain; `marketplaceDeps` the marketplace domain; `connectorDeps`
 *   the connector domain; `mcpDeps` the MCP-server-management domain; `roomDeps`
 *   the rooms domain; the self-description domain is always included. The composed
 *   registry is written back onto `deps.registry`.
 * @param onInvocation - Optional observer called after every invocation. Boot
 *   passes the Activity attribution observer so an identified agent's calls are
 *   recorded in the feed (spec `agent-trust` §3.1); omitted in unit tests.
 * @returns The frozen, ready-to-serve registry.
 */
export function composeDorkOsCapabilityRegistry(
  deps: CapabilityDeps,
  onInvocation?: CapabilityInvocationObserver
): CapabilityRegistry {
  const domains: CapabilityDomain[] = [];
  // The feed is on every server; `operatorDomain` carries it when it starts.
  if (deps.operatorDeps) domains.push(operatorDomain);
  else if (deps.activityDeps) domains.push(operatorActivityDomain);
  // The tools, and the reads on `/api/marketplace/*` over the same services (DOR-4978).
  if (deps.marketplaceDeps) domains.push(marketplaceDomain, marketplaceReadsDomain);
  if (deps.connectorDeps) domains.push(connectorDomain);
  if (deps.connectorExecutionDeps) domains.push(connectorExecutionDomain, connectorHoldDomain);
  if (deps.mcpDeps) domains.push(mcpDomain);
  // The MCP servers a person adds for every agent, on `/api/mcp-servers` (DOR-4978).
  if (deps.globalMcpPersonDeps) domains.push(globalMcpPersonDomain);
  // The owner's connection doors, on `/api/connectors` behind the account-decision bar (DOR-4978).
  if (deps.connectionOwnerDeps) {
    domains.push(connectionOwnerDomain, connectionManagementDomain, connectionListDomain);
  }
  // The person's extension doors, on `/api/extensions` behind the person bar (DOR-4978).
  if (deps.extensionPersonDeps) domains.push(extensionPersonDomain);
  // Chat from the web, on `/api/session-relay` (DOR-4978).
  if (deps.sessionRelayDeps) domains.push(sessionRelayDomain);
  if (deps.roomDeps) domains.push(roomsDomain);
  if (deps.sessionCompactionDeps) domains.push(sessionDomain);
  if (deps.chatMessageDeps) domains.push(chatDomain);
  if (deps.todoPromiseDeps) domains.push(todoPromisesDomain);
  // The promise list and a person's "add a promise", on their REST paths (DOR-4978).
  if (deps.todoPromiseHttpDeps) domains.push(todoPromiseHttpDomain);
  // Behind the flag here as well as at boot, so the docs composer below can match it (DOR-3088).
  if (deps.todoDeps && env.DORKOS_TODOS_ENABLED) domains.push(todosDomain);
  if (deps.todoViewDeps && env.DORKOS_TODOS_ENABLED) domains.push(todoViewDomain);
  // A person's to-do writes and promise changes (DOR-4978).
  if (deps.todoPromiseWriteDeps) domains.push(todoPromiseWriteDomain);
  if (deps.todoWriteDeps && env.DORKOS_TODOS_ENABLED) domains.push(todoWriteDomain);
  if (deps.workQueueDeps) domains.push(workQueueDomain);
  if (deps.workQueuePersonDeps) domains.push(workQueuePersonDomain);
  // The agent registry's doors on `/api/mesh/*`, when the mesh started (DOR-4978).
  if (deps.meshDeps) domains.push(meshDomain);
  if (deps.workClaimDeps) domains.push(workClaimDomain);
  if (deps.workGraphDeps) domains.push(workGraphDomain);
  if (deps.auditDeps) domains.push(auditDomain);
  // The work graph's reads take their reader and roster from the audit deps (DOR-4970).
  if (deps.auditDeps) domains.push(workGraphReadDomain);
  if (deps.agentPauseDeps) domains.push(agentPauseDomain);
  if (deps.approvalWithdrawDeps) domains.push(approvalsDomain);
  if (deps.linkDeps) domains.push(linkDomain);
  if (deps.localBrowserDeps) domains.push(createLocalBrowserDomain(deps.localBrowserDeps));
  // Unconditional, unlike every domain above it: memory has no service handle to
  // switch off. Every install has a filesystem, the builtin provider needs
  // nothing else, and an agent that could not save what it learns is the defect
  // this domain exists to fix — so there is no configuration under which the
  // right answer is to leave the verb out.
  domains.push(memoryDomain);
  // Unconditional for the same reason: there is no handle to switch off. Every
  // session has a window, and the canvas it reads is resolved per call.
  domains.push(uiDomain);
  domains.push(capabilitiesDomain);
  // Unconditional too: every agent already receives the text it reads, and the
  // builders it reaches need no service handle (spec `context-viewer` phase 3).
  domains.push(instructionsDomain);
  // Unconditional too: every agent may read its own permissions and ask past a
  // Blocked one (spec `agent-permissions` D8, D9). The request tool reaches the
  // action it asks for through `deps.registry`, back-written below.
  domains.push(permissionsDomain);
  // One agent's permissions and level; still starting until boot sets their reader (DOR-4978).
  domains.push(permissionViewsDomain);
  // Unconditional too: `end_beat` needs no service handle, and outside a beat
  // it refuses on its own (`NOT_A_BEAT`), so there is nothing to switch off.
  domains.push(heartbeatDomain);
  // Unconditional too: a chat's runs are read from the run record every server
  // keeps, and before startup wires it the read says DorkOS is still starting.
  domains.push(runsDomain);
  // The app's task reads (DOR-4978); they say so themselves when Tasks is not running.
  domains.push(taskViewDomain);
  // The app's simplest chat reads (DOR-4978); each folds in the session read guard.
  domains.push(sessionReadsDomain);
  // The app's runtime setup reads and this computer's own reads (DOR-4978); they say so
  // themselves before the runtimes start.
  domains.push(runtimeReadsDomain, ...computerReadsDomains);
  // Unconditional too: the folder picker, the diff review and the workspace
  // reads read the filesystem and process-wide stores every server has, so
  // their paths answer wherever the hand routes used to. The file browser too
  // (DOR-4978); its save says so itself until boot hands it the writer.
  domains.push(directoryDomain, diffDomain, workspacesDomain, filesDomain);
  // The template list reads the data directory the template routes write.
  if (deps.templateDeps) domains.push(templatesDomain);

  const registry = composeRegistry(domains, deps, onInvocation);
  // Back-write the composed registry so `capabilities.list` can serialize it.
  // Done immediately after composition, before any request is served — this is
  // the late-binding half of the self-reference.
  deps.registry = registry;
  return registry;
}

/**
 * Compose a projection-only registry of EVERY domain, for static OpenAPI export
 * (spec `capability-registry`, task 2.5).
 *
 * The OpenAPI document is generated by `scripts/export-openapi.ts` without
 * booting the server, so no live service handles exist. This composer includes
 * all domains unconditionally (unlike {@link composeDorkOsCapabilityRegistry},
 * which gates each domain on its deps) so every capability's `http` surface
 * projects into the document. The placeholder deps satisfy each domain's
 * `assertDeps` presence check and are never invoked: OpenAPI projection reads
 * only static capability metadata (`id`, `surfaces`, `input`/`output` schemas),
 * never `invoke`.
 *
 * **Every** is literal, and it is load-bearing well beyond OpenAPI. Production
 * has one caller — `core/openapi-registry.ts`, which projects this registry into
 * the document — and the rest are guards that assert against it:
 * `routes/__tests__/shapes.test.ts` proves no capability has claimed the
 * `shapes.apply` id `routes/shapes.ts` reserves, `core/__tests__/mcp-tool-gate.test.ts`
 * builds its tool-tier lookup from it, and the in-session tool-exposure and
 * context-tool-names suites build their probe sessions from it. A domain missing
 * from this list is a domain none of them can see. `connectorExecutionDomain` was
 * missing from exactly here between #1635 — which added it to the boot composer
 * forty lines up and not to this one — and its restoration; because every
 * capability in that domain declares `surfaces: {}`, nothing projected changed
 * when it came back, which is precisely why the gap went unseen.
 * `__tests__/dorkos-registry.test.ts` pins this list against the boot composer
 * with every domain enabled, so the two cannot drift again.
 *
 * @returns The frozen registry over all domains, for documentation projection only.
 */
export function composeCapabilityRegistryForDocs(): CapabilityRegistry {
  const domains: CapabilityDomain[] = [
    operatorDomain,
    marketplaceDomain,
    marketplaceReadsDomain,
    connectorDomain,
    connectorExecutionDomain,
    connectorHoldDomain,
    mcpDomain,
    globalMcpPersonDomain,
    connectionOwnerDomain,
    connectionManagementDomain,
    connectionListDomain,
    extensionPersonDomain,
    sessionRelayDomain,
    roomsDomain,
    sessionDomain,
    chatDomain,
    todoPromisesDomain,
    todoPromiseHttpDomain,
    todoPromiseWriteDomain,
    // Left out when `DORKOS_TODOS_ENABLED` is set to false (on by default since DOR-5071), so the
    // generated docs do not describe tools nobody can call.
    ...(env.DORKOS_TODOS_ENABLED ? [todosDomain, todoViewDomain, todoWriteDomain] : []),
    workQueueDomain,
    workQueuePersonDomain,
    meshDomain,
    workClaimDomain,
    workGraphDomain,
    auditDomain,
    workGraphReadDomain,
    agentPauseDomain,
    approvalsDomain,
    linkDomain,
    createLocalBrowserDomain({} as NonNullable<CapabilityDeps['localBrowserDeps']>),
    memoryDomain,
    uiDomain,
    capabilitiesDomain,
    instructionsDomain,
    permissionsDomain,
    permissionViewsDomain,
    heartbeatDomain,
    runsDomain,
    taskViewDomain,
    sessionReadsDomain,
    runtimeReadsDomain,
    ...computerReadsDomains,
    directoryDomain,
    diffDomain,
    workspacesDomain,
    filesDomain,
    templatesDomain,
  ];
  const deps: CapabilityDeps = {
    logger: noopLogger,
    operatorDeps: {} as CapabilityDeps['operatorDeps'],
    marketplaceDeps: {} as CapabilityDeps['marketplaceDeps'],
    connectorDeps: {} as CapabilityDeps['connectorDeps'],
    connectorExecutionDeps: {} as CapabilityDeps['connectorExecutionDeps'],
    mcpDeps: {} as CapabilityDeps['mcpDeps'],
    globalMcpPersonDeps: {} as CapabilityDeps['globalMcpPersonDeps'],
    connectionOwnerDeps: {} as CapabilityDeps['connectionOwnerDeps'],
    extensionPersonDeps: {} as CapabilityDeps['extensionPersonDeps'],
    sessionRelayDeps: {} as CapabilityDeps['sessionRelayDeps'],
    roomDeps: {} as CapabilityDeps['roomDeps'],
    sessionCompactionDeps: {} as CapabilityDeps['sessionCompactionDeps'],
    chatMessageDeps: {} as CapabilityDeps['chatMessageDeps'],
    todoPromiseDeps: {} as CapabilityDeps['todoPromiseDeps'],
    todoDeps: {} as CapabilityDeps['todoDeps'],
    todoPromiseHttpDeps: {} as CapabilityDeps['todoPromiseHttpDeps'],
    todoViewDeps: {} as CapabilityDeps['todoViewDeps'],
    todoPromiseWriteDeps: {} as CapabilityDeps['todoPromiseWriteDeps'],
    todoWriteDeps: {} as CapabilityDeps['todoWriteDeps'],
    workQueueDeps: {} as CapabilityDeps['workQueueDeps'],
    workQueuePersonDeps: {} as CapabilityDeps['workQueuePersonDeps'],
    meshDeps: {} as CapabilityDeps['meshDeps'],
    workClaimDeps: {} as CapabilityDeps['workClaimDeps'],
    workGraphDeps: {} as CapabilityDeps['workGraphDeps'],
    auditDeps: {} as CapabilityDeps['auditDeps'],
    agentPauseDeps: {} as CapabilityDeps['agentPauseDeps'],
    approvalWithdrawDeps: {} as CapabilityDeps['approvalWithdrawDeps'],
    linkDeps: {} as CapabilityDeps['linkDeps'],
    templateDeps: {} as CapabilityDeps['templateDeps'],
  };
  return composeRegistry(domains, deps);
}

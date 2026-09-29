/** Private agent service requests, exact owner resolution, and durable resume. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { ulid } from 'ulidx';
import {
  and,
  asc,
  connectionOperationGrants,
  connectorAgentRequests,
  connectorManagedAuthorityOutbox,
  connectorManagedAuthorityScopes,
  connectorOperationRevisions,
  connectorProviderInstances,
  connectorReviewRequests,
  connections,
  eq,
  EVERY_AGENT_GRANT_SUBJECT_ID,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  or,
  type ConnectorAgentRequest,
  type Db,
  type DbTransaction,
  type SessionMessageAcceptanceReceipt,
} from '@dorkos/db';
import {
  ConnectorAgentRequestAuthenticationInputSchema,
  ConnectorAgentRequestDecisionSchema,
  type ConnectorAgentRequestAuthenticationInput,
  type ConnectorAgentRequestDecision,
  type ConnectorAgentRequestDecisionInput,
} from '@dorkos/shared/connector-agent-request-schemas';
import type { ConnectorAuthenticationFlowState } from '@dorkos/shared/connector-resource-schemas';
import type {
  ConnectorEventGrantSelection,
  ConnectorReceiveScope,
} from '@dorkos/shared/connector-event-schemas';
import {
  ConnectorAgentConnectionRequestInputSchema,
  CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT,
  serviceNameFromToolkit,
  type ConnectorAgentConnectionRequestInput,
  type ConnectorAgentRequestItem,
  type ConnectorAgentRequestStatus,
  type ConnectorRequestAccess,
  type ConnectionId,
} from '@dorkos/shared/connector-schemas';
import type { ConnectorEventGrantPort } from './events/grant-port.js';
import { ConnectorSubscriptionError } from './events/subscription-store.js';
import {
  isServerPrincipal,
  type ConnectorOwnerAuthority,
  type ServerPrincipalClaims,
  type ServerPrincipalProof,
} from './principal/server-principal.js';
import type { ConnectorRuntimePrincipalService } from './principal/runtime-principal-service.js';
import type {
  ConnectorOperatorQueryService,
  ConnectorServiceDirectory,
} from './resources/operator-query-service.js';
import type { AppReachProblem } from './app-connection-way.js';
import { dorkosToolNameFor } from '../runtimes/shared/dorkos-tool-names.js';
import { SERVICE_CATALOG_TOOL_NAME } from './connector-capabilities.js';
import type { ConnectorAuthenticationFlowService } from './resources/authentication-flow-service.js';
import { agentGrantScope, type AgentGrantDenial } from './execution/agent-grant-scope.js';
import { CONNECTOR_REQUEST_LIVE_HOLD_MS } from './runtime-capability-scope.js';
import type {
  PreparedPrivateSessionMessage,
  PrivateSessionMessageSourceAdapter,
  PrivateSessionMessageSourceRef,
} from '../session/private-messages/acceptance.js';

const DEFAULT_REQUEST_TTL_MS = 2 * 60 * 60_000;

/**
 * How many new requests one agent may open inside
 * {@link CONNECTOR_REQUEST_RATE_WINDOW_MS} (DOR-2497). Asking again for an app
 * it already asked for reuses that request and never counts; this only caps an
 * agent spraying cards across apps faster than a person can answer them.
 */
export const CONNECTOR_REQUEST_RATE_LIMIT = 10;
/** The sliding window {@link CONNECTOR_REQUEST_RATE_LIMIT} counts over. */
export const CONNECTOR_REQUEST_RATE_WINDOW_MS = 10 * 60_000;
/** The same ceiling the agent-facing catalog tool gives one catalog read. */
const SERVICE_DIRECTORY_TIMEOUT_MS = 30_000;

type RuntimeClaims = Extract<ServerPrincipalClaims, { kind: 'runtime' }>;
type AgentRequestRef = Extract<PrivateSessionMessageSourceRef, { kind: 'connector_agent_request' }>;

/** Persisted request origin that can be checked without a prior-process bearer. */
export interface ConnectorAgentRequestOrigin {
  readonly owner: ConnectorOwnerAuthority;
  readonly runtime: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentPath: string;
  readonly authorityDigest: string;
}

/** Canonical origin and display-name checks used by request and resume paths. */
export interface ConnectorAgentRequestAuthorityPort {
  /** Recheck persisted session, runtime, path, agent, and owner authority. */
  revalidateOrigin(origin: ConnectorAgentRequestOrigin): Promise<boolean>;
  /** Synchronous last-effect check over canonical local state. */
  revalidateOriginSync(origin: ConnectorAgentRequestOrigin): boolean;
  /** Resolve one exact owner agent for review presentation. */
  resolveAgent(
    owner: ConnectorOwnerAuthority,
    agentId: string
  ): { readonly id: string; readonly displayName: string } | undefined;
}

/** Resume boundary shared with live holds and the restart reconciler. */
export interface ConnectorAgentRequestResumePort {
  /** Atomically accept the protected source and schedule its existing dispatcher path. */
  accept(ref: AgentRequestRef): void;
  /** Nudge the bounded existing maintenance/recovery loop. */
  nudge(sessionId: string): void;
}

/** Construction dependencies for durable agent requests. */
export interface ConnectorAgentRequestServiceOptions {
  readonly db: Db;
  /** The catalog read the agent-facing lookup tool uses, so both agree on what exists. */
  readonly services: Pick<ConnectorOperatorQueryService, 'serviceDirectory'>;
  readonly runtimePrincipals: Pick<ConnectorRuntimePrincipalService, 'revalidatePrincipal'>;
  readonly authority: ConnectorAgentRequestAuthorityPort;
  readonly bootEpoch: string;
  readonly eventGrants?: ConnectorEventGrantPort;
  readonly authentication?: Pick<
    ConnectorAuthenticationFlowService,
    'start' | 'poll' | 'findByIdempotencyKey'
  >;
  readonly resume?: ConnectorAgentRequestResumePort;
  readonly now?: () => Date;
  readonly createId?: () => string;
  readonly createSecret?: () => string;
  readonly requestTtlMs?: number;
  readonly liveHoldMs?: number;
  /** Override the catalog read's ceiling (default 30s) in focused tests. */
  readonly serviceDirectoryTimeoutMs?: number;
  /**
   * The room whose turn a session belongs to, when one does. Read when a
   * request is read, so it follows a session's rekey; the room shows the
   * request's card to its owner.
   */
  readonly roomForSession?: (sessionId: string) => string | undefined;
  /**
   * Told whenever a request appears or changes state, so open windows can
   * re-read their owner-scoped request lists. Carries nothing: the listener
   * decides what, if anything, goes on a wire.
   */
  readonly onChanged?: () => void;
}

function authenticationIdempotencyKey(requestId: string): string {
  return `agent-request:${requestId}`;
}

/** Stable refusal raised without revealing private account existence. */
export class ConnectorAgentRequestError extends Error {
  /** Construct a safe request refusal. */
  constructor(
    readonly code:
      | 'principal_required'
      | 'authority_expired'
      | 'service_unavailable'
      | 'request_not_found'
      | 'request_expired'
      | 'request_already_resolved'
      | 'selection_invalid'
      | 'event_selection_unavailable'
      | 'authority_sync_failed'
      | 'session_access_off'
      | 'request_open_elsewhere'
      | 'request_rate_limited',
    message: string
  ) {
    super(message);
    this.name = 'ConnectorAgentRequestError';
  }
}

function ownerColumns(owner: ConnectorOwnerAuthority): {
  ownerKind: 'user' | 'local_install';
  ownerId: string;
} {
  return owner.kind === 'user'
    ? { ownerKind: owner.kind, ownerId: owner.userId }
    : { ownerKind: owner.kind, ownerId: owner.installationId };
}

function rowOwner(row: {
  ownerKind: 'user' | 'local_install' | null;
  ownerId: string | null;
}): ConnectorOwnerAuthority | undefined {
  if (!row.ownerKind || !row.ownerId) return undefined;
  return row.ownerKind === 'user'
    ? { kind: 'user', userId: row.ownerId }
    : { kind: 'local_install', installationId: row.ownerId };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function claimsOwner(claims: RuntimeClaims): ConnectorOwnerAuthority {
  return claims.owner;
}

function originFromClaims(claims: RuntimeClaims): ConnectorAgentRequestOrigin {
  return {
    owner: claims.owner,
    runtime: claims.runtime,
    sessionId: claims.canonicalSessionId,
    agentId: claims.agentId,
    agentPath: claims.agentPath,
    authorityDigest: digest({
      owner: claims.owner,
      runtime: claims.runtime,
      sessionId: claims.canonicalSessionId,
      agentId: claims.agentId,
      agentPath: claims.agentPath,
    }),
  };
}

function parseStringArray(value: string | null): string[] {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) return [];
  return parsed;
}

/** An answer recorded while the updates it chose are still being set up. */
interface ConnectorAgentResolutionClaim {
  readonly version: 1;
  readonly decision: Extract<ConnectorAgentRequestDecision, { decision: 'current_access' }>;
}

interface ResolvedEventSelectionEnvelope {
  readonly version: 1;
  readonly selections: ConnectorEventGrantSelection[];
  readonly appliedEventScopeHash?: string;
}

function emptyEventSelection(): ResolvedEventSelectionEnvelope {
  return { version: 1, selections: [] };
}

function parseResolvedEventSelection(value: string | null): ResolvedEventSelectionEnvelope {
  if (!value) return emptyEventSelection();
  const parsed: unknown = JSON.parse(value);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('version' in parsed) ||
    parsed.version !== 1 ||
    !('selections' in parsed) ||
    !Array.isArray(parsed.selections)
  ) {
    return emptyEventSelection();
  }
  const selections = parsed.selections.filter(
    (selection): selection is ConnectorEventGrantSelection =>
      Boolean(
        selection &&
        typeof selection === 'object' &&
        'subscriptionId' in selection &&
        typeof selection.subscriptionId === 'string' &&
        'scopeVersion' in selection &&
        typeof selection.scopeVersion === 'number' &&
        'definitionId' in selection &&
        typeof selection.definitionId === 'string' &&
        'eventScopeHash' in selection &&
        typeof selection.eventScopeHash === 'string'
      )
  );
  const appliedEventScopeHash =
    'appliedEventScopeHash' in parsed && typeof parsed.appliedEventScopeHash === 'string'
      ? parsed.appliedEventScopeHash
      : undefined;
  return {
    version: 1,
    selections,
    ...(appliedEventScopeHash && { appliedEventScopeHash }),
  };
}

function parseResolutionClaim(value: string | null): ConnectorAgentResolutionClaim | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || !('version' in parsed) || parsed.version !== 1) {
    return undefined;
  }
  if (!('decision' in parsed)) return undefined;
  const decision = ConnectorAgentRequestDecisionSchema.safeParse(parsed.decision);
  if (!decision.success || decision.data.decision !== 'current_access') return undefined;
  return { version: 1, decision: decision.data };
}

const MAX_SERVICE_SUGGESTIONS = 5;

/**
 * Words that name a route DorkOS connects through rather than a service. An
 * agent that has heard of Composio writes `composio-emails`; matching on that
 * word would suggest the unrelated `composio_search` toolkit. The registered
 * routes' types are added to these at request time; their labels are not, since
 * a person may name a route after a service.
 */
const ROUTE_WORDS = ['composio', 'nango', 'dorkos', 'mcp'];

function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Real service ids that share a word with a guessed one, shortest first.
 *
 * `gmail_inbox` and `composio_gmail` both suggest `gmail`. A route name is not
 * a service word, and a word shorter than three letters would match nearly
 * everything, so both are ignored. No match means no suggestion: the refusal
 * then points only at the catalog tool rather than at an unrelated service.
 */
function suggestServices(guess: string, directory: ConnectorServiceDirectory): string[] {
  const ignored = new Set([...ROUTE_WORDS, ...directory.routeTypes.flatMap(words)]);
  const guessWords = new Set<string>();
  for (const word of words(guess)) {
    if (word.length < 3 || ignored.has(word)) continue;
    guessWords.add(word);
    if (word.length > 3 && word.endsWith('s')) guessWords.add(word.slice(0, -1));
  }
  if (guessWords.size === 0) return [];
  return directory.services
    .filter((service) => service.requestable)
    .filter((service) => {
      const serviceWords = [...words(service.serviceSlug), ...words(service.displayName)].filter(
        (word) => !ignored.has(word)
      );
      return [...guessWords].some((guessWord) =>
        serviceWords.some((word) => word.includes(guessWord) || guessWord.includes(word))
      );
    })
    .map((service) => service.serviceSlug)
    .sort((left, right) => left.length - right.length || left.localeCompare(right))
    .slice(0, MAX_SERVICE_SUGGESTIONS);
}

/**
 * The refusal for a service id an agent may not request, written so the agent
 * has one next step instead of a dead end (DOR-2231): wait out a partial
 * catalog, hand the person the one setup step only they can take, send a
 * Messaging-only service to the person, or look the exact id up. The catalog
 * warning text is not repeated to the agent. A popular app no way reaches is
 * never refused here (DOR-2494): it is requestable, and its card runs the fix.
 */
function unavailableServiceMessage(
  serviceSlug: string,
  directory: ConnectorServiceDirectory,
  catalogTool: string
): string {
  const quoted = JSON.stringify(serviceSlug);
  const listed = directory.services.find((service) => service.serviceSlug === serviceSlug);
  if (listed && !listed.requestable && listed.unavailableBecause === 'messaging_only') {
    return (
      `${listed.displayName} connects through Messaging, not an account, so an agent cannot ` +
      'request it. Ask the person to set it up under Messaging in Connections in the DorkOS app.'
    );
  }
  // A chat-only app does not depend on the catalog; anything else missing a
  // route may be missing it because of the outage itself.
  if (directory.warnings.length > 0) return partialCatalogMessage(quoted);
  // Nothing reached: an id beyond the popular apps cannot be checked until a
  // way works, so the refusal names that way's fix instead of "no such id".
  if (
    directory.reachProblem !== 'app_not_reached' &&
    !directory.services.some((service) => service.requestable && service.reached)
  ) {
    return unreachedDirectoryMessage(quoted, directory.reachProblem);
  }
  const suggestions = suggestServices(serviceSlug, directory);
  return [
    `DorkOS has no service with the id ${quoted}. Service ids are exact, lowercase names.`,
    ...(suggestions.length > 0 ? [`Close matches: ${suggestions.join(', ')}.`] : []),
    `Search the services by name with ${catalogTool} (for example {"query":"mail"}), then ask ` +
      'again with the exact serviceSlug of an entry in its services list.',
  ].join(' ');
}

/** The refusal while part of the service list failed to load: a retry, not a verdict. */
function partialCatalogMessage(quoted: string): string {
  return (
    `DorkOS could not load the full list of services just now, so ${quoted} could not be ` +
    'checked. Try again in a moment.'
  );
}

/** The refusal for an id no way can check, by what stands in the way. */
function unreachedDirectoryMessage(
  quoted: string,
  problem: Exclude<AppReachProblem, 'app_not_reached'>
): string {
  switch (problem) {
    case 'way_not_answering':
      return partialCatalogMessage(quoted);
    case 'dorkos_account_unlinked':
      return (
        `DorkOS cannot check ${quoted} right now: the person's DorkOS account isn't linked ` +
        'anymore. They can link it again in Settings › Access in the DorkOS app, or add their ' +
        'own key in Settings › Connections; then ask again.'
      );
    case 'dorkos_account_unavailable':
      return (
        `DorkOS cannot check ${quoted} right now: the person's DorkOS account is linked but ` +
        'cannot reach apps. Try again later.'
      );
    case 'own_key_unavailable':
      return (
        `DorkOS cannot check ${quoted} right now: the person's own key for reaching apps ` +
        "isn't set up or didn't answer when DorkOS last checked it. Ask them to fix it in " +
        'Settings › Connections in the DorkOS app, then ask again.'
      );
    case 'nothing_set_up':
      return (
        `DorkOS is not set up to reach apps yet, so it cannot check ${quoted}; only the popular ` +
        'apps it lists can be requested now. Ask the person to open Connections in the DorkOS ' +
        'app and connect an app there; the first app they connect also sets up how DorkOS ' +
        "reaches apps. Then ask again. Signing in to a service's command-line tool in a shell " +
        'does not give DorkOS access.'
      );
  }
}

/** Durable private request service. */
export class ConnectorAgentRequestService {
  private readonly now: () => Date;
  private readonly createId: () => string;
  private readonly createSecret: () => string;
  private readonly requestTtlMs: number;
  private readonly liveHoldMs: number;
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly activeLiveHolds = new Map<string, number>();
  private reconcileCursor?: string;

  /** Construct the request lifecycle over canonical connector authority. */
  constructor(private readonly options: ConnectorAgentRequestServiceOptions) {
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? ulid;
    this.createSecret = options.createSecret ?? (() => randomBytes(32).toString('base64url'));
    this.requestTtlMs = options.requestTtlMs ?? DEFAULT_REQUEST_TTL_MS;
    this.liveHoldMs = options.liveHoldMs ?? CONNECTOR_REQUEST_LIVE_HOLD_MS;
  }

  /**
   * Create or reuse one unresolved, principal-bound request without listing
   * accounts.
   *
   * One agent has at most one open request per app (DOR-2497). Asking again
   * reuses it whatever the reason says; asking for more (Read and write after
   * Read, or more events) raises the open request in place rather than opening
   * a second card. The same app already asked for in another chat is refused
   * with a note, since its answer will cover this chat too. New requests are
   * capped per agent ({@link CONNECTOR_REQUEST_RATE_LIMIT}).
   */
  async create(
    principal: ServerPrincipalProof,
    rawInput: ConnectorAgentConnectionRequestInput
  ): Promise<ConnectorAgentRequestStatus> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    const input = ConnectorAgentConnectionRequestInputSchema.parse(rawInput);
    const directory = await this.readServiceDirectory();
    if (
      !directory.services.some(
        (service) => service.serviceSlug === input.serviceSlug && service.requestable
      )
    ) {
      throw new ConnectorAgentRequestError(
        'service_unavailable',
        unavailableServiceMessage(
          input.serviceSlug,
          directory,
          dorkosToolNameFor(claims.runtime, SERVICE_CATALOG_TOOL_NAME)
        )
      );
    }
    const appName =
      directory.services.find((service) => service.serviceSlug === input.serviceSlug)
        ?.displayName ?? serviceNameFromToolkit(input.serviceSlug);
    // An overdue request must not hold the app open for the agent's other
    // chats until the next maintenance tick.
    this.materializeExpiry();
    const now = this.now();
    const origin = originFromClaims(claims);
    // One synchronous transaction reads the open request and writes the new
    // one, so two calls racing for the same app cannot both open a card.
    const outcome = this.options.db.transaction(
      (
        tx
      ):
        | { kind: 'existing'; requestId: string; raised: boolean }
        | {
            kind: 'elsewhere';
            /** Allowed there already: what it holds; `null` while unanswered. */
            held: ReadonlySet<string> | null;
            /** What that request asks for. */
            asked: ConnectorRequestAccess;
          }
        | { kind: 'rate_limited'; retryAt: number }
        | { kind: 'created'; requestId: string } => {
        const open = openAgentRequest(tx, claims.agentId, input.serviceSlug, now.toISOString());
        if (open) {
          if (
            open.request.sessionId !== claims.canonicalSessionId ||
            open.request.originRuntime !== claims.runtime ||
            open.request.originAgentPath !== claims.agentPath
          ) {
            return {
              kind: 'elsewhere',
              held:
                open.request.outcome === 'granted' ? grantedClasses(tx, open.request).held : null,
              asked: open.request.requestedAccess,
            };
          }
          return {
            kind: 'existing',
            requestId: open.request.id,
            raised: raiseOpenRequest(tx, open, input),
          };
        }
        const recent = tx
          .select({ createdAt: connectorAgentRequests.createdAt })
          .from(connectorAgentRequests)
          .where(
            and(
              eq(connectorAgentRequests.agentId, claims.agentId),
              gt(
                connectorAgentRequests.createdAt,
                new Date(now.getTime() - CONNECTOR_REQUEST_RATE_WINDOW_MS).toISOString()
              )
            )
          )
          .orderBy(asc(connectorAgentRequests.createdAt))
          .all();
        if (recent.length >= CONNECTOR_REQUEST_RATE_LIMIT) {
          return {
            kind: 'rate_limited',
            retryAt: Date.parse(recent[0]!.createdAt) + CONNECTOR_REQUEST_RATE_WINDOW_MS,
          };
        }
        const requestId = this.createId();
        const reviewRequestId = this.createId();
        const action = {
          version: 1 as const,
          kind: 'agent_connection_request' as const,
          serviceSlug: input.serviceSlug,
          reason: input.reason,
          access: input.access,
          requestedEvents: input.requestedEvents,
        };
        const owner = ownerColumns(claimsOwner(claims));
        tx.insert(connectorReviewRequests)
          .values({
            id: reviewRequestId,
            actionKind: action.kind,
            actionVersion: action.version,
            requesterKind: 'agent',
            requesterId: claims.agentId,
            ...owner,
            agentId: claims.agentId,
            sessionId: claims.canonicalSessionId,
            authorityBindingDigest: origin.authorityDigest,
            actionHash: digest(action),
            targetKind: 'service',
            targetId: input.serviceSlug,
            actionPayloadJson: canonicalJson(action),
            reviewContextJson: canonicalJson(reviewContext(action)),
            state: 'pending',
            expiresAt: new Date(now.getTime() + this.requestTtlMs).toISOString(),
            // Unique per request: which request is open is read from state,
            // never from a hash of what the agent happened to write.
            idempotencyKey: `agent-request:${requestId}`,
            createdAt: now.toISOString(),
          })
          .run();
        tx.insert(connectorAgentRequests)
          .values({
            id: requestId,
            reviewRequestId,
            agentId: claims.agentId,
            sessionId: claims.canonicalSessionId,
            serviceSlug: input.serviceSlug,
            requestedAccess: input.access,
            requestedEventsJson: canonicalJson(input.requestedEvents),
            reason: input.reason,
            resumeState: 'pending',
            sourceGeneration: randomUUID(),
            resumeToken: this.createSecret(),
            originRuntime: claims.runtime,
            originAgentPath: claims.agentPath,
            originAuthorityDigest: origin.authorityDigest,
            liveHoldBootEpoch: this.options.bootEpoch,
            liveHoldUntil: new Date(now.getTime() + this.liveHoldMs).toISOString(),
            createdAt: now.toISOString(),
          })
          .run();
        return { kind: 'created', requestId };
      }
    );
    switch (outcome.kind) {
      case 'elsewhere':
        throw new ConnectorAgentRequestError(
          'request_open_elsewhere',
          elsewhereMessage(appName, input.access, outcome.asked, outcome.held)
        );
      case 'rate_limited': {
        const minutes = Math.max(1, Math.ceil((outcome.retryAt - now.getTime()) / 60_000));
        throw new ConnectorAgentRequestError(
          'request_rate_limited',
          `You've asked for access to ${CONNECTOR_REQUEST_RATE_LIMIT} apps in the last ` +
            `${CONNECTOR_REQUEST_RATE_WINDOW_MS / 60_000} minutes, which is as many as DorkOS ` +
            'takes at once. Wait for the person to answer those. You can ask for ' +
            `${appName} in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
        );
      }
      case 'existing':
        if (outcome.raised) this.options.onChanged?.();
        return this.getForRuntime(principal, outcome.requestId);
      case 'created':
        this.options.onChanged?.();
        return this.getForRuntime(principal, outcome.requestId);
    }
  }

  /** The catalog read, where running out of time reads as a partial list rather than a crash. */
  private async readServiceDirectory(): Promise<ConnectorServiceDirectory> {
    const signal = AbortSignal.timeout(
      this.options.serviceDirectoryTimeoutMs ?? SERVICE_DIRECTORY_TIMEOUT_MS
    );
    // Not every route stops mid-call when the signal fires, so the deadline is
    // also raced here: the agent hears "try again" on time either way.
    const deadline = new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    // The race settles once; a deadline firing after a successful read is not an error.
    deadline.catch(() => undefined);
    try {
      return await Promise.race([this.options.services.serviceDirectory(signal), deadline]);
    } catch (error) {
      if (!signal.aborted) throw error;
      return {
        services: [],
        warnings: [{ code: 'catalog_timeout', message: 'The service list took too long.' }],
        routeTypes: [],
        // Unread; the warning answers first ("try again").
        reachProblem: 'app_not_reached',
      };
    }
  }

  /** Read one own request without exposing owner account inventory. */
  async getForRuntime(
    principal: ServerPrincipalProof,
    requestId: string
  ): Promise<ConnectorAgentRequestStatus> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    const row = this.requestWithReview(requestId);
    if (
      !row ||
      row.request.agentId !== claims.agentId ||
      row.request.sessionId !== claims.canonicalSessionId ||
      row.request.originRuntime !== claims.runtime ||
      row.request.originAgentPath !== claims.agentPath
    ) {
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    }
    return this.toStatus(row.request, row.review);
  }

  /** List owner-visible requests without making the list available to an agent. */
  listForOwner(
    owner: ConnectorOwnerAuthority,
    state?: 'pending' | 'resolved',
    sessionId?: string
  ): ConnectorAgentRequestItem[] {
    this.materializeAuthenticationFailures();
    this.materializeExpiry();
    const expected = ownerColumns(owner);
    return this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.ownerKind, expected.ownerKind),
          eq(connectorReviewRequests.ownerId, expected.ownerId),
          ...(sessionId === undefined ? [] : [eq(connectorAgentRequests.sessionId, sessionId)]),
          ...(state === 'pending'
            ? [
                or(
                  eq(connectorReviewRequests.state, 'pending'),
                  and(
                    eq(connectorAgentRequests.outcome, 'granted'),
                    inArray(connectorAgentRequests.resumeState, ['pending', 'ready'])
                  )
                ),
              ]
            : state === 'resolved'
              ? [
                  and(
                    ne(connectorReviewRequests.state, 'pending'),
                    or(
                      ne(connectorAgentRequests.outcome, 'granted'),
                      inArray(connectorAgentRequests.resumeState, ['resumed', 'cancelled'])
                    )
                  ),
                ]
              : [])
        )
      )
      .all()
      .map(({ request, review }) => this.toOwnerItem(owner, request, review));
  }

  /** Read one exact owner request or return the same not-found refusal as a foreign id. */
  getForOwner(owner: ConnectorOwnerAuthority, requestId: string): ConnectorAgentRequestItem {
    this.materializeExpiry();
    this.requireOwnedRequest(owner, requestId);
    this.materializeAuthenticationFailure(requestId);
    const row = this.requireOwnedRequest(owner, requestId);
    return this.toOwnerItem(owner, row.request, row.review);
  }

  /** Start or recover authentication tied to one exact owner request and service. */
  async startAuthentication(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    rawInput: ConnectorAgentRequestAuthenticationInput
  ): Promise<ConnectorAuthenticationFlowState> {
    const input = ConnectorAgentRequestAuthenticationInputSchema.parse(rawInput);
    const authentication = this.requireAuthentication();
    const row = this.requirePendingAuthenticationRequest(owner, requestId);
    if (!(await this.options.authority.revalidateOrigin(this.originFor(row.request, row.review)))) {
      const removed = this.resolveTerminal(
        row.request,
        row.review,
        'target_deleted',
        'Request target removed'
      );
      if (!removed) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its target was being checked.'
        );
      }
      this.notifyResolved(requestId);
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request is no longer available.'
      );
    }
    const existing = authentication.findByIdempotencyKey(
      owner,
      authenticationIdempotencyKey(requestId)
    );
    if (
      existing &&
      (existing.providerInstanceId !== input.providerInstanceId ||
        existing.toolkit !== row.request.serviceSlug)
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'Authentication already started with a different service setup.'
      );
    }
    const flow = await authentication.start(owner, {
      providerInstanceId: input.providerInstanceId,
      toolkit: row.request.serviceSlug,
      ...(input.label !== undefined ? { label: input.label } : {}),
      idempotencyKey: authenticationIdempotencyKey(requestId),
    });
    if (
      flow.providerInstanceId !== input.providerInstanceId ||
      flow.toolkit !== row.request.serviceSlug
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That authentication flow does not belong to this service request.'
      );
    }
    const selected = this.options.db
      .update(connectorReviewRequests)
      .set({ providerInstanceId: flow.providerInstanceId })
      .where(
        and(
          eq(connectorReviewRequests.id, row.review.id),
          eq(connectorReviewRequests.state, 'pending'),
          isNull(connectorReviewRequests.resolutionJson),
          or(
            isNull(connectorReviewRequests.providerInstanceId),
            eq(connectorReviewRequests.providerInstanceId, flow.providerInstanceId)
          )
        )
      )
      .run().changes;
    if (selected !== 1) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request changed before authentication could start.'
      );
    }
    return flow;
  }

  /** Poll only the durable authentication flow linked to this exact request. */
  async pollAuthentication(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    flowId: string
  ): Promise<ConnectorAuthenticationFlowState> {
    const authentication = this.requireAuthentication();
    const row = this.requirePendingAuthenticationRequest(owner, requestId);
    const expected = authentication.findByIdempotencyKey(
      owner,
      authenticationIdempotencyKey(requestId)
    );
    if (
      !expected ||
      expected.flowId !== flowId ||
      expected.toolkit !== row.request.serviceSlug ||
      (row.review.providerInstanceId !== null &&
        row.review.providerInstanceId !== expected.providerInstanceId)
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That authentication flow does not belong to this service request.'
      );
    }
    if (!(await this.options.authority.revalidateOrigin(this.originFor(row.request, row.review)))) {
      const removed = this.resolveTerminal(
        row.request,
        row.review,
        'target_deleted',
        'Request target removed'
      );
      if (!removed) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its target was being checked.'
        );
      }
      this.notifyResolved(requestId);
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request is no longer available.'
      );
    }
    const state = await authentication.poll(owner, flowId);
    if (
      state.flowId !== expected.flowId ||
      state.providerInstanceId !== expected.providerInstanceId ||
      state.toolkit !== expected.toolkit
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That authentication flow does not belong to this service request.'
      );
    }
    if (state.state === 'failed' || state.state === 'expired' || state.state === 'start_unknown') {
      const current = this.requestWithReview(requestId);
      if (current && current.review.state === 'pending' && current.request.outcome === null) {
        const failed = this.resolveTerminal(
          current.request,
          current.review,
          'authentication_failed',
          'Account authentication failed'
        );
        if (failed) this.notifyResolved(requestId);
      }
    }
    return state;
  }

  /**
   * Apply one exact owner decision; authentication completion alone never
   * calls this. An answer is "no", or the access the agent now holds on one
   * account (given a moment ago on the shared card), plus the exact updates
   * chosen when the request also asked to hear about new activity.
   */
  async resolve(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    rawDecision: ConnectorAgentRequestDecisionInput,
    signal: AbortSignal = new AbortController().signal
  ): Promise<ConnectorAgentRequestItem> {
    const decision = ConnectorAgentRequestDecisionSchema.parse(rawDecision);
    const row = this.requireOwnedRequest(owner, requestId);
    if (row.review.state !== 'pending') {
      if (this.sameAnswer(row, decision)) return this.getForOwner(owner, requestId);
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request has already been resolved.'
      );
    }
    if (!row.review.resolutionJson && Date.parse(row.review.expiresAt) <= this.now().getTime()) {
      if (!this.expireRequest(row.request, row.review)) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its expiry was being checked.'
        );
      }
      throw new ConnectorAgentRequestError(
        'request_expired',
        'This service request has expired. Ask the agent to request it again.'
      );
    }
    const origin = this.originFor(row.request, row.review);
    if (!(await this.options.authority.revalidateOrigin(origin))) {
      const removed = this.resolveTerminal(
        row.request,
        row.review,
        'target_deleted',
        'Request target removed'
      );
      if (!removed) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its target was being checked.'
        );
      }
      this.notifyResolved(requestId);
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request is no longer available.'
      );
    }
    if (decision.decision === 'denied') {
      if (
        row.review.resolutionJson ||
        !this.resolveTerminal(row.request, row.review, 'denied', 'Denied by owner')
      ) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'Access is already being applied for this service request.'
        );
      }
      this.notifyResolved(requestId);
      return this.getForOwner(owner, requestId);
    }
    if (decision.eventScopes.length === 0) {
      this.resolveWithCurrentAccess(owner, row.request, row.review, decision);
      this.notifyResolved(requestId);
      return this.getForOwner(owner, requestId);
    }

    // Updates too: record the answer first, so a second identical answer
    // reuses it rather than racing it, then ask the event side for the exact
    // scopes. If they can't be set up the answer is taken back, so the person
    // can choose again, answer without updates, or say no (DOR-2503). The
    // request resumes only once both the access and the updates are live.
    this.validateEventScopes(owner, row.request, decision.connectionId, decision.eventScopes);
    const claimed = this.resolveWithCurrentAccess(owner, row.request, row.review, decision);
    const unavailable = () =>
      new ConnectorAgentRequestError(
        'event_selection_unavailable',
        'Those updates can’t be set up right now. Choose them again, or answer without updates.'
      );
    let result: Awaited<ReturnType<ConnectorEventGrantPort['approve']>>;
    try {
      result = await this.options.eventGrants!.approve(
        owner,
        { reviewId: row.review.id, scopes: decision.eventScopes },
        signal
      );
    } catch (error) {
      this.withdrawAnswer(owner, requestId, claimed.reviewId, decision);
      // A refusal at the consent boundary (a destination or definition that
      // changed, or a stale pick) is the person's to answer differently.
      if (error instanceof ConnectorSubscriptionError) throw unavailable();
      throw error;
    }
    if (result.state === 'unavailable') {
      this.withdrawAnswer(owner, requestId, claimed.reviewId, decision);
      throw unavailable();
    }
    const resolvedEvents: ResolvedEventSelectionEnvelope = {
      version: 1,
      selections: result.selections,
      ...(result.state === 'ready' && { appliedEventScopeHash: result.appliedEventScopeHash }),
    };
    const ready = result.state === 'ready';
    const now = this.now().toISOString();
    const claimJson = canonicalJson({
      version: 1,
      decision,
    } satisfies ConnectorAgentResolutionClaim);
    // Finish only the answer this call recorded. Another identical answer may
    // have been taken back while this one waited on the event side (its
    // updates failed); then this one is taken back too, never passed off as
    // allowed over a request that reads as unanswered (DOR-2503).
    const finished = this.options.db.transaction((tx): boolean => {
      const review = tx
        .select({
          state: connectorReviewRequests.state,
          resolutionJson: connectorReviewRequests.resolutionJson,
        })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, claimed.reviewId))
        .get();
      if (review?.resolutionJson !== claimJson) return false;
      const changed = tx
        .update(connectorAgentRequests)
        .set({
          resolvedEventsJson: canonicalJson(resolvedEvents),
          ...(ready && { resumeState: 'ready' as const }),
        })
        .where(
          and(
            eq(connectorAgentRequests.id, requestId),
            eq(connectorAgentRequests.outcome, 'granted'),
            eq(connectorAgentRequests.resumeState, 'pending')
          )
        )
        .run().changes;
      if (changed !== 1) {
        // Nothing left pending: an identical answer already finished it.
        const current = tx
          .select({ outcome: connectorAgentRequests.outcome })
          .from(connectorAgentRequests)
          .where(eq(connectorAgentRequests.id, requestId))
          .get();
        return current?.outcome === 'granted';
      }
      if (ready) {
        tx.update(connectorReviewRequests)
          .set({ state: 'approved', resolvedAt: now, resolutionSummary: 'Access ready' })
          .where(
            and(
              eq(connectorReviewRequests.id, claimed.reviewId),
              eq(connectorReviewRequests.state, 'pending'),
              eq(connectorReviewRequests.resolutionJson, claimJson)
            )
          )
          .run();
      }
      return true;
    });
    if (!finished) {
      this.withdrawAnswer(owner, requestId, claimed.reviewId, decision);
      throw unavailable();
    }
    if (ready) this.notifyResolved(requestId);
    else this.options.onChanged?.();
    return this.getForOwner(owner, requestId);
  }

  /**
   * Take back an answer recorded for updates that could not be set up, so the
   * request is unanswered again, and stop whatever the event side prepared or
   * switched on under its review, in one transaction: an update the person
   * then turns down never arrives, and a different pick can be approved under
   * the same review. Only the exact answer this call recorded is taken back;
   * one that has since finished or changed is left alone. The event side is
   * cleared whenever the request reads as unanswered, including when another
   * identical answer already took it back, since this call's own approval may
   * have prepared updates again after that.
   */
  private withdrawAnswer(
    owner: ConnectorOwnerAuthority,
    requestId: string,
    reviewId: string,
    decision: Extract<ConnectorAgentRequestDecision, { decision: 'current_access' }>
  ): void {
    const claim: ConnectorAgentResolutionClaim = { version: 1, decision };
    const now = this.now().toISOString();
    const withdrawn = this.options.db.transaction((tx) => {
      const changed = tx
        .update(connectorReviewRequests)
        .set({ resolutionJson: null, resolvedBy: null, resolutionSummary: null })
        .where(
          and(
            eq(connectorReviewRequests.id, reviewId),
            eq(connectorReviewRequests.state, 'pending'),
            eq(connectorReviewRequests.resolutionJson, canonicalJson(claim))
          )
        )
        .run().changes;
      if (changed === 1) {
        tx.update(connectorAgentRequests)
          .set({
            outcome: null,
            resumeState: 'pending',
            resolvedConnectionId: null,
            resolvedOperationRevisionIdsJson: null,
            resolvedEventsJson: null,
            resolvedAt: null,
          })
          .where(
            and(
              eq(connectorAgentRequests.id, requestId),
              eq(connectorAgentRequests.outcome, 'granted'),
              eq(connectorAgentRequests.resumeState, 'pending')
            )
          )
          .run();
      }
      const review = tx
        .select({
          state: connectorReviewRequests.state,
          resolutionJson: connectorReviewRequests.resolutionJson,
        })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, reviewId))
        .get();
      if (review?.state === 'pending' && review.resolutionJson === null) {
        this.options.eventGrants?.withdraw(owner, reviewId, now);
      }
      return changed === 1;
    });
    if (withdrawn) this.options.onChanged?.();
  }

  /** Whether a decision repeats the answer an already-resolved request recorded. */
  private sameAnswer(
    row: NonNullable<ReturnType<ConnectorAgentRequestService['requestWithReview']>>,
    decision: ConnectorAgentRequestDecision
  ): boolean {
    if (decision.decision === 'denied') {
      return row.review.state === 'denied' && row.request.outcome === 'denied';
    }
    if (
      row.review.state !== 'approved' ||
      row.request.outcome !== 'granted' ||
      row.request.resolvedConnectionId !== decision.connectionId
    ) {
      return false;
    }
    const recorded = parseResolutionClaim(row.review.resolutionJson);
    return recorded
      ? canonicalJson(recorded.decision) === canonicalJson(decision)
      : decision.eventScopes.length === 0;
  }

  /** Wait for a live owner decision, then exclusively consume this hold's resume token. */
  async waitForResolution(
    principal: ServerPrincipalProof,
    requestId: string,
    signal?: AbortSignal
  ): Promise<ConnectorAgentRequestStatus> {
    const claims = await this.requireLiveRuntimePrincipal(principal);
    const row = this.requestWithReview(requestId);
    if (
      !row ||
      row.request.agentId !== claims.agentId ||
      row.request.sessionId !== claims.canonicalSessionId
    ) {
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    }
    const resumeToken = row.request.resumeToken;
    const deadline = this.now().getTime() + this.liveHoldMs;
    this.activeLiveHolds.set(requestId, (this.activeLiveHolds.get(requestId) ?? 0) + 1);
    try {
      this.options.db
        .update(connectorAgentRequests)
        .set({
          liveHoldBootEpoch: this.options.bootEpoch,
          liveHoldUntil: new Date(deadline).toISOString(),
        })
        .where(
          and(
            eq(connectorAgentRequests.id, requestId),
            inArray(connectorAgentRequests.resumeState, ['pending', 'ready'])
          )
        )
        .run();
      while (true) {
        const current = this.requestWithReview(requestId);
        if (!current) {
          throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
        }
        if (current.request.resumeState === 'ready') {
          const claimed = this.options.db
            .update(connectorAgentRequests)
            .set({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null })
            .where(
              and(
                eq(connectorAgentRequests.id, requestId),
                eq(connectorAgentRequests.resumeState, 'ready'),
                eq(connectorAgentRequests.resumeToken, resumeToken),
                eq(connectorAgentRequests.liveHoldBootEpoch, this.options.bootEpoch),
                gt(connectorAgentRequests.liveHoldUntil, this.now().toISOString())
              )
            )
            .run().changes;
          if (claimed === 1)
            return this.toStatus({ ...current.request, resumeState: 'resumed' }, current.review);
        }
        if (current.request.resumeState === 'resumed') {
          return this.toStatus(current.request, current.review);
        }
        const remaining = deadline - this.now().getTime();
        if (remaining <= 0 || signal?.aborted)
          return this.toStatus(current.request, current.review);
        await this.waitForSignal(requestId, Math.min(remaining, 1_000), signal);
      }
    } finally {
      const remainingHolds = (this.activeLiveHolds.get(requestId) ?? 1) - 1;
      if (remainingHolds > 0) {
        this.activeLiveHolds.set(requestId, remainingHolds);
      } else {
        this.activeLiveHolds.delete(requestId);
        this.options.db
          .update(connectorAgentRequests)
          .set({ liveHoldBootEpoch: null, liveHoldUntil: null })
          .where(
            and(
              eq(connectorAgentRequests.id, requestId),
              eq(connectorAgentRequests.resumeToken, resumeToken),
              eq(connectorAgentRequests.liveHoldBootEpoch, this.options.bootEpoch)
            )
          )
          .run();
        this.options.resume?.nudge(row.request.sessionId);
      }
    }
  }

  /** Expire reviews, observe pending sync, and accept ready results for restart recovery. */
  async reconcile(limit = 25): Promise<{ expired: number; accepted: number; cancelled: number }> {
    this.materializeAuthenticationFailures();
    const expired = this.materializeExpiry();
    const actionable = or(
      eq(connectorAgentRequests.resumeState, 'ready'),
      and(
        eq(connectorAgentRequests.resumeState, 'pending'),
        eq(connectorAgentRequests.outcome, 'granted')
      )
    )!;
    const page = (afterRequestId: string | undefined, pageLimit: number) =>
      this.options.db
        .select({ request: connectorAgentRequests, review: connectorReviewRequests })
        .from(connectorAgentRequests)
        .innerJoin(
          connectorReviewRequests,
          eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
        )
        .where(
          afterRequestId
            ? and(actionable, gt(connectorAgentRequests.id, afterRequestId))
            : actionable
        )
        .orderBy(asc(connectorAgentRequests.id))
        .limit(pageLimit)
        .all();
    const rows = page(this.reconcileCursor, limit);
    if (this.reconcileCursor && rows.length < limit) {
      rows.push(
        ...this.options.db
          .select({ request: connectorAgentRequests, review: connectorReviewRequests })
          .from(connectorAgentRequests)
          .innerJoin(
            connectorReviewRequests,
            eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
          )
          .where(and(actionable, lte(connectorAgentRequests.id, this.reconcileCursor)))
          .orderBy(asc(connectorAgentRequests.id))
          .limit(limit - rows.length)
          .all()
      );
    }
    this.reconcileCursor = rows.at(-1)?.request.id;
    let accepted = 0;
    let cancelled = 0;
    for (const row of rows) {
      if (
        row.request.resumeState === 'pending' &&
        row.request.outcome === 'granted' &&
        hasExactLiveGrants(this.options.db, row.request) &&
        (await this.eventSelectionReady(row.request, row.review))
      ) {
        this.options.db
          .update(connectorAgentRequests)
          .set({ resumeState: 'ready' })
          .where(
            and(
              eq(connectorAgentRequests.id, row.request.id),
              eq(connectorAgentRequests.resumeState, 'pending')
            )
          )
          .run();
        this.options.db
          .update(connectorReviewRequests)
          .set({
            state: 'approved',
            resolvedAt: this.now().toISOString(),
            resolutionSummary: 'Access ready',
          })
          .where(
            and(
              eq(connectorReviewRequests.id, row.review.id),
              eq(connectorReviewRequests.state, 'pending')
            )
          )
          .run();
        row.request.resumeState = 'ready';
        this.options.onChanged?.();
      }
      if (row.request.resumeState !== 'ready') continue;
      const origin = this.originFor(row.request, row.review);
      if (!(await this.options.authority.revalidateOrigin(origin))) {
        this.options.db
          .update(connectorAgentRequests)
          .set({ resumeState: 'cancelled', outcome: 'target_deleted' })
          .where(eq(connectorAgentRequests.id, row.request.id))
          .run();
        cancelled += 1;
        continue;
      }
      if (
        row.request.liveHoldBootEpoch === this.options.bootEpoch &&
        row.request.liveHoldUntil &&
        Date.parse(row.request.liveHoldUntil) > this.now().getTime()
      ) {
        continue;
      }
      if (!this.options.resume || !row.request.sourceGeneration) continue;
      this.options.resume.accept({
        kind: 'connector_agent_request',
        requestId: row.request.id,
        sourceGeneration: row.request.sourceGeneration,
        resumeToken: row.request.resumeToken,
      });
      this.options.resume.nudge(row.request.sessionId);
      accepted += 1;
    }
    return { expired, accepted, cancelled };
  }

  private async requireLiveRuntimePrincipal(
    principal: ServerPrincipalProof
  ): Promise<RuntimeClaims> {
    if (!isServerPrincipal(principal) || principal.claims.kind !== 'runtime') {
      throw new ConnectorAgentRequestError(
        'principal_required',
        'Service requests require an authenticated runtime turn.'
      );
    }
    if (!(await this.options.runtimePrincipals.revalidatePrincipal(principal))) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'This runtime turn is no longer authorized. Start a new turn and try again.'
      );
    }
    return principal.claims;
  }

  private requestWithReview(requestId: string) {
    return this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(eq(connectorAgentRequests.id, requestId))
      .get();
  }

  private requireOwnedRequest(owner: ConnectorOwnerAuthority, requestId: string) {
    const row = this.requestWithReview(requestId);
    const expected = ownerColumns(owner);
    if (
      !row ||
      row.review.ownerKind !== expected.ownerKind ||
      row.review.ownerId !== expected.ownerId
    ) {
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    }
    return row;
  }

  private requirePendingAuthenticationRequest(owner: ConnectorOwnerAuthority, requestId: string) {
    const row = this.requireOwnedRequest(owner, requestId);
    if (
      row.review.state !== 'pending' ||
      row.review.resolutionJson !== null ||
      row.request.outcome !== null
    ) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request has already been resolved.'
      );
    }
    if (Date.parse(row.review.expiresAt) <= this.now().getTime()) {
      if (!this.expireRequest(row.request, row.review)) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'This service request changed while its expiry was being checked.'
        );
      }
      throw new ConnectorAgentRequestError(
        'request_expired',
        'This service request has expired. Ask the agent to request it again.'
      );
    }
    return row;
  }

  private requireAuthentication(): NonNullable<
    ConnectorAgentRequestServiceOptions['authentication']
  > {
    if (!this.options.authentication) {
      throw new ConnectorAgentRequestError(
        'service_unavailable',
        'Account authentication is unavailable right now.'
      );
    }
    return this.options.authentication;
  }

  private toStatus(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): ConnectorAgentRequestStatus {
    const base = {
      requestId: request.id,
      serviceSlug: request.serviceSlug,
      reason: request.reason,
      access: request.requestedAccess,
      requestedEvents: parseStringArray(request.requestedEventsJson),
      createdAt: request.createdAt,
      expiresAt: review.expiresAt,
    };
    const status = requestStatus(request);
    if (status === 'granted' && request.resolvedConnectionId) {
      const answer = grantedClasses(this.options.db, request);
      return {
        ...base,
        status,
        connectionId: request.resolvedConnectionId as ConnectionId,
        grantedOperationRevisionIds: parseStringArray(request.resolvedOperationRevisionIdsJson),
        grantedEvents: this.resolvedEventTypes(request, review),
        notGranted: answer.notGranted,
        note: requestNote(request, answer),
      };
    }
    const open = status === 'granted' ? 'access_pending' : status;
    return { ...base, status: open, note: requestNote(request) };
  }

  private toOwnerItem(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): ConnectorAgentRequestItem {
    const agent = this.options.authority.resolveAgent(owner, request.agentId);
    const roomId = this.options.roomForSession?.(request.sessionId);
    return {
      ...this.toStatus(request, review),
      sessionId: request.sessionId,
      agent: agent ?? { id: request.agentId, displayName: 'Removed agent' },
      ...(roomId ? { roomId } : {}),
    };
  }

  /**
   * Answer a pending request with the access the agent already holds on one
   * account, writing no grant. The owner gave that access a moment ago through
   * the shared access card, so the request records exactly what is live and
   * the held turn resumes on it. Refused when the account is not this
   * request's, the agent holds nothing live there, or a managed account has
   * not finished applying the agent's access.
   *
   * With updates chosen too, the answer is recorded (and reused by a retry of
   * the same answer) but the request stays open until the updates are live;
   * the caller finishes it.
   */
  private resolveWithCurrentAccess(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect,
    decision: Extract<ConnectorAgentRequestDecision, { decision: 'current_access' }>
  ): { reviewId: string } {
    // Read fresh: the caller's row predates its awaits, and another identical
    // answer may have recorded itself meanwhile. From here to the write below
    // nothing awaits, so no other answer can slip in between.
    const recorded = parseResolutionClaim(
      this.options.db
        .select({ resolutionJson: connectorReviewRequests.resolutionJson })
        .from(connectorReviewRequests)
        .where(eq(connectorReviewRequests.id, review.id))
        .get()?.resolutionJson ?? null
    );
    if (recorded) {
      if (canonicalJson(recorded.decision) !== canonicalJson(decision)) {
        throw new ConnectorAgentRequestError(
          'request_already_resolved',
          'Access is already being applied for this service request.'
        );
      }
      return { reviewId: review.id };
    }
    const connection = this.requireRequestConnection(owner, request, decision.connectionId);
    const withEvents = decision.eventScopes.length > 0;
    const resolvedBy = `${owner.kind}:${ownerColumns(owner).ownerId}`;
    const now = this.now().toISOString();
    const finalized = this.options.db.transaction((tx) => {
      const access = liveAgentRevisionIds(tx, {
        agentId: request.agentId,
        sessionId: request.sessionId,
        connectionId: connection.id,
      });
      if ('denied' in access) {
        throw new ConnectorAgentRequestError(
          'session_access_off',
          access.denied === 'needs_reconciliation'
            ? 'This chat’s access to that account is waiting on a review.'
            : 'This chat has that account turned off for its agent.'
        );
      }
      const live = [...access.ids].sort();
      if (live.length === 0) {
        throw new ConnectorAgentRequestError(
          'selection_invalid',
          'This agent cannot use that account yet. Allow it first.'
        );
      }
      if (connection.mode === 'managed') {
        // Live access comes from the agent's own grant or from "Every agent"
        // (DOR-2439); either scope's applied command is what made it live.
        const applied = tx
          .select({ state: connectorManagedAuthorityOutbox.state })
          .from(connectorManagedAuthorityScopes)
          .innerJoin(
            connectorManagedAuthorityOutbox,
            eq(
              connectorManagedAuthorityOutbox.commandId,
              connectorManagedAuthorityScopes.lastCommandId
            )
          )
          .where(
            and(
              eq(
                connectorManagedAuthorityScopes.managedConnectionId,
                connection.externalAccountRef
              ),
              or(
                and(
                  eq(connectorManagedAuthorityScopes.scopeKind, 'agent_grants'),
                  eq(connectorManagedAuthorityScopes.subjectId, request.agentId)
                ),
                and(
                  eq(connectorManagedAuthorityScopes.scopeKind, 'every_agent_grants'),
                  eq(connectorManagedAuthorityScopes.subjectId, EVERY_AGENT_GRANT_SUBJECT_ID)
                )
              )
            )
          )
          .all();
        if (!applied.some((scope) => scope.state === 'applied')) {
          throw new ConnectorAgentRequestError(
            'authority_sync_failed',
            'This agent’s access is still being applied. Try again in a moment.'
          );
        }
      }
      const claim: ConnectorAgentResolutionClaim = { version: 1, decision };
      const claimed = tx
        .update(connectorReviewRequests)
        .set(
          withEvents
            ? {
                resolvedBy,
                resolutionSummary: 'Applying selected access',
                resolutionJson: canonicalJson(claim),
              }
            : { state: 'approved', resolvedAt: now, resolvedBy, resolutionSummary: 'Access ready' }
        )
        .where(
          and(
            eq(connectorReviewRequests.id, review.id),
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.resolutionJson)
          )
        )
        .run().changes;
      if (claimed !== 1) return false;
      tx.update(connectorAgentRequests)
        .set({
          outcome: 'granted',
          resumeState: withEvents ? 'pending' : 'ready',
          resolvedConnectionId: connection.id,
          resolvedOperationRevisionIdsJson: canonicalJson(live),
          resolvedEventsJson: canonicalJson(emptyEventSelection()),
          resolvedAt: now,
        })
        .where(eq(connectorAgentRequests.id, request.id))
        .run();
      return true;
    });
    if (!finalized) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This service request has already been resolved.'
      );
    }
    return { reviewId: review.id };
  }

  private originFor(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): ConnectorAgentRequestOrigin {
    const owner = rowOwner(review);
    if (
      !owner ||
      !request.originRuntime ||
      !request.originAgentPath ||
      !request.originAuthorityDigest
    ) {
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'This service request has incomplete authority records.'
      );
    }
    return {
      owner,
      runtime: request.originRuntime,
      sessionId: request.sessionId,
      agentId: request.agentId,
      agentPath: request.originAgentPath,
      authorityDigest: request.originAuthorityDigest,
    };
  }

  /** One live, connected account of this request's service that the owner holds, or a refusal. */
  private requireRequestConnection(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    connectionId: ConnectionId
  ) {
    const expectedOwner = ownerColumns(owner);
    const connection = this.options.db
      .select({
        id: connections.id,
        toolkit: connections.toolkit,
        providerInstanceId: connections.providerInstanceId,
        externalAccountRef: connections.externalAccountRef,
        status: connections.status,
        lifecycleState: connections.lifecycleState,
        enabled: connections.enabled,
        reconciliationStatus: connections.grantReconciliationStatus,
        mode: connectorProviderInstances.mode,
        executionConfigGeneration: connectorProviderInstances.executionConfigGeneration,
        ownerKind: connectorProviderInstances.ownerKind,
        ownerId: connectorProviderInstances.ownerId,
      })
      .from(connections)
      .innerJoin(
        connectorProviderInstances,
        eq(connections.providerInstanceId, connectorProviderInstances.id)
      )
      .where(eq(connections.id, connectionId))
      .get();
    if (
      !connection ||
      connection.ownerKind !== expectedOwner.ownerKind ||
      connection.ownerId !== expectedOwner.ownerId ||
      connection.toolkit !== request.serviceSlug ||
      connection.status !== 'active' ||
      connection.lifecycleState !== 'connected' ||
      !connection.enabled ||
      connection.reconciliationStatus !== 'ready'
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'That account is no longer available for this request.'
      );
    }
    return connection;
  }

  private validateEventScopes(
    owner: ConnectorOwnerAuthority,
    request: ConnectorAgentRequest,
    connectionId: ConnectionId,
    scopes: ConnectorReceiveScope[]
  ): void {
    if (scopes.length === 0) return;
    if (!this.options.eventGrants) {
      throw new ConnectorAgentRequestError(
        'event_selection_unavailable',
        'Event access is not available yet. Remove it from this decision and try again.'
      );
    }
    const identities = new Set(scopes.map((scope) => canonicalJson(scope)));
    if (
      identities.size !== scopes.length ||
      scopes.some(
        (scope) => scope.connectionId !== connectionId || scope.agentId !== request.agentId
      )
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'The selected event access does not match this request.'
      );
    }
    const descriptions = this.options.eventGrants.describe(owner, scopes);
    const requested = new Set(parseStringArray(request.requestedEventsJson));
    if (
      descriptions.length !== scopes.length ||
      descriptions.some(
        (description, index) =>
          description.definitionId !== scopes[index]?.definitionId ||
          !requested.has(description.eventType)
      )
    ) {
      throw new ConnectorAgentRequestError(
        'selection_invalid',
        'The selected events do not match this request.'
      );
    }
  }

  private resolvedEventTypes(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): string[] {
    const claim = parseResolutionClaim(review.resolutionJson);
    if (!claim || claim.decision.eventScopes.length === 0 || !this.options.eventGrants) return [];
    // Only updates that were actually set up count; chosen but never live is none.
    if (!parseResolvedEventSelection(request.resolvedEventsJson).appliedEventScopeHash) return [];
    const owner = rowOwner(review);
    if (!owner) return [];
    try {
      return this.options.eventGrants
        .describe(owner, claim.decision.eventScopes)
        .map((description) => description.eventType);
    } catch {
      return [];
    }
  }

  private async eventSelectionReady(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): Promise<boolean> {
    const claim = parseResolutionClaim(review.resolutionJson);
    if (!claim || claim.decision.eventScopes.length === 0) return true;
    const owner = rowOwner(review);
    if (!owner || !this.options.eventGrants) return false;
    const result = await this.options.eventGrants.approve(
      owner,
      { reviewId: review.id, scopes: claim.decision.eventScopes },
      new AbortController().signal
    );
    if (result.state === 'unavailable') return false;
    const envelope: ResolvedEventSelectionEnvelope = {
      version: 1,
      selections: result.selections,
      ...(result.state === 'ready' && {
        appliedEventScopeHash: result.appliedEventScopeHash,
      }),
    };
    this.options.db
      .update(connectorAgentRequests)
      .set({ resolvedEventsJson: canonicalJson(envelope) })
      .where(eq(connectorAgentRequests.id, request.id))
      .run();
    return result.state === 'ready';
  }

  private resolveTerminal(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect,
    outcome: 'denied' | 'expired' | 'authentication_failed' | 'target_deleted',
    summary: string
  ): boolean {
    const now = this.now().toISOString();
    const preserveLiveHold = (this.activeLiveHolds.get(request.id) ?? 0) > 0;
    return this.options.db.transaction((tx) => {
      const claimed = tx
        .update(connectorReviewRequests)
        .set({
          state: outcome === 'denied' ? 'denied' : 'expired',
          resolvedAt: now,
          resolutionSummary: summary,
        })
        .where(
          and(
            eq(connectorReviewRequests.id, review.id),
            eq(connectorReviewRequests.state, 'pending'),
            isNull(connectorReviewRequests.resolutionJson)
          )
        )
        .run().changes;
      if (claimed !== 1) return false;
      tx.update(connectorAgentRequests)
        .set({
          outcome,
          resumeState: 'ready',
          resolvedAt: now,
          ...(!preserveLiveHold && { liveHoldBootEpoch: null, liveHoldUntil: null }),
        })
        .where(
          and(eq(connectorAgentRequests.id, request.id), isNull(connectorAgentRequests.outcome))
        )
        .run();
      return true;
    });
  }

  private expireRequest(
    request: ConnectorAgentRequest,
    review: typeof connectorReviewRequests.$inferSelect
  ): boolean {
    const expired = this.resolveTerminal(request, review, 'expired', 'Request expired');
    if (expired) this.notifyResolved(request.id);
    return expired;
  }

  private materializeExpiry(): number {
    const now = this.now().toISOString();
    const rows = this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.state, 'pending'),
          isNull(connectorReviewRequests.resolutionJson),
          lte(connectorReviewRequests.expiresAt, now)
        )
      )
      .all();
    let expired = 0;
    for (const row of rows) {
      if (this.expireRequest(row.request, row.review)) expired += 1;
    }
    return expired + this.finishUnreadyUpdates(now);
  }

  /**
   * End an answer whose updates never became live within the request's time
   * (DOR-2503). The agent's access was given and is live, so the request
   * finishes as allowed without updates, and its note says so; it no longer
   * holds the app open for the agent's other chats. Returns how many ended.
   */
  private finishUnreadyUpdates(now: string): number {
    const stuck = this.options.db
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorAgentRequests.outcome, 'granted'),
          eq(connectorAgentRequests.resumeState, 'pending'),
          eq(connectorReviewRequests.state, 'pending'),
          lte(connectorReviewRequests.expiresAt, now)
        )
      )
      .all();
    let ended = 0;
    for (const { request, review } of stuck) {
      const finished = this.options.db.transaction((tx) => {
        const changed = tx
          .update(connectorReviewRequests)
          .set({
            state: 'approved',
            resolvedAt: now,
            resolutionSummary: 'Access ready, no updates',
          })
          .where(
            and(
              eq(connectorReviewRequests.id, review.id),
              eq(connectorReviewRequests.state, 'pending')
            )
          )
          .run().changes;
        if (changed !== 1) return false;
        tx.update(connectorAgentRequests)
          .set({ resumeState: 'ready', resolvedEventsJson: canonicalJson(emptyEventSelection()) })
          .where(
            and(
              eq(connectorAgentRequests.id, request.id),
              eq(connectorAgentRequests.resumeState, 'pending')
            )
          )
          .run();
        return true;
      });
      if (finished) {
        this.notifyResolved(request.id);
        ended += 1;
      }
    }
    return ended;
  }

  private materializeAuthenticationFailure(requestId: string): boolean {
    const authentication = this.options.authentication;
    if (!authentication) return false;
    const row = this.requestWithReview(requestId);
    if (
      !row ||
      row.review.state !== 'pending' ||
      row.review.resolutionJson !== null ||
      row.request.outcome !== null
    ) {
      return false;
    }
    const owner = rowOwner(row.review);
    if (!owner) return false;
    const flow = authentication.findByIdempotencyKey(
      owner,
      authenticationIdempotencyKey(row.request.id)
    );
    if (
      !flow ||
      flow.toolkit !== row.request.serviceSlug ||
      (row.review.providerInstanceId !== null &&
        row.review.providerInstanceId !== flow.providerInstanceId) ||
      (flow.state !== 'failed' && flow.state !== 'expired' && flow.state !== 'start_unknown')
    ) {
      return false;
    }
    const resolved = this.resolveTerminal(
      row.request,
      row.review,
      'authentication_failed',
      'Account authentication failed'
    );
    if (resolved) this.notifyResolved(row.request.id);
    return resolved;
  }

  private materializeAuthenticationFailures(): number {
    if (!this.options.authentication) return 0;
    const pending = this.options.db
      .select({ requestId: connectorAgentRequests.id })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(
        and(
          eq(connectorReviewRequests.state, 'pending'),
          isNull(connectorReviewRequests.resolutionJson),
          isNull(connectorAgentRequests.outcome)
        )
      )
      .all();
    let changed = 0;
    for (const { requestId } of pending) {
      if (this.materializeAuthenticationFailure(requestId)) changed += 1;
    }
    return changed;
  }

  private notifyResolved(requestId: string): void {
    for (const resolve of this.waiters.get(requestId) ?? []) resolve();
    this.waiters.delete(requestId);
    this.options.onChanged?.();
  }

  private waitForSignal(requestId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        this.waiters.get(requestId)?.delete(finish);
        resolve();
      };
      const waiters = this.waiters.get(requestId) ?? new Set<() => void>();
      waiters.add(finish);
      this.waiters.set(requestId, waiters);
      const timer = setTimeout(finish, timeoutMs);
      if (signal?.aborted) finish();
      else signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

/** Source adapter that turns one resolved request into one protected follow-up. */
export class ConnectorAgentRequestSourceAdapter implements PrivateSessionMessageSourceAdapter<AgentRequestRef> {
  readonly kind = 'connector_agent_request' as const;

  /** Construct the fixed adapter beside its request service. */
  constructor(
    private readonly db: Db,
    private readonly authority: ConnectorAgentRequestAuthorityPort,
    private readonly bootEpoch: string,
    private readonly eventGrants?: ConnectorEventGrantPort
  ) {}

  /** Consume only the current resume proof after a live hold has ended. */
  consume(tx: DbTransaction, ref: AgentRequestRef, now: string) {
    const row = tx
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(eq(connectorAgentRequests.id, ref.requestId))
      .get();
    if (!row)
      throw new ConnectorAgentRequestError('request_not_found', 'Service request not found.');
    const changed = tx
      .update(connectorAgentRequests)
      .set({ resumeState: 'resumed', liveHoldBootEpoch: null, liveHoldUntil: null })
      .where(
        and(
          eq(connectorAgentRequests.id, ref.requestId),
          eq(connectorAgentRequests.resumeState, 'ready'),
          eq(connectorAgentRequests.sourceGeneration, ref.sourceGeneration),
          eq(connectorAgentRequests.resumeToken, ref.resumeToken),
          or(
            isNull(connectorAgentRequests.liveHoldBootEpoch),
            ne(connectorAgentRequests.liveHoldBootEpoch, this.bootEpoch),
            isNull(connectorAgentRequests.liveHoldUntil),
            lte(connectorAgentRequests.liveHoldUntil, now)
          )
        )
      )
      .run().changes;
    if (changed !== 1) {
      throw new ConnectorAgentRequestError(
        'request_already_resolved',
        'This request resume claim is no longer current.'
      );
    }
    return {
      sourceKind: this.kind,
      sourceId: row.request.id,
      sourceGeneration: ref.sourceGeneration,
      sessionId: row.request.sessionId,
      agentId: row.request.agentId,
      originRuntime: row.request.originRuntime!,
      originAgentPath: row.request.originAgentPath!,
      originAuthorityDigest: row.request.originAuthorityDigest!,
      queuePlaceholder: '[Private service request update]',
    };
  }

  /** Resolve the minimized outcome in memory. */
  async prepare(receipt: SessionMessageAcceptanceReceipt): Promise<PreparedPrivateSessionMessage> {
    const row = this.db
      .select()
      .from(connectorAgentRequests)
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .get();
    if (!row || !row.outcome) {
      throw new ConnectorAgentRequestError(
        'request_not_found',
        'The service request outcome is no longer available.'
      );
    }
    const note = requestNote(
      row,
      row.outcome === 'granted' ? grantedClasses(this.db, row) : undefined
    );
    // The follow-up is the one place the ids ride along with the note: the
    // agent acts on them straight away, in the turn this message starts.
    const content =
      row.outcome === 'granted'
        ? `${note} Use connection ${row.resolvedConnectionId} with only these operation ` +
          `revision IDs: ${parseStringArray(row.resolvedOperationRevisionIdsJson).join(', ')}.`
        : note;
    return {
      sourceKind: this.kind,
      sourceId: row.id,
      sourceGeneration: receipt.sourceGeneration,
      content,
    };
  }

  /** Recheck origin and exact local grant state in the final synchronous claim. */
  revalidate(
    tx: DbTransaction,
    receipt: SessionMessageAcceptanceReceipt,
    prepared: PreparedPrivateSessionMessage
  ): void {
    const row = tx
      .select({ request: connectorAgentRequests, review: connectorReviewRequests })
      .from(connectorAgentRequests)
      .innerJoin(
        connectorReviewRequests,
        eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
      )
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .get();
    if (
      !row ||
      row.request.resumeState !== 'resumed' ||
      row.request.sourceGeneration !== prepared.sourceGeneration ||
      row.request.originAuthorityDigest !== receipt.originAuthorityDigest ||
      !this.authority.revalidateOriginSync(originFromRows(row.request, row.review))
    ) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'The request target changed before the follow-up could start.'
      );
    }
    if (row.request.outcome === 'granted' && !hasExactLiveGrants(tx, row.request)) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'The granted service access changed before the follow-up could start.'
      );
    }
    const events = parseResolvedEventSelection(row.request.resolvedEventsJson);
    if (
      events.selections.length > 0 &&
      (!events.appliedEventScopeHash ||
        !this.eventGrants?.ready(
          originFromRows(row.request, row.review).owner,
          events.selections,
          events.appliedEventScopeHash
        ))
    ) {
      throw new ConnectorAgentRequestError(
        'authority_expired',
        'The granted event access changed before the follow-up could start.'
      );
    }
  }

  /** Keep an ambiguous dispatch terminal and impossible to replay. */
  onOutcomeUnknown(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt): void {
    tx.update(connectorAgentRequests)
      .set({ resumeState: 'cancelled' })
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .run();
  }

  /** Keep a pre-effect refusal terminal and impossible to replay. */
  onCancelled(tx: DbTransaction, receipt: SessionMessageAcceptanceReceipt): void {
    tx.update(connectorAgentRequests)
      .set({ resumeState: 'cancelled' })
      .where(eq(connectorAgentRequests.id, receipt.sourceId))
      .run();
  }
}

type RequestStatusName = ConnectorAgentRequestStatus['status'];

/** The status one stored request reads as. */
function requestStatus(request: ConnectorAgentRequest): RequestStatusName {
  if (request.outcome === 'granted') {
    return request.resumeState === 'pending' ? 'access_pending' : 'granted';
  }
  return request.outcome ?? 'awaiting_owner';
}

/** The action classes a request's answer holds, and what it asked for that the answer leaves out. */
interface GrantedClasses {
  readonly held: ReadonlySet<string>;
  readonly notGranted: Array<'read' | 'write'>;
  /** It asked to hear about new activity and no updates were set up for it. */
  readonly noUpdates: boolean;
}

/** The classes a level covers: Read is `read`; Read and write adds `write`. */
function classesFor(access: ConnectorRequestAccess): Array<'read' | 'write'> {
  return access === 'read' ? ['read'] : ['read', 'write'];
}

/**
 * Compare what an agent asked for with what its answer gave it, by class
 * (read, write), never by action name (DOR-2503). A class the answer holds no
 * action of is not granted, unless the account offers no action of that class
 * at all: nobody can grant what an app does not have, so that is never
 * reported as a refusal.
 */
function grantedClasses(db: Db | DbTransaction, request: ConnectorAgentRequest): GrantedClasses {
  const ids = parseStringArray(request.resolvedOperationRevisionIdsJson);
  const held = new Set(
    ids.length === 0
      ? []
      : db
          .select({ classification: connectorOperationRevisions.capabilityClassification })
          .from(connectorOperationRevisions)
          .where(inArray(connectorOperationRevisions.id, ids))
          .all()
          .map((revision) => revision.classification)
  );
  const account = request.resolvedConnectionId
    ? db
        .select({
          providerInstanceId: connections.providerInstanceId,
          toolkit: connections.toolkit,
        })
        .from(connections)
        .where(eq(connections.id, request.resolvedConnectionId))
        .get()
    : undefined;
  const offered = new Set(
    account
      ? db
          .selectDistinct({ classification: connectorOperationRevisions.capabilityClassification })
          .from(connectorOperationRevisions)
          .where(
            and(
              eq(connectorOperationRevisions.providerInstanceId, account.providerInstanceId),
              eq(connectorOperationRevisions.toolkit, account.toolkit)
            )
          )
          .all()
          .map((revision) => revision.classification)
      : []
  );
  return {
    held,
    notGranted: classesFor(request.requestedAccess).filter(
      (kind) => !held.has(kind) && offered.has(kind)
    ),
    noUpdates:
      parseStringArray(request.requestedEventsJson).length > 0 &&
      !parseResolvedEventSelection(request.resolvedEventsJson).appliedEventScopeHash,
  };
}

/** What a granted agent can now do in an app, in words. */
function grantedVerb(held: ReadonlySet<string>): string {
  if (held.has('read') && held.has('write')) return 'read and change things in';
  if (held.has('read')) return 'read';
  if (held.has('write')) return 'change things in';
  return 'use';
}

/**
 * The plain note every request status carries: what happens next, or what
 * the person must do, in words an agent can pass on as they are. One place
 * writes them, so the held call, a later check and the follow-up message in
 * the chat all say the same thing.
 */
function requestNote(request: ConnectorAgentRequest, answer?: GrantedClasses): string {
  const app = serviceNameFromToolkit(request.serviceSlug);
  switch (requestStatus(request)) {
    case 'awaiting_owner':
      return (
        "The person hasn't answered yet. They can answer on the card in the chat where you " +
        'asked, or under Needs you on the Connections page in DorkOS. Their answer comes back ' +
        "to this chat when they give it, so don't ask again; carry on with anything that " +
        `doesn't need ${app}.`
      );
    case 'access_pending':
      return (
        `The person allowed it, and DorkOS is still setting up your access to ${app}. You'll ` +
        "hear here when it's ready, so don't ask again."
      );
    case 'granted': {
      const classes = answer ?? { held: new Set<string>(), notGranted: [], noUpdates: false };
      const missing = classes.notGranted.map((kind) =>
        kind === 'write' ? `change anything in ${app}` : `read ${app}`
      );
      return [
        `You can now ${grantedVerb(classes.held)} ${app}.`,
        ...(classes.noUpdates
          ? [`You won't get updates when something new happens in ${app}.`]
          : []),
        ...(missing.length > 0
          ? [
              `The person didn't allow you to ${missing.join(' or ')}. Do what you can with ` +
                "what you have, tell the person what you couldn't do, and ask again only if " +
                'you still need it.',
            ]
          : ['Carry on with what you were doing.']),
      ].join(' ');
    }
    case 'denied':
      return `The person said no to ${app}. Don't ask again unless they bring it up.`;
    case 'expired':
      return `Nobody answered in time, so nothing changed. Ask again only if you still need ${app}.`;
    case 'authentication_failed':
      return (
        `Signing in to ${app} didn't finish, so nothing was shared. Ask the person before ` +
        'trying again.'
      );
    case 'target_deleted':
      return (
        'This request is closed because the chat or agent it came from is gone. Nothing was ' +
        'shared.'
      );
  }
}

/**
 * The refusal for an app the agent already asked for in another chat, saying
 * only what is true: whether it was answered, and whether that answer (or
 * ask) covers what this chat needs.
 */
function elsewhereMessage(
  app: string,
  wanted: ConnectorRequestAccess,
  asked: ConnectorRequestAccess,
  held: ReadonlySet<string> | null
): string {
  const needsChange = wanted === 'read-write';
  if (held) {
    const covered = !needsChange || held.has('write');
    return (
      `The person already allowed you to ${grantedVerb(held)} ${app} when you asked in ` +
      "another chat. List your accounts again to use it here; don't ask again." +
      (covered
        ? ''
        : ` That doesn't cover changing things there. If this chat needs that, ask for ` +
          `"read-write" once that answer reaches the other chat.`)
    );
  }
  const covered = !needsChange || asked === 'read-write';
  return (
    `You already asked for ${app} in another chat, and the person hasn't answered yet. They ` +
    'can answer it there, or under Needs you on the Connections page in DorkOS. ' +
    (covered
      ? `If they allow it, you can use ${app} in this chat too, so don't ask again here.`
      : `That request asks only to read ${app}. If this chat needs to change things there, ` +
        'ask again once the person has answered it.')
  );
}

/**
 * One agent's open request for one app: unanswered, or allowed and not yet
 * delivered, and in either case not past its time. Exported for its own test.
 *
 * @internal
 */
export function openAgentRequest(
  tx: Db | DbTransaction,
  agentId: string,
  serviceSlug: string,
  now: string
) {
  return tx
    .select({ request: connectorAgentRequests, review: connectorReviewRequests })
    .from(connectorAgentRequests)
    .innerJoin(
      connectorReviewRequests,
      eq(connectorAgentRequests.reviewRequestId, connectorReviewRequests.id)
    )
    .where(
      and(
        eq(connectorAgentRequests.agentId, agentId),
        eq(connectorAgentRequests.serviceSlug, serviceSlug),
        eq(connectorReviewRequests.requesterKind, 'agent'),
        or(
          // Unanswered, and still within its time.
          and(
            eq(connectorReviewRequests.state, 'pending'),
            gt(connectorReviewRequests.expiresAt, now)
          ),
          // Allowed, with the answer on its way to the agent. One still
          // waiting on updates past its time is not open: it is ended as
          // allowed without updates (`finishUnreadyUpdates`).
          and(
            eq(connectorAgentRequests.outcome, 'granted'),
            or(
              eq(connectorAgentRequests.resumeState, 'ready'),
              and(
                eq(connectorAgentRequests.resumeState, 'pending'),
                gt(connectorReviewRequests.expiresAt, now)
              )
            )
          )
        )
      )
    )
    .orderBy(asc(connectorAgentRequests.createdAt))
    .get();
}

/** The owner-visible context a request's review keeps: what was asked, never an account. */
function reviewContext(action: {
  serviceSlug: string;
  reason: string;
  access: ConnectorRequestAccess;
  requestedEvents: readonly string[];
}) {
  return {
    serviceSlug: action.serviceSlug,
    reason: action.reason,
    access: action.access,
    requestedEvents: action.requestedEvents,
  };
}

/**
 * Raise an unanswered request in place when the agent asks the same app for
 * more: Read and write after Read, or events it had not named. It never
 * lowers what is asked, and the agent's first reason stays: a reworded ask is
 * the same ask. A request already being answered is left alone. Returns
 * whether anything changed.
 */
function raiseOpenRequest(
  tx: DbTransaction,
  open: NonNullable<ReturnType<typeof openAgentRequest>>,
  input: ConnectorAgentConnectionRequestInput
): boolean {
  if (
    open.review.state !== 'pending' ||
    open.review.resolutionJson !== null ||
    open.request.outcome !== null
  ) {
    return false;
  }
  const access: ConnectorRequestAccess =
    input.access === 'read-write' ? 'read-write' : open.request.requestedAccess;
  const before = parseStringArray(open.request.requestedEventsJson);
  const events = [...new Set([...before, ...input.requestedEvents])].slice(
    0,
    CONNECTOR_EVENT_REVIEW_SCOPE_LIMIT
  );
  if (access === open.request.requestedAccess && events.length === before.length) return false;
  const action = {
    version: 1 as const,
    kind: 'agent_connection_request' as const,
    serviceSlug: open.request.serviceSlug,
    reason: open.request.reason,
    access,
    requestedEvents: events,
  };
  tx.update(connectorAgentRequests)
    .set({ requestedAccess: access, requestedEventsJson: canonicalJson(events) })
    .where(eq(connectorAgentRequests.id, open.request.id))
    .run();
  tx.update(connectorReviewRequests)
    .set({
      actionHash: digest(action),
      actionPayloadJson: canonicalJson(action),
      reviewContextJson: canonicalJson(reviewContext(action)),
    })
    .where(eq(connectorReviewRequests.id, open.review.id))
    .run();
  return true;
}

function originFromRows(
  request: ConnectorAgentRequest,
  review: typeof connectorReviewRequests.$inferSelect
): ConnectorAgentRequestOrigin {
  const owner = rowOwner(review);
  if (
    !owner ||
    !request.originRuntime ||
    !request.originAgentPath ||
    !request.originAuthorityDigest
  ) {
    throw new Error('Incomplete request origin');
  }
  return {
    owner,
    runtime: request.originRuntime,
    sessionId: request.sessionId,
    agentId: request.agentId,
    agentPath: request.originAgentPath,
    authorityDigest: request.originAuthorityDigest,
  };
}

function hasExactLiveGrants(tx: Db | DbTransaction, request: ConnectorAgentRequest): boolean {
  if (!request.resolvedConnectionId) return false;
  const selected = parseStringArray(request.resolvedOperationRevisionIdsJson);
  if (selected.length === 0) return false;
  const connection = tx
    .select()
    .from(connections)
    .where(eq(connections.id, request.resolvedConnectionId))
    .get();
  if (
    !connection ||
    connection.status !== 'active' ||
    connection.lifecycleState !== 'connected' ||
    !connection.enabled ||
    connection.grantReconciliationStatus !== 'ready'
  ) {
    return false;
  }
  // Every granted revision must still be live for this agent. Access added
  // since (another grant, "Every agent") changes nothing the follow-up relies
  // on; a revision taken away does, and refuses it.
  const access = liveAgentRevisionIds(tx, {
    agentId: request.agentId,
    sessionId: request.sessionId,
    connectionId: request.resolvedConnectionId,
  });
  // A session override that now shuts the agent out refuses the follow-up.
  if ('denied' in access) return false;
  return selected.every((id) => access.ids.has(id));
}

/**
 * The operation revisions one agent can use on one account in the request's
 * own session right now, with the same precedence the execution check uses
 * (`agentGrantScope`): a session override decides alone, otherwise the
 * agent's own grants and, where honoured, "Every agent". A denying override
 * returns its reason instead of an empty set, so a refusal can say why.
 */
function liveAgentRevisionIds(
  tx: Db | DbTransaction,
  input: { agentId: string; sessionId: string; connectionId: string }
): { denied: AgentGrantDenial } | { ids: Set<string> } {
  const scope = agentGrantScope(tx, {
    agentId: input.agentId,
    sessionId: input.sessionId,
    connectionId: input.connectionId,
  });
  if (scope.kind === 'denied') return { denied: scope.reason };
  return {
    ids: new Set(
      tx
        .select({ id: connectionOperationGrants.operationRevisionId })
        .from(connectionOperationGrants)
        .where(
          and(
            scope.subject,
            eq(connectionOperationGrants.connectionId, input.connectionId),
            isNull(connectionOperationGrants.revokedAt)
          )
        )
        .all()
        .map((grant) => grant.id)
    ),
  };
}

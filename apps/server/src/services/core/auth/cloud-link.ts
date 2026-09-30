/**
 * Cloud-link instance-token lifecycle for the running DorkOS server
 * (accounts-and-auth P2, task 2.4).
 *
 * Owns the state machine and side effects around device-linking this instance to
 * a DorkOS account: it drives the RFC 8628 device flow via the pure
 * {@link ./cloud-link-client.js | cloud-link client}, persists the issued scoped
 * API key at config `cloud.instanceToken` (the sensitive-field pattern, same
 * handling as `tunnel.authtoken`), and heartbeats on startup and every 15
 * minutes while linked.
 *
 * The heartbeat is the one authoritative check of the key: only a heartbeat
 * `401` marks the instance unlinked, clearing the token and stopping — it never
 * retry-loops a dead key. A `401` from any other cloud call (the managed
 * connector routes) is not proof on its own, since one route can refuse a key
 * that is still good (DOR-2620): it triggers one confirming heartbeat with that
 * same key (concurrent refusals share it, and a check that kept the key answers
 * for later refusals for a few minutes). The refused call fails once that check
 * settles: with its own `unauthorized` error when the key is gone, or as a
 * plain refused request (`request_failed`, status 401) when it was kept, so
 * nothing downstream tells the person they are unlinked while they are not.
 * Either way, when the caller sees the error, the link state already says
 * whether the key is gone.
 *
 * Every path that drops a key (unlink, a heartbeat `401`) keeps that key's relink proof
 * (an HMAC keyed by it, see `linkProofForKey`) at `cloud.previousLinkProof`;
 * the next link request carries that proof (or the held key's, when re-linking
 * while linked) so the cloud can continue the same
 * link for the same DorkOS account, and a successful link clears it (DOR-2521).
 *
 * This is deliberately INDEPENDENT of `config.auth.enabled` (local login and the
 * cloud link are orthogonal). The token value is never logged.
 *
 * The `dorkos cloud` CLI runs the same device flow headlessly against the client
 * primitives directly (no running server), so it does not use this singleton.
 *
 * @module services/core/auth/cloud-link
 */
import { createHash } from 'node:crypto';
import type { ConnectorEventPageRequest } from '@dorkos/shared/connector-events';
import { configManager } from '../config-manager.js';
import type {
  ManagedConnectorAuthorityCommand,
  ManagedConnectorAuthorityCommandStatus,
  ManagedConnectorExecutionReceipt,
  ManagedConnectorExecutionReceiptStatus,
  ManagedConnectorExecutionRequest,
  ManagedConnectorExecutionResponse,
} from '@dorkos/shared/connector-managed-schemas';
import type {
  ManagedConnectorUsageRequest,
  ManagedConnectorUsageResponse,
} from '@dorkos/shared/connector-managed-usage-schemas';
import type {
  ManagedConnectorAccount,
  ManagedConnectorAccountListRequest,
  ManagedConnectorAccountListResponse,
  ManagedConnectorAuthenticationCreateRequest,
  ManagedConnectorAuthenticationState,
  ManagedConnectorCatalogPage,
  ManagedConnectorCatalogRequest,
  ManagedConnectorOperationPageRequest,
  ManagedConnectorOperationPageResponse,
  ManagedConnectorToolkitVersionRequest,
  ManagedConnectorToolkitVersionResponse,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import { logConfigWrite } from '../operator/config-write.js';
import { logger, logError } from '../../../lib/logger.js';
import { env } from '../../../env.js';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import {
  buildInstanceDescriptor,
  linkProofForKey,
  executeManagedConnectorOperation,
  ManagedConnectorCloudError,
  ManagedConnectorLinkRequiredError,
  pollForToken,
  requestManagedConnectorAccount,
  requestManagedConnectorAccounts,
  requestManagedConnectorAuthentication,
  requestManagedConnectorAuthenticationState,
  requestManagedConnectorExecutionReceipt,
  requestManagedConnectorCatalog,
  requestManagedConnectorOperationSchemas,
  requestManagedConnectorEventDefinitions,
  requestManagedConnectorEventPull,
  requestManagedConnectorEventAck,
  requestManagedConnectorToolkitVersion,
  requestManagedConnectorUsage,
  readManagedConnectorAuthorityCommand,
  requestDeviceCode,
  resolveCloudBaseUrl,
  revokeInstanceKey,
  sendHeartbeat,
  submitManagedConnectorAuthorityCommand,
  type FetchLike,
  type InstanceDescriptor,
} from './cloud-link-client.js';
import { resolveLinkTelemetryInstanceId } from './link-telemetry.js';

/** How often a linked instance heartbeats the cloud. */
const HEARTBEAT_INTERVAL_MS = 15 * 60 * 1000;
/** Upper bound on a confirming heartbeat, which the refused call waits for. */
const KEY_CHECK_TIMEOUT_MS = 10_000;
/**
 * How long a key check that kept the key answers for later refusals of the same
 * key. Sequential callers (recovery passes, the event pull, sign-in refreshes)
 * would otherwise each send a heartbeat while a route keeps refusing. Five
 * minutes caps confirming heartbeats at 12 an hour per key, and delays noticing
 * a key the account really let go by at most that long: its calls fail either
 * way, and the scheduled heartbeat still runs.
 */
const KEY_CHECK_COOLDOWN_MS = 5 * 60 * 1000;
let nextLinkGeneration = 0;

interface LinkContext {
  generation: number;
  token: string;
  baseUrl: string;
}

/** Reason surfaced to the UI when the cloud revokes this instance's key. */
export const UNLINKED_REASON = 'This instance was unlinked';

/** The link-flow state the client UI reads. */
export type CloudLinkState = 'idle' | 'pending' | 'linked' | 'expired' | 'denied' | 'unlinked';

/** The `GET /api/cloud/link/status` shape. */
export interface CloudLinkStatus {
  state: CloudLinkState;
  accountLabel?: string;
  lastHeartbeatAt?: string;
}

/** The `GET /api/cloud/status` settled-summary shape. */
export interface CloudLinkSummary {
  linked: boolean;
  accountLabel: string | null;
  lastHeartbeatAt: string | null;
}

/** The `POST /api/cloud/link/start` shape (codes for the human to enter). */
export interface StartLinkResult {
  userCode: string;
  verificationUri: string;
  expiresAt: string;
}

/** Config read/write seam over the `cloud.*` section, injectable for tests. */
export interface CloudConfigPort {
  getToken(): string | null;
  getAccountLabel(): string | null;
  /** The kept relink proof of the last dropped instance key, or `null` (also when absent). */
  getPreviousLinkProof(): string | null;
  /** Store a newly issued key. A new link consumes any kept relink proof (sets it `null`). */
  save(link: { instanceToken: string; instanceName: string }): void;
  setAccountLabel(label: string | null): void;
  /**
   * Drop the instance key, name and account label, keeping `previousLinkProof`
   * so the next link can ask the cloud to continue this one.
   */
  clear(keep: { previousLinkProof: string | null }): void;
}

/** Default config port backed by the `configManager` singleton (resolved lazily). */
function defaultConfigPort(): CloudConfigPort {
  return {
    getToken: () => configManager.get('cloud')?.instanceToken ?? null,
    getAccountLabel: () => configManager.get('cloud')?.linkedAccountLabel ?? null,
    // Configs written before the field existed carry no leaf at all; absence is `null`.
    getPreviousLinkProof: () => configManager.get('cloud')?.previousLinkProof ?? null,
    save: ({ instanceToken, instanceName }) => {
      const current = configManager.get('cloud');
      // `cloud.instanceToken` is registered in SENSITIVE_CONFIG_KEYS; the write
      // path mirrors how `tunnel.authtoken` is stored (whole-section set). The
      // token value is never logged — `logConfigWrite` names paths only. The
      // new link has consumed any kept relink proof, so it goes too.
      configManager.set('cloud', {
        ...current,
        instanceToken,
        instanceName,
        previousLinkProof: null,
      });
      logConfigWrite('the account link', 'cloud', current, configManager.get('cloud'));
    },
    setAccountLabel: (label) => {
      // The heartbeat reports the owning account's label; persist it so
      // `GET /api/cloud/status` and `dorkos cloud status` can show which account
      // this instance is linked to. No-op write when unchanged.
      const current = configManager.get('cloud');
      if ((current?.linkedAccountLabel ?? null) === label) return;
      configManager.set('cloud', { ...current, linkedAccountLabel: label });
      logConfigWrite('the account link', 'cloud', current, configManager.get('cloud'));
    },
    clear: ({ previousLinkProof }) => {
      const current = configManager.get('cloud');
      configManager.set('cloud', {
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
        previousLinkProof,
      });
      logConfigWrite('unlinking this instance', 'cloud', current, configManager.get('cloud'));
    },
  };
}

/**
 * Default telemetry-instance-id resolver backed by the live config + server env.
 * Returns the anonymous per-install id only when the operator opted into linking
 * analytics (`telemetry.linkAnalyticsToAccount`) and no env kill switch is set;
 * otherwise `undefined`, so the descriptor omits it.
 */
function defaultResolveTelemetryInstanceId(): Promise<string | undefined> {
  return resolveLinkTelemetryInstanceId({
    linkAnalyticsToAccount: configManager.get('telemetry')?.linkAnalyticsToAccount ?? false,
    dorkHome: resolveDorkHome(),
    env: {
      DO_NOT_TRACK: env.DO_NOT_TRACK,
      DORKOS_TELEMETRY_DISABLED: env.DORKOS_TELEMETRY_DISABLED,
    },
  });
}

/** Injectable clock/transport hooks (real implementations by default). */
export interface CloudLinkManagerOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  config?: CloudConfigPort;
  heartbeatIntervalMs?: number;
  /**
   * Resolve the anonymous telemetry instance id to carry in the link descriptor
   * (the analytics-merge opt-in). Injectable so tests drive the opt-in without
   * touching config or the env; defaults to {@link defaultResolveTelemetryInstanceId}.
   */
  resolveTelemetryInstanceId?: () => Promise<string | undefined>;
  /** Persist a hosted authoritative receipt in the separate local mirror. */
  observeManagedReceipt?: (receipt: ManagedConnectorExecutionReceipt) => void | Promise<void>;
}

/**
 * Singleton lifecycle manager for device-linking this instance to a DorkOS
 * account. Constructed with injectable transport/clock hooks so tests exercise
 * the full flow with a mock `fetch` and no real timers; the production
 * instance is built by {@link initCloudLinkManager} with no options (real
 * `fetch`, real defaults).
 */
export class CloudLinkManager {
  private readonly fetchImpl: FetchLike | undefined;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly now: () => number;
  private readonly heartbeatIntervalMs: number;
  private readonly resolveTelemetryInstanceId: () => Promise<string | undefined>;
  private observeManagedReceipt:
    ((receipt: ManagedConnectorExecutionReceipt) => void | Promise<void>) | undefined;
  private syncManagedProvider: (() => void | Promise<void>) | undefined;
  private configPort: CloudConfigPort | undefined;

  private state: CloudLinkState = 'idle';
  private lastHeartbeatAt: string | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pollController: AbortController | undefined;
  private pollTask: Promise<void> | undefined;
  private keyCheck:
    { context: LinkContext; settled: Promise<void>; keptAt: number | undefined } | undefined;
  private linkGeneration = ++nextLinkGeneration;

  constructor(private readonly options: CloudLinkManagerOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.sleep = options.sleep;
    this.now = options.now ?? Date.now;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.resolveTelemetryInstanceId =
      options.resolveTelemetryInstanceId ?? defaultResolveTelemetryInstanceId;
    this.observeManagedReceipt = options.observeManagedReceipt;
    this.configPort = options.config;
  }

  /** Resolve the config port lazily so the singleton can be built before `configManager` init. */
  private get config(): CloudConfigPort {
    if (!this.configPort) this.configPort = defaultConfigPort();
    return this.configPort;
  }

  /** Process-local identity of this lifecycle, including same-token replacements. */
  get generation(): number {
    return this.linkGeneration;
  }

  private advanceGeneration(): number {
    this.linkGeneration = ++nextLinkGeneration;
    return this.linkGeneration;
  }

  private captureContext(token: string, baseUrl = resolveCloudBaseUrl()): LinkContext {
    return { generation: this.linkGeneration, token, baseUrl };
  }

  private ownsContext(context: LinkContext): boolean {
    return (
      this.linkGeneration === context.generation &&
      this.config.getToken() === context.token &&
      resolveCloudBaseUrl() === context.baseUrl
    );
  }

  /**
   * Begin the device flow: request a code, enter `pending`, and kick off the
   * background poll that carries the flow to `linked`/`denied`/`expired`. Returns
   * the codes for the human to enter; the client polls {@link getStatus} for the
   * outcome.
   */
  async startLink(): Promise<StartLinkResult> {
    const generation = this.advanceGeneration();
    this.cancelPoll();
    const baseUrl = resolveCloudBaseUrl();
    // Resolve the analytics-merge opt-in HERE, at link time: the descriptor built
    // now is what the cloud persists and reads to alias this install's anonymous
    // history onto the account. Heartbeats deliberately never carry the id.
    const telemetryInstanceId = await this.resolveTelemetryInstanceId();
    if (generation !== this.linkGeneration) throw new Error('Cloud link request was superseded');
    const previousLinkProof = this.previousLinkProof();
    const descriptor = {
      ...buildInstanceDescriptor(telemetryInstanceId),
      ...(previousLinkProof ? { previousLinkProof } : {}),
    };
    const codes = await requestDeviceCode({ baseUrl, descriptor, fetchImpl: this.fetchImpl });

    if (generation !== this.linkGeneration || baseUrl !== resolveCloudBaseUrl()) {
      throw new Error('Cloud link request was superseded');
    }

    this.setState('pending');
    const controller = new AbortController();
    this.pollController = controller;
    this.pollTask = this.runPoll(baseUrl, descriptor, codes, controller.signal, generation);

    return {
      userCode: codes.user_code,
      verificationUri: codes.verification_uri,
      expiresAt: new Date(this.now() + codes.expires_in * 1000).toISOString(),
    };
  }

  /**
   * The relink proof a link request carries: the key held right now
   * (re-linking while linked), else the proof kept from the last dropped key.
   */
  private previousLinkProof(): string | null {
    const token = this.config.getToken();
    return token ? linkProofForKey(token) : this.config.getPreviousLinkProof();
  }

  /** Clear the link locally, keeping the relink proof of whatever key is being dropped. */
  private clearKeepingProof(): void {
    this.config.clear({ previousLinkProof: this.previousLinkProof() });
  }

  private async runPoll(
    baseUrl: string,
    descriptor: InstanceDescriptor,
    codes: { device_code: string; interval: number; expires_in: number },
    signal: AbortSignal,
    generation: number
  ): Promise<void> {
    try {
      const result = await pollForToken({
        baseUrl,
        deviceCode: codes.device_code,
        interval: codes.interval,
        expiresIn: codes.expires_in,
        fetchImpl: this.fetchImpl,
        sleep: this.sleep,
        now: this.now,
        signal,
      });
      this.settlePoll(signal);
      if (signal.aborted || generation !== this.linkGeneration || baseUrl !== resolveCloudBaseUrl())
        return;
      if (result.status === 'approved') {
        this.config.save({ instanceToken: result.accessToken, instanceName: descriptor.name });
        const context = this.captureContext(result.accessToken, baseUrl);
        this.setState('linked');
        await this.notifyManagedProviderSync();
        if (!this.ownsContext(context)) return;
        await this.heartbeat(baseUrl, descriptor, result.accessToken, generation);
        if (this.ownsContext(context)) this.startHeartbeatSchedule();
      } else {
        this.setState(result.status === 'denied' ? 'denied' : 'expired');
      }
    } catch (err) {
      this.settlePoll(signal);
      if (!signal.aborted && generation === this.linkGeneration) {
        logger.warn('[CloudLink] Device-link poll failed', logError(err));
        this.setState('idle');
      }
    }
  }

  /** A settled poll no longer counts as a pending re-link (see {@link markUnlinked}). */
  private settlePoll(signal: AbortSignal): void {
    if (this.pollController?.signal === signal) this.pollController = undefined;
  }

  /**
   * Heartbeat now (if linked) and, on success, start the 15-minute schedule.
   * Called once at server startup. Non-throwing and independent of
   * `config.auth.enabled`.
   */
  async initOnStartup(): Promise<void> {
    const token = this.config.getToken();
    if (!token) return;
    const context = this.captureContext(token);
    this.setState('linked');
    await this.heartbeat(context.baseUrl, buildInstanceDescriptor(), token, context.generation);
    // Only schedule if the startup heartbeat did not just unlink us (401).
    if (this.ownsContext(context)) this.startHeartbeatSchedule();
  }

  /**
   * User-initiated unlink: withdraw locally before best-effort remote revoke.
   * The revoke retains only the retiring credential and cannot affect a new link.
   */
  async unlink(): Promise<void> {
    const token = this.config.getToken();
    const baseUrl = resolveCloudBaseUrl();
    this.advanceGeneration();
    this.cancelPoll();
    this.stopHeartbeatSchedule();
    this.clearKeepingProof();
    this.lastHeartbeatAt = undefined;
    this.setState('idle');
    const reconciliation = this.notifyManagedProviderSync();
    const revocation = token
      ? revokeInstanceKey({
          baseUrl,
          accessToken: token,
          fetchImpl: this.fetchImpl,
        })
      : undefined;
    await reconciliation;
    await revocation;
  }

  /** The link-flow state for `GET /api/cloud/link/status`. */
  getStatus(): CloudLinkStatus {
    const accountLabel = this.config.getAccountLabel();
    return {
      state: this.state,
      ...(accountLabel ? { accountLabel } : {}),
      ...(this.lastHeartbeatAt ? { lastHeartbeatAt: this.lastHeartbeatAt } : {}),
    };
  }

  /** The settled linked/unlinked summary for `GET /api/cloud/status`. */
  getSummary(): CloudLinkSummary {
    return {
      linked: this.config.getToken() != null,
      accountLabel: this.config.getAccountLabel(),
      lastHeartbeatAt: this.lastHeartbeatAt ?? null,
    };
  }

  /** Whether this instance holds a key (a refused call's key check may since have dropped it). */
  isLinked(): boolean {
    return this.config.getToken() != null;
  }

  /** Hash the current linked key for provider material-generation tracking. */
  managedConnectorMaterialDigest(): string | undefined {
    const token = this.config.getToken();
    return token
      ? createHash('sha256').update(`dorkos:managed-connector:${token}`).digest('hex')
      : undefined;
  }

  /** Attach the provider-registry reconciliation callback during server composition. */
  setManagedProviderSync(sync: () => void | Promise<void>): void {
    this.syncManagedProvider = sync;
  }

  /** Submit one durable managed connector authority command with the current linked key. */
  async submitConnectorAuthorityCommand(
    command: ManagedConnectorAuthorityCommand,
    signal?: AbortSignal
  ): Promise<ManagedConnectorAuthorityCommandStatus> {
    const token = this.requireConnectorToken();
    const context = this.captureContext(token);
    try {
      return await submitManagedConnectorAuthorityCommand({
        baseUrl: context.baseUrl,
        accessToken: token,
        command,
        fetchImpl: this.fetchImpl,
        signal,
      });
    } catch (error) {
      throw await this.afterRefusal(error, context);
    }
  }

  /** Read one durable managed connector authority command with the current linked key. */
  async readConnectorAuthorityCommand(
    commandId: string,
    signal?: AbortSignal
  ): Promise<ManagedConnectorAuthorityCommandStatus> {
    const token = this.requireConnectorToken();
    const context = this.captureContext(token);
    try {
      return await readManagedConnectorAuthorityCommand({
        baseUrl: context.baseUrl,
        accessToken: token,
        commandId,
        fetchImpl: this.fetchImpl,
        signal,
      });
    } catch (error) {
      throw await this.afterRefusal(error, context);
    }
  }

  /** Read one account-free managed toolkit page. */
  listManagedConnectorCatalog(
    request: ManagedConnectorCatalogRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorCatalogPage> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorCatalog({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
  }

  /** Resolve one exact managed toolkit version. */
  resolveManagedConnectorToolkitVersion(
    request: ManagedConnectorToolkitVersionRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorToolkitVersionResponse> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorToolkitVersion({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
  }

  /** Read one immutable managed operation-schema page. */
  listManagedConnectorOperationSchemas(
    request: ManagedConnectorOperationPageRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorOperationPageResponse> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorOperationSchemas({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
  }

  /** Discover exact server-owned notification definitions for one service. */
  listManagedConnectorEventDefinitions(
    request: Omit<ConnectorEventPageRequest, 'signal'>,
    signal: AbortSignal
  ) {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorEventDefinitions({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        signal,
        fetchImpl: this.fetchImpl,
      })
    );
  }

  /** Lease hosted notifications independently of live vendor readiness. */
  pullManagedConnectorEvents(limit: number, signal: AbortSignal) {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorEventPull({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        limit,
        signal,
        fetchImpl: this.fetchImpl,
      })
    );
  }

  /** Confirm exact durable local handoffs; this does not claim destination completion. */
  acknowledgeManagedConnectorEvents(
    events: Array<{ id: string; leaseToken: string }>,
    signal: AbortSignal
  ) {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorEventAck({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        events,
        signal,
        fetchImpl: this.fetchImpl,
      })
    );
  }

  /** Read one bounded managed connection inventory page. */
  listManagedConnectorAccounts(
    request: ManagedConnectorAccountListRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorAccountListResponse> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorAccounts({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
  }

  /** Read one exact managed connection. */
  async getManagedConnectorAccount(
    managedConnectionId: string,
    signal: AbortSignal
  ): Promise<ManagedConnectorAccount> {
    const response = await this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorAccount({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        managedConnectionId,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
    return response.account;
  }

  /** Start one idempotent managed provider-authentication flow. */
  async startManagedConnectorAuthentication(
    request: ManagedConnectorAuthenticationCreateRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorAuthenticationState> {
    try {
      return await this.withManagedConnectorToken((accessToken) =>
        requestManagedConnectorAuthentication({
          baseUrl: resolveCloudBaseUrl(),
          accessToken,
          request,
          fetchImpl: this.fetchImpl,
          signal,
        })
      );
    } catch (error) {
      if (error instanceof ManagedConnectorCloudError) {
        logger.warn('[CloudLink] Managed authentication start did not complete', {
          code: error.code,
          status: error.status,
        });
      }
      throw error;
    }
  }

  /** Read one exact managed provider-authentication flow. */
  getManagedConnectorAuthenticationState(
    flowId: string,
    signal: AbortSignal
  ): Promise<ManagedConnectorAuthenticationState> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorAuthenticationState({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        flowId,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
  }

  /** Attach the process-local durable hosted-receipt sink during server composition. */
  setManagedReceiptObserver(
    observer: (receipt: ManagedConnectorExecutionReceipt) => void | Promise<void>
  ): void {
    this.observeManagedReceipt = observer;
  }

  /** Execute one managed attempt and observe any returned authoritative receipt. */
  async executeManagedConnectorOperation(
    request: ManagedConnectorExecutionRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorExecutionResponse> {
    const response = await this.withManagedConnectorToken((accessToken) =>
      executeManagedConnectorOperation({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
    if ('receipt' in response) await this.observeReceipt(response.receipt);
    return response;
  }

  /** Read one hosted receipt for recovery and observe it when terminal. */
  async getManagedConnectorExecutionReceipt(
    attemptId: string,
    signal: AbortSignal
  ): Promise<ManagedConnectorExecutionReceiptStatus> {
    const response = await this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorExecutionReceipt({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        attemptId,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
    if (response.state === 'recorded') await this.observeReceipt(response.receipt);
    return response;
  }

  /** Read one authoritative hosted managed-usage page. */
  listManagedConnectorUsage(
    request: ManagedConnectorUsageRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorUsageResponse> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorUsage({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
  }

  /** Stop all timers and cancel any in-flight poll (server shutdown). */
  stop(): void {
    this.advanceGeneration();
    this.cancelPoll();
    this.stopHeartbeatSchedule();
  }

  /** The in-flight background poll, exposed so tests can await settlement. */
  get pendingLink(): Promise<void> | undefined {
    return this.pollTask;
  }

  private async withManagedConnectorToken<T>(
    request: (accessToken: string) => Promise<T>
  ): Promise<T> {
    const token = this.requireConnectorToken();
    const context = this.captureContext(token);
    try {
      return await request(token);
    } catch (error) {
      throw await this.afterRefusal(error, context);
    }
  }

  private async observeReceipt(receipt: ManagedConnectorExecutionReceipt): Promise<void> {
    if (!this.observeManagedReceipt) return;
    try {
      await this.observeManagedReceipt(receipt);
    } catch (error) {
      logger.warn(
        '[CloudLink] Managed receipt mirror failed; recovery will retry',
        logError(error)
      );
    }
  }

  private async notifyManagedProviderSync(): Promise<void> {
    if (!this.syncManagedProvider) return;
    try {
      await this.syncManagedProvider();
    } catch (error) {
      logger.warn('[CloudLink] Managed provider registration failed', logError(error));
    }
  }

  private async heartbeat(
    baseUrl: string,
    descriptor: InstanceDescriptor,
    accessToken: string,
    generation: number,
    signal?: AbortSignal
  ): Promise<void> {
    let result: Awaited<ReturnType<typeof sendHeartbeat>>;
    try {
      result = await sendHeartbeat({
        baseUrl,
        accessToken,
        descriptor,
        fetchImpl: this.fetchImpl,
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // An unreadable answer says nothing about the key: transient.
      result = {
        ok: false,
        unauthorized: false,
        error: error instanceof Error ? error.message : 'unreadable response',
      };
    }
    const context = { generation, token: accessToken, baseUrl };
    if (!this.ownsContext(context)) return;
    if (result.ok) {
      this.lastHeartbeatAt = result.lastSeenAt;
      this.config.setAccountLabel(result.accountLabel);
      // A good answer for the key still held never hides a re-link in progress.
      if (!this.relinkPending()) this.setState('linked');
    } else if (result.unauthorized) {
      this.markUnlinked(context);
    } else {
      // Transient (network / 5xx): keep the token and the schedule; retry next tick.
      logger.warn(`[CloudLink] Heartbeat failed (transient): ${result.error}`);
    }
  }

  /**
   * The error a refused managed call throws once the key check settles. Only
   * an `unauthorized` refusal is checked; any other error passes unchanged.
   * When the key is gone (or the call's link was replaced meanwhile) the
   * original error goes on; when this link kept its key, the call was one
   * refused request, not an unlinked computer, and says so.
   */
  private async afterRefusal(error: unknown, context: LinkContext): Promise<unknown> {
    if (!(error instanceof ManagedConnectorCloudError) || error.code !== 'unauthorized') {
      return error;
    }
    await this.confirmKey(context);
    return this.ownsContext(context)
      ? new ManagedConnectorCloudError('request_failed', error.status, { cause: error })
      : error;
  }

  /**
   * A cloud call other than the heartbeat refused this key (`401`). That alone
   * does not prove the key is dead, so ask the heartbeat, the one authoritative
   * key check, with the same key: a heartbeat `401` unlinks as before, a good
   * answer keeps the link, and a transient failure keeps the key too.
   *
   * Refusals of the same key and lifecycle share one check: while it is in
   * flight, and for {@link KEY_CHECK_COOLDOWN_MS} after it kept the key, so
   * neither a burst nor a steady trickle of refused calls floods the
   * heartbeat. The check runs under the refused call's context, so one that
   * settles after an unlink or a new link changes nothing. Never rejects; it
   * is bounded by {@link KEY_CHECK_TIMEOUT_MS}.
   */
  private confirmKey(context: LinkContext): Promise<void> {
    if (!this.ownsContext(context)) return Promise.resolve();
    const known = this.keyCheck;
    if (
      known &&
      known.context.generation === context.generation &&
      known.context.token === context.token &&
      known.context.baseUrl === context.baseUrl &&
      (known.keptAt === undefined || this.now() - known.keptAt < KEY_CHECK_COOLDOWN_MS)
    ) {
      return known.settled;
    }
    logger.warn('[CloudLink] A cloud call refused the instance key (401); checking the link');
    const bound = new AbortController();
    const timer = setTimeout(() => bound.abort(), KEY_CHECK_TIMEOUT_MS);
    timer.unref?.();
    const settled = this.heartbeat(
      context.baseUrl,
      buildInstanceDescriptor(),
      context.token,
      context.generation,
      bound.signal
    )
      .catch((error: unknown) => {
        // `heartbeat` reads every request failure as transient, so this is
        // applying the verdict (saving the label, or unlinking) going wrong.
        logger.error('[CloudLink] Could not apply the link check result', logError(error));
      })
      .finally(() => {
        clearTimeout(timer);
        const entry = this.keyCheck;
        if (entry?.settled !== settled) return;
        if (this.ownsContext(context)) entry.keptAt = this.now();
        else this.keyCheck = undefined;
      });
    this.keyCheck = { context, settled, keptAt: undefined };
    return settled;
  }

  /** Whether a device-link poll is in flight (a re-link started while still linked). */
  private relinkPending(): boolean {
    return this.pollController !== undefined && !this.pollController.signal.aborted;
  }

  private requireConnectorToken(): string {
    const token = this.config.getToken();
    if (!token) throw new ManagedConnectorLinkRequiredError();
    return token;
  }

  private markUnlinked(context: LinkContext): void {
    if (!this.ownsContext(context)) return;
    // A re-link started while still linked has a device poll in flight, and
    // the old key can be refused (401) while it waits. Drop the old key but
    // leave that poll, and the generation it runs under, alone: an approval
    // still saves the new key. Work still holding the old key cannot act on
    // the result, because `ownsContext` also requires the stored token to
    // match, and it is now cleared (and later replaced).
    const relinkPending = this.relinkPending();
    if (!relinkPending) {
      this.advanceGeneration();
      this.cancelPoll();
    }
    this.stopHeartbeatSchedule();
    this.clearKeepingProof();
    this.lastHeartbeatAt = undefined;
    this.setState(relinkPending ? 'pending' : 'unlinked');
    void this.notifyManagedProviderSync();
    logger.warn(
      `[CloudLink] ${UNLINKED_REASON} — the heartbeat refused the instance key (401); cleared local token`
    );
  }

  private startHeartbeatSchedule(): void {
    this.stopHeartbeatSchedule();
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeatTick();
    }, this.heartbeatIntervalMs);
    // Don't keep the process alive on the heartbeat timer alone.
    this.heartbeatTimer.unref?.();
  }

  private async heartbeatTick(): Promise<void> {
    const token = this.config.getToken();
    if (!token) {
      this.stopHeartbeatSchedule();
      return;
    }
    const context = this.captureContext(token);
    await this.heartbeat(context.baseUrl, buildInstanceDescriptor(), token, context.generation);
  }

  private stopHeartbeatSchedule(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  private cancelPoll(): void {
    this.pollController?.abort();
    this.pollController = undefined;
    this.pollTask = undefined;
  }

  private setState(state: CloudLinkState): void {
    this.state = state;
  }
}

let instance: CloudLinkManager | undefined;

/**
 * Construct the process-wide cloud-link manager. Called once at the composition
 * root ({@link start} in `index.ts`): with no options in production (real
 * `fetch`, real defaults), or with an injected fake `fetchImpl` under
 * `DORKOS_TEST_RUNTIME`. Returns the constructed instance.
 */
export function initCloudLinkManager(options?: CloudLinkManagerOptions): CloudLinkManager {
  instance = new CloudLinkManager(options);
  return instance;
}

/**
 * The process-wide cloud-link manager used by the `/api/cloud/*` routes and
 * startup. Throws if read before {@link initCloudLinkManager} runs — a loud,
 * helpful failure instead of a silent `undefined` dereference.
 */
export function getCloudLinkManager(): CloudLinkManager {
  if (!instance) throw new Error('CloudLinkManager not initialized');
  return instance;
}

/** Current process-local link generation, if the singleton has been initialized. */
export function getCloudLinkGeneration(): number | undefined {
  return instance?.generation;
}

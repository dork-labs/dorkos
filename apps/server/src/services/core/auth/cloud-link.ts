/**
 * Cloud-link instance-token lifecycle for the running DorkOS server
 * (accounts-and-auth P2, task 2.4).
 *
 * Owns the state machine and side effects around device-linking this instance to
 * a DorkOS account: it drives the RFC 8628 device flow via the pure
 * {@link ./cloud-link-client.js | cloud-link client}, persists the issued scoped
 * API key at config `cloud.instanceToken` (the sensitive-field pattern, same
 * handling as `tunnel.authtoken`), and heartbeats on startup and every 15
 * minutes while linked. A `401` from any cloud call marks the instance unlinked:
 * it clears the token and stops — it never retry-loops a dead key.
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
  executeManagedConnectorOperation,
  ManagedConnectorCloudError,
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
  save(link: { instanceToken: string; instanceName: string }): void;
  setAccountLabel(label: string | null): void;
  clear(): void;
}

/** Default config port backed by the `configManager` singleton (resolved lazily). */
function defaultConfigPort(): CloudConfigPort {
  return {
    getToken: () => configManager.get('cloud')?.instanceToken ?? null,
    getAccountLabel: () => configManager.get('cloud')?.linkedAccountLabel ?? null,
    save: ({ instanceToken, instanceName }) => {
      const current = configManager.get('cloud');
      // `cloud.instanceToken` is registered in SENSITIVE_CONFIG_KEYS; the write
      // path mirrors how `tunnel.authtoken` is stored (whole-section set). The
      // token value is never logged — `logConfigWrite` names paths only.
      configManager.set('cloud', { ...current, instanceToken, instanceName });
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
    clear: () => {
      const current = configManager.get('cloud');
      configManager.set('cloud', {
        instanceToken: null,
        instanceName: null,
        linkedAccountLabel: null,
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

  /**
   * Begin the device flow: request a code, enter `pending`, and kick off the
   * background poll that carries the flow to `linked`/`denied`/`expired`. Returns
   * the codes for the human to enter; the client polls {@link getStatus} for the
   * outcome.
   */
  async startLink(): Promise<StartLinkResult> {
    this.cancelPoll();
    const baseUrl = resolveCloudBaseUrl();
    // Resolve the analytics-merge opt-in HERE, at link time: the descriptor built
    // now is what the cloud persists and reads to alias this install's anonymous
    // history onto the account. Heartbeats deliberately never carry the id.
    const telemetryInstanceId = await this.resolveTelemetryInstanceId();
    const descriptor = buildInstanceDescriptor(telemetryInstanceId);
    const codes = await requestDeviceCode({ baseUrl, descriptor, fetchImpl: this.fetchImpl });

    this.setState('pending');
    const controller = new AbortController();
    this.pollController = controller;
    this.pollTask = this.runPoll(baseUrl, descriptor, codes, controller.signal);

    return {
      userCode: codes.user_code,
      verificationUri: codes.verification_uri,
      expiresAt: new Date(this.now() + codes.expires_in * 1000).toISOString(),
    };
  }

  private async runPoll(
    baseUrl: string,
    descriptor: InstanceDescriptor,
    codes: { device_code: string; interval: number; expires_in: number },
    signal: AbortSignal
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
      if (signal.aborted) return;
      if (result.status === 'approved') {
        this.config.save({ instanceToken: result.accessToken, instanceName: descriptor.name });
        this.setState('linked');
        await this.notifyManagedProviderSync();
        await this.heartbeat(baseUrl, descriptor, result.accessToken);
        if (this.config.getToken()) this.startHeartbeatSchedule();
      } else {
        this.setState(result.status === 'denied' ? 'denied' : 'expired');
      }
    } catch (err) {
      if (!signal.aborted) {
        logger.warn('[CloudLink] Device-link poll failed', logError(err));
        this.setState('idle');
      }
    }
  }

  /**
   * Heartbeat now (if linked) and, on success, start the 15-minute schedule.
   * Called once at server startup. Non-throwing and independent of
   * `config.auth.enabled`.
   */
  async initOnStartup(): Promise<void> {
    const token = this.config.getToken();
    if (!token) return;
    this.setState('linked');
    await this.heartbeat(resolveCloudBaseUrl(), buildInstanceDescriptor(), token);
    // Only schedule if the startup heartbeat did not just unlink us (401).
    if (this.config.getToken()) this.startHeartbeatSchedule();
  }

  /**
   * User-initiated unlink: best-effort server-side revoke, then clear the local
   * token and stop heartbeating. Returns the instance to `idle`.
   */
  async unlink(): Promise<void> {
    this.cancelPoll();
    this.stopHeartbeatSchedule();
    const token = this.config.getToken();
    if (token) {
      await revokeInstanceKey({
        baseUrl: resolveCloudBaseUrl(),
        accessToken: token,
        fetchImpl: this.fetchImpl,
      });
    }
    this.config.clear();
    this.lastHeartbeatAt = undefined;
    this.setState('idle');
    await this.notifyManagedProviderSync();
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
    try {
      return await submitManagedConnectorAuthorityCommand({
        baseUrl: resolveCloudBaseUrl(),
        accessToken: token,
        command,
        fetchImpl: this.fetchImpl,
        signal,
      });
    } catch (error) {
      if (error instanceof ManagedConnectorCloudError && error.code === 'unauthorized') {
        this.markUnlinked();
      }
      throw error;
    }
  }

  /** Read one durable managed connector authority command with the current linked key. */
  async readConnectorAuthorityCommand(
    commandId: string,
    signal?: AbortSignal
  ): Promise<ManagedConnectorAuthorityCommandStatus> {
    const token = this.requireConnectorToken();
    try {
      return await readManagedConnectorAuthorityCommand({
        baseUrl: resolveCloudBaseUrl(),
        accessToken: token,
        commandId,
        fetchImpl: this.fetchImpl,
        signal,
      });
    } catch (error) {
      if (error instanceof ManagedConnectorCloudError && error.code === 'unauthorized') {
        this.markUnlinked();
      }
      throw error;
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
  startManagedConnectorAuthentication(
    request: ManagedConnectorAuthenticationCreateRequest,
    signal: AbortSignal
  ): Promise<ManagedConnectorAuthenticationState> {
    return this.withManagedConnectorToken((accessToken) =>
      requestManagedConnectorAuthentication({
        baseUrl: resolveCloudBaseUrl(),
        accessToken,
        request,
        fetchImpl: this.fetchImpl,
        signal,
      })
    );
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
    try {
      return await request(token);
    } catch (error) {
      if (error instanceof ManagedConnectorCloudError && error.code === 'unauthorized') {
        this.markUnlinked();
      }
      throw error;
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
    accessToken: string
  ): Promise<void> {
    const result = await sendHeartbeat({
      baseUrl,
      accessToken,
      descriptor,
      fetchImpl: this.fetchImpl,
    });
    if (result.ok) {
      this.lastHeartbeatAt = result.lastSeenAt;
      this.config.setAccountLabel(result.accountLabel);
      this.setState('linked');
    } else if (result.unauthorized) {
      this.markUnlinked();
    } else {
      // Transient (network / 5xx): keep the token and the schedule; retry next tick.
      logger.warn(`[CloudLink] Heartbeat failed (transient): ${result.error}`);
    }
  }

  private requireConnectorToken(): string {
    const token = this.config.getToken();
    if (!token) throw new ManagedConnectorCloudError('unauthorized');
    return token;
  }

  private markUnlinked(): void {
    this.stopHeartbeatSchedule();
    this.config.clear();
    this.lastHeartbeatAt = undefined;
    this.setState('unlinked');
    void this.notifyManagedProviderSync();
    logger.warn(
      `[CloudLink] ${UNLINKED_REASON} — cloud revoked the instance key; cleared local token`
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
    await this.heartbeat(resolveCloudBaseUrl(), buildInstanceDescriptor(), token);
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

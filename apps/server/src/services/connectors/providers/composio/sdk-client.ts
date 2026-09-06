/**
 * Confined Composio SDK boundary for exact operation discovery and execution.
 *
 * Account linking and inventory still use the existing management client until
 * their durable P3 cutover. This module alone imports `@composio/core`; keeping
 * direct execution separate ensures the management client's authentication
 * fallback cannot retry a provider write.
 *
 * @module services/connectors/providers/composio/sdk-client
 */
import { createHash } from 'node:crypto';
import { Composio, ComposioRequestCancelledError } from '@composio/core';
import { stableStringify } from '@dorkos/shared/capabilities';
import type {
  ConnectorOperationClassification,
  ConnectorOperationPageRequest,
  ConnectorOperationRevision,
  ConnectorProviderExecuteResult,
  ConnectorProviderInstanceId,
  ConnectorToolkitVersionResult,
  ConnectorUnsupportedResult,
} from '@dorkos/shared/connector-schemas';

/** Maximum provider-reported operation pages accepted as a complete catalog. */
const MAX_OPERATION_PAGES = 100;
/** Maximum page size accepted by Composio's public tools endpoint. */
const MAX_OPERATION_PAGE_SIZE = 1_000;

/** Input for one exact Composio execution after provider-neutral authorization. */
export interface ComposioSdkExecuteInput {
  /** Raw provider account id unwrapped from the private provider reference. */
  connectedAccountId: string;
  /** Immutable operation revision selected by the broker. */
  operation: ConnectorOperationRevision;
  /** Arguments already validated against the immutable revision. */
  arguments: Record<string, unknown>;
  /** Server-owned deadline signal. */
  signal: AbortSignal;
  /** Broker-owned live authorization checked at the SDK's last pre-POST hook. */
  authorizeDispatch: () => boolean | Promise<boolean>;
}

/** Construction options for the confined SDK adapter. */
export interface ComposioSdkClientOpts {
  /** Project API key resolved from the configured credential reference. */
  apiKey: string;
  /** Provider-instance user scope; never accepted from an execution caller. */
  serverUserId: string;
  /** Optional API origin used by hermetic tests. */
  baseUrl?: string;
}

/** Provider-facing operation client implemented inside the confined SDK boundary. */
export interface ComposioOperationClient {
  /** Resolve a concrete provider toolkit version from trusted provider metadata. */
  resolveToolkitVersion(
    toolkit: string,
    signal: AbortSignal
  ): Promise<ConnectorToolkitVersionResult | ConnectorUnsupportedResult>;
  /** Discover one exact-version page of immutable operation schemas. */
  listOperationSchemas(
    providerInstanceId: ConnectorProviderInstanceId,
    request: ConnectorOperationPageRequest
  ): Promise<{
    status: 'ok';
    page: {
      operations: Omit<ConnectorOperationRevision, 'id' | 'discoveredAt'>[];
      nextCursor?: string;
      truncated: boolean;
    };
  }>;
  /** Execute one exact-account operation after the provider validates ownership. */
  execute(input: ComposioSdkExecuteInput): Promise<ConnectorProviderExecuteResult>;
}

/** Safe catalog failure that blocks an incomplete reconciliation snapshot. */
export class ComposioCatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposioCatalogError';
  }
}

/** Create the standard AbortError shape required by provider discovery. */
function abortError(): Error {
  const error = new Error('The connector discovery request was cancelled.');
  error.name = 'AbortError';
  return error;
}

/** Reject synchronously before an SDK call can allocate network work. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

/** Map SDK cancellation onto the provider-neutral discovery cancellation shape. */
function rethrowDiscoveryError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted || error instanceof ComposioRequestCancelledError) throw abortError();
  throw new ComposioCatalogError('Composio catalog discovery failed. Check the provider status.');
}

/** Return a conservative classification, or null when metadata cannot prove one. */
function classify(tags: readonly string[]): ConnectorOperationClassification | null {
  if (tags.includes('destructiveHint')) return 'destructive';
  if (tags.includes('readOnlyHint')) return 'read';
  return null;
}

/** Hash the exact input schema body reviewed by the operator. */
function schemaHash(inputSchema: Record<string, unknown>): string {
  return `sha256:${createHash('sha256').update(stableStringify(inputSchema)).digest('hex')}`;
}

/** Detect SDK file inputs that require an explicit upload capability. */
function containsFilePathInput(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsFilePathInput);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.format === 'path' || record.file_uploadable === true) return true;
  return Object.values(record).some(containsFilePathInput);
}

/**
 * Direct Composio SDK adapter with tracking, tracing, automatic files, latest
 * versions, and write retries disabled by construction.
 */
export class ComposioSdkClient implements ComposioOperationClient {
  private readonly _composio: Composio;
  private readonly _client: ReturnType<Composio['getClient']>;
  private readonly _serverUserId: string;

  constructor(opts: ComposioSdkClientOpts) {
    const config = {
      apiKey: opts.apiKey,
      allowTracking: false,
      dangerouslyAllowAutoUploadDownloadFiles: false,
      disableVersionCheck: true,
      ...(opts.baseUrl !== undefined && { baseURL: opts.baseUrl }),
    };
    this._composio = new Composio(config);
    this._client = this._composio.getClient().withOptions({ maxRetries: 0 });
    this._serverUserId = opts.serverUserId;
  }

  /** Resolve the provider's current concrete toolkit version from toolkit metadata. */
  async resolveToolkitVersion(
    toolkit: string,
    signal: AbortSignal
  ): Promise<ConnectorToolkitVersionResult | ConnectorUnsupportedResult> {
    throwIfAborted(signal);
    try {
      const result = await this._client.toolkits.retrieve(toolkit, undefined, { signal });
      const toolkitVersion = result.meta.version;
      if (result.slug !== toolkit) {
        throw new ComposioCatalogError('Composio returned metadata for another toolkit.');
      }
      if (!toolkitVersion || toolkitVersion === 'latest') {
        return {
          status: 'unsupported',
          reason: `Composio did not provide a concrete version for '${toolkit}'.`,
        };
      }
      return { status: 'ok', toolkit: result.slug, toolkitVersion };
    } catch (error) {
      if (error instanceof ComposioCatalogError) throw error;
      rethrowDiscoveryError(error, signal);
    }
  }

  /** Fetch one exact-version operation page from the public generated client. */
  async listOperationSchemas(
    providerInstanceId: ConnectorProviderInstanceId,
    request: ConnectorOperationPageRequest
  ): Promise<{
    status: 'ok';
    page: {
      operations: Omit<ConnectorOperationRevision, 'id' | 'discoveredAt'>[];
      nextCursor?: string;
      truncated: boolean;
    };
  }> {
    throwIfAborted(request.signal);
    if (request.toolkitVersion === 'latest') {
      throw new ComposioCatalogError('Operation discovery requires a concrete toolkit version.');
    }
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > MAX_OPERATION_PAGE_SIZE
    ) {
      throw new ComposioCatalogError(
        `Operation page limit must be between 1 and ${MAX_OPERATION_PAGE_SIZE}.`
      );
    }

    try {
      const result = await this._client.tools.list(
        {
          toolkit_slug: request.toolkit,
          toolkit_versions: { [request.toolkit]: request.toolkitVersion },
          important: 'false',
          include_deprecated: false,
          limit: request.limit,
          ...(request.cursor !== undefined && { cursor: request.cursor }),
        },
        { signal: request.signal }
      );
      if (result.total_pages > MAX_OPERATION_PAGES) {
        throw new ComposioCatalogError(
          `Composio operation catalog exceeds the ${MAX_OPERATION_PAGES}-page safety limit.`
        );
      }
      const nextCursor = result.next_cursor ?? undefined;
      if (result.current_page < result.total_pages && nextCursor === undefined) {
        throw new ComposioCatalogError(
          'Composio omitted the cursor required to complete operation discovery.'
        );
      }
      if (nextCursor !== undefined && nextCursor === request.cursor) {
        throw new ComposioCatalogError('Composio repeated an operation catalog cursor.');
      }

      const operations = result.items.flatMap((item) => {
        const classification = classify(item.tags);
        if (classification === null) return [];
        if (item.toolkit.slug !== request.toolkit || item.version !== request.toolkitVersion) {
          throw new ComposioCatalogError(
            'Composio returned operation metadata for another version.'
          );
        }
        const inputSchema = item.input_parameters;
        return [
          {
            providerInstanceId,
            toolkit: request.toolkit,
            operationSlug: item.slug,
            toolkitVersion: request.toolkitVersion,
            schemaHash: schemaHash(inputSchema),
            capabilityClassification: classification,
            retryPolicy: 'never' as const,
            inputSchema,
          },
        ];
      });
      return {
        status: 'ok',
        page: {
          operations,
          ...(nextCursor !== undefined && { nextCursor }),
          truncated: nextCursor !== undefined,
        },
      };
    } catch (error) {
      if (error instanceof ComposioCatalogError) throw error;
      rethrowDiscoveryError(error, request.signal);
    }
  }

  /** Execute one immutable exact-account operation without provider write retries. */
  async execute(input: ComposioSdkExecuteInput): Promise<ConnectorProviderExecuteResult> {
    if (input.signal.aborted) {
      return {
        status: 'cancelled',
        code: 'CANCELLED_BEFORE_DISPATCH',
        message: 'The operation was cancelled before it was sent.',
      };
    }
    if (!input.operation.toolkitVersion || input.operation.toolkitVersion === 'latest') {
      return {
        status: 'error',
        code: 'INVALID_TOOLKIT_VERSION',
        message: 'The operation does not have an exact service version.',
        retryable: false,
      };
    }
    if (containsFilePathInput(input.operation.inputSchema)) {
      return {
        status: 'error',
        code: 'UNSUPPORTED_FILE_INPUT',
        message: 'This operation needs a file upload, which is not available yet.',
        retryable: false,
      };
    }

    let dispatchMayHaveStarted = false;
    let dispatchAuthorizationRefused = false;
    try {
      const result = await this._composio.tools.execute(
        input.operation.operationSlug,
        {
          connectedAccountId: input.connectedAccountId,
          userId: this._serverUserId,
          version: input.operation.toolkitVersion,
          arguments: input.arguments,
          allowTracing: false,
        },
        {
          signal: input.signal,
          beforeExecute: async ({ params }) => {
            // The SDK invokes this only after its preliminary exact-version
            // schema read. From this point onward a rejection can race the
            // execute POST, so its outcome must remain unknown.
            if (!(await input.authorizeDispatch())) {
              dispatchAuthorizationRefused = true;
              throw new Error('Connector authority changed before provider dispatch.');
            }
            dispatchMayHaveStarted = true;
            return params;
          },
        }
      );
      if (!result.successful) {
        return {
          status: 'error',
          code: 'PROVIDER_REJECTED',
          message: 'The service rejected the operation.',
          retryable: false,
          ...(result.logId !== undefined && { providerLogId: result.logId }),
        };
      }
      return {
        status: 'success',
        data: result.data,
        ...(result.logId !== undefined && { providerLogId: result.logId }),
      };
    } catch {
      if (!dispatchMayHaveStarted) {
        if (dispatchAuthorizationRefused) {
          return {
            status: 'error',
            code: 'AUTHORITY_CHANGED_BEFORE_DISPATCH',
            message: 'Access changed before the operation was sent.',
            retryable: false,
          };
        }
        if (input.signal.aborted) {
          return {
            status: 'cancelled',
            code: 'CANCELLED_BEFORE_DISPATCH',
            message: 'The operation was cancelled before it was sent.',
          };
        }
        return {
          status: 'error',
          code: 'PROVIDER_PRECHECK_FAILED',
          message: 'DorkOS could not verify the operation before sending it.',
          retryable: false,
        };
      }
      // Once tools.execute starts, the SDK performs an exact schema read and may
      // dispatch the write after the hook above. Its error does not expose
      // whether the POST was accepted, so every later rejection is ambiguous.
      return {
        status: 'outcome_unknown',
        code: 'PROVIDER_OUTCOME_UNKNOWN',
        message: 'The service may have accepted the operation, but did not confirm its outcome.',
      };
    }
  }
}

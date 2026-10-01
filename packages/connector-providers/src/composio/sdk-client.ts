/**
 * Confined Composio SDK boundary for exact operation discovery and execution.
 *
 * Account linking and inventory still use the existing management client until
 * their durable P3 cutover. This module alone imports `@composio/core`; keeping
 * direct execution separate ensures the management client's authentication
 * fallback cannot retry a provider write.
 *
 * @module connector-providers/composio
 */
import { createHash } from 'node:crypto';
import { Composio, ComposioRequestCancelledError } from '@composio/core';
import { stableStringify } from '@dorkos/shared/capabilities';
import type {
  ConnectorAuthenticationSetup,
  ConnectorToolkit,
} from '@dorkos/shared/connector-provider';
import type {
  ConnectorCatalogPageRequest,
  ConnectorOperationClassification,
  ConnectorOperationPage,
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

/**
 * One page of the Composio project catalog, with an optional search. The app's
 * own catalog pages carry no search (DorkOS searches its kept list itself),
 * but the hosted DorkOS-account catalog forwards a caller's search here: the
 * public cloud-api contract accepts `query`, and released clients send it.
 */
export interface ComposioCatalogPageRequest extends ConnectorCatalogPageRequest {
  /** Composio's `search`: matches toolkit name, slug or description upstream. */
  query?: string;
}

/** Provider-facing operation client implemented inside the confined SDK boundary. */
export interface ComposioOperationClient {
  /** Discover one account-free toolkit page from the project catalog. */
  listToolkitPage(request: ComposioCatalogPageRequest): Promise<{
    status: 'ok';
    toolkits: ConnectorToolkit[];
    nextCursor?: string;
    truncated: boolean;
  }>;
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
      operations: ConnectorOperationPage['operations'];
      nextCursor?: string;
      truncated: boolean;
    };
  }>;
  /** Execute one exact-account operation after the provider validates ownership. */
  execute(input: ComposioSdkExecuteInput): Promise<ConnectorProviderExecuteResult>;
}

/** Safe catalog failure that blocks an incomplete reconciliation snapshot. */
export class ComposioCatalogError extends Error {
  /**
   * Construct one safe discovery failure. The message stays fixed: a wrapped
   * provider error rides along as `cause` so a log can name its class, and is
   * never interpolated into what a caller may show.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
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
  throw new ComposioCatalogError('Composio catalog discovery failed. Check the provider status.', {
    cause: error,
  });
}

/**
 * Composio's safety verdicts are its tags that end in `Hint`. The same `tags`
 * list also carries category labels ("gmail", "messages", "Events
 * Management", "deprecated") and the `important` mark; those say nothing about
 * what an action does, so classification ignores them.
 */
const HINT_TAG = /Hint$/;

/** Hints that do not contradict an explicit read-only verdict. */
const READ_COMPATIBLE_HINTS = new Set(['readOnlyHint', 'idempotentHint', 'openWorldHint']);

/**
 * Composio's two verdicts for an action that makes or changes something
 * without removing it: `createHint` (sending an email, opening an issue) and
 * `updateHint` (editing something in place).
 */
const WRITE_VERDICT_HINTS = new Set(['createHint', 'updateHint']);

/**
 * Hints that do not contradict a create or update verdict. `destructiveHint`
 * and `readOnlyHint` are deliberately absent: Composio puts `destructiveHint`
 * on every irreversible action, including an irreversible update that also
 * carries `updateHint`, and a read verdict beside a write verdict is a
 * contradiction.
 */
const WRITE_COMPATIBLE_HINTS = new Set([
  'createHint',
  'updateHint',
  'idempotentHint',
  'openWorldHint',
]);

/**
 * Classify one action from the safety hints Composio sends, failing toward
 * the strictest tier. Only tags ending in `Hint` count; category tags are
 * ignored, but an unknown `…Hint` is treated as a verdict DorkOS does not
 * understand.
 *
 * - `read`: `readOnlyHint`, and every hint is one of `readOnlyHint`,
 *   `idempotentHint`, `openWorldHint`.
 * - `write`: `createHint` or `updateHint`, and every hint is one of those or
 *   `idempotentHint`, `openWorldHint` — so no `destructiveHint` and no
 *   `readOnlyHint`. Composio documents `destructiveHint` as "irreversibly
 *   removes, cancels or revokes data", so a delete never lands here.
 * - `destructive`: everything else — a destructive verdict, contradictory
 *   verdicts, no verdict at all, or an unknown hint. Idempotence does not
 *   prove read-only, and a missing hint never proves safety.
 *
 * @param tags - The action's `tags` exactly as Composio listed them.
 */
function classifyComposioTags(tags: readonly string[]): ConnectorOperationClassification {
  const hints = tags.filter((tag) => HINT_TAG.test(tag));
  if (hints.includes('readOnlyHint') && hints.every((hint) => READ_COMPATIBLE_HINTS.has(hint))) {
    return 'read';
  }
  if (
    hints.some((hint) => WRITE_VERDICT_HINTS.has(hint)) &&
    hints.every((hint) => WRITE_COMPATIBLE_HINTS.has(hint))
  ) {
    return 'write';
  }
  return 'destructive';
}

/**
 * The Composio apps whose live action tags DorkOS has audited: every action
 * read, its class checked, and the resulting "Read and write" list pinned by a
 * test over a fixture of those tags. Only these apps get a `write` tier; for
 * any other app, create and update actions stay `destructive`. Adding an app
 * means auditing its live tags, adding them to the fixture, and pinning its
 * write list.
 */
const AUDITED_WRITE_TOOLKITS = new Set(['gmail', 'googlecalendar']);

/**
 * Composio `write` actions DorkOS keeps out of "Read and write": ones that
 * share access, redirect or forward mail, change the sending identity, change
 * how the account delivers mail (including an automatic reply), start a
 * subscription, or act on many items at once. They can hand data or access to
 * someone else, so they are allowed one action at a time, like a delete.
 * Exact slugs from Composio's Gmail and Google Calendar lists.
 */
const ACCOUNT_REACH_ACTIONS = new Set([
  'GOOGLECALENDAR_ACL_INSERT',
  'GOOGLECALENDAR_ACL_PATCH',
  'GOOGLECALENDAR_ACL_UPDATE',
  'GOOGLECALENDAR_ACL_WATCH',
  'GOOGLECALENDAR_CALENDAR_LIST_WATCH',
  'GOOGLECALENDAR_EVENTS_MOVE',
  'GOOGLECALENDAR_EVENTS_WATCH',
  'GOOGLECALENDAR_SETTINGS_WATCH',
  'GMAIL_BATCH_MODIFY_MESSAGES',
  'GMAIL_CREATE_FILTER',
  'GMAIL_FORWARD_MESSAGE',
  'GMAIL_PATCH_SEND_AS',
  'GMAIL_UPDATE_SEND_AS',
  'GMAIL_UPDATE_IMAP_SETTINGS',
  'GMAIL_UPDATE_POP_SETTINGS',
  'GMAIL_IMPORT_MESSAGE',
  'GMAIL_INSERT_MESSAGE',
  'GMAIL_UPDATE_VACATION_SETTINGS',
]);

/**
 * The same kinds of action by name, as defense in depth for actions added
 * later: sharing, permissions, rules, webhooks, subscriptions, secrets and
 * transfers. A match only ever moves `write` to `destructive`, never the other
 * way, so a pattern that matches too much costs convenience, not safety.
 */
const ACCOUNT_REACH_PATTERN =
  /_ACL_|FORWARD|SEND_AS|_IMAP_|_POP_|FILTER|VACATION|AUTO_REPL|WATCH|PERMISSION|SHARING|SHARE_|COLLABORAT|MEMBERSHIP|INVITAT|_RULE|WEBHOOK|_HOOK|SUBSCRI|DEPLOY_KEY|SECRET|TRANSFER|DELEGAT|VISIBILITY|MAILBOX_SETTINGS/;

/**
 * Classify one Composio action: its safety hints ({@link classifyComposioTags}),
 * then DorkOS's own tightening. A `write` verdict stands only for an audited
 * app and only when the action has no reach beyond the account; otherwise the
 * action is `destructive`.
 *
 * @param toolkit - The app's Composio toolkit slug, e.g. `gmail`.
 * @param slug - The action's Composio slug, e.g. `GMAIL_SEND_EMAIL`.
 * @param tags - The action's `tags` exactly as Composio listed them.
 */
function classifyComposioAction(
  toolkit: string,
  slug: string,
  tags: readonly string[]
): ConnectorOperationClassification {
  const classification = classifyComposioTags(tags);
  if (classification !== 'write') return classification;
  return AUDITED_WRITE_TOOLKITS.has(toolkit) &&
    !ACCOUNT_REACH_ACTIONS.has(slug) &&
    !ACCOUNT_REACH_PATTERN.test(slug)
    ? 'write'
    : 'destructive';
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

const SUPPORTED_ACCOUNT_SCHEMES = ['API_KEY', 'BEARER_TOKEN', 'BASIC', 'NO_AUTH'] as const;

function normalizedSchemes(values: readonly string[] | undefined): Set<string> {
  return new Set(values?.map((value) => value.trim().toUpperCase()) ?? []);
}

/** Normalize cheap toolkit-page hints without guessing an unknown method is OAuth. */
export function normalizeComposioCatalogAuthentication(item: {
  auth_schemes?: readonly string[];
  composio_managed_auth_schemes?: readonly string[];
  no_auth?: boolean;
}): Pick<ConnectorToolkit, 'authKind' | 'authenticationSetup'> {
  const managed = normalizedSchemes(item.composio_managed_auth_schemes);
  const declared = normalizedSchemes(item.auth_schemes);
  if (managed.has('OAUTH2')) {
    return {
      authKind: 'oauth2',
      authenticationSetup: {
        kind: 'oauth',
        source: 'managed',
        scheme: 'OAUTH2',
        requiresAccountFields: false,
      },
    };
  }

  for (const scheme of SUPPORTED_ACCOUNT_SCHEMES) {
    if (
      scheme === 'NO_AUTH' ? item.no_auth === true || declared.has(scheme) : declared.has(scheme)
    ) {
      const none = scheme === 'NO_AUTH';
      return {
        authKind: none ? 'none' : 'api-key',
        authenticationSetup: {
          kind: none ? 'none' : 'fields',
          source: 'account-fields',
          scheme,
          requiresAccountFields: !none,
        },
      };
    }
  }

  const unsupportedScheme = [...managed, ...declared].find((scheme) =>
    ['OAUTH2', 'OAUTH1', 'DCR'].includes(scheme)
  );
  const authenticationSetup: ConnectorAuthenticationSetup = {
    kind: 'unsupported',
    source: 'unsupported',
    ...(unsupportedScheme && { scheme: unsupportedScheme }),
    requiresAccountFields: false,
  };
  return { authKind: 'none', authenticationSetup };
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

  /** Fetch one account-free toolkit page through the no-retry generated client. */
  async listToolkitPage(request: ComposioCatalogPageRequest): Promise<{
    status: 'ok';
    toolkits: ConnectorToolkit[];
    nextCursor?: string;
    truncated: boolean;
  }> {
    throwIfAborted(request.signal);
    if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
      throw new ComposioCatalogError('Toolkit page limit must be between 1 and 100.');
    }
    try {
      const result = await this._client.toolkits.list(
        {
          limit: request.limit,
          include_deprecated: false,
          sort_by: 'alphabetically',
          ...(request.cursor !== undefined && { cursor: request.cursor }),
          ...(request.query !== undefined && { search: request.query }),
        },
        { signal: request.signal }
      );
      const nextCursor = result.next_cursor ?? undefined;
      if (result.current_page < result.total_pages && nextCursor === undefined) {
        throw new ComposioCatalogError(
          'Composio omitted the cursor required to complete toolkit discovery.'
        );
      }
      if (nextCursor !== undefined && nextCursor === request.cursor) {
        throw new ComposioCatalogError('Composio repeated a toolkit catalog cursor.');
      }
      return {
        status: 'ok',
        toolkits: result.items.map((item) => ({
          slug: item.slug,
          displayName: item.name,
          ...normalizeComposioCatalogAuthentication(item),
        })),
        ...(nextCursor !== undefined && { nextCursor }),
        truncated: nextCursor !== undefined,
      };
    } catch (error) {
      if (error instanceof ComposioCatalogError) throw error;
      rethrowDiscoveryError(error, request.signal);
    }
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
      operations: ConnectorOperationPage['operations'];
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

      const operations = result.items.map((item) => {
        const classification = classifyComposioAction(request.toolkit, item.slug, item.tags);
        if (item.toolkit.slug !== request.toolkit || item.version !== request.toolkitVersion) {
          throw new ComposioCatalogError(
            'Composio returned operation metadata for another version.'
          );
        }
        const inputSchema = item.input_parameters;
        return {
          providerInstanceId,
          toolkit: request.toolkit,
          operationSlug: item.slug,
          toolkitVersion: request.toolkitVersion,
          schemaHash: schemaHash(inputSchema),
          capabilityClassification: classification,
          retryPolicy: 'never' as const,
          inputSchema,
          ...(item.name.trim() !== '' && { displayName: item.name.trim().slice(0, 200) }),
          important: item.tags.includes('important'),
        };
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

/**
 * Confined Composio account-management boundary for the hosted connector service.
 *
 * The SDK covers link creation, exact account reads, deletion, and the callback
 * verifier through its generic transport. The opaque `session_uri` is always
 * request data for a fixed endpoint; it is never fetched as a URL.
 *
 * @module connector-providers/composio/managed-account-client
 */
import { createHash } from 'node:crypto';
import { Composio, ComposioRequestCancelledError } from '@composio/core';
import {
  ComposioAuthenticationSetupError,
  normalizeComposioAuthenticationConfiguration,
  normalizeComposioToolkitAuthentication,
  type ComposioAuthenticationConfiguration,
  type ComposioToolkitAuthentication,
} from './authentication-configuration.js';
import {
  validateComposioAuthenticationFields,
  type ComposioAuthenticationDescriptor,
} from './authentication-contract.js';

/** Composio's production API origin. Tests may supply a loopback origin. */
const DEFAULT_COMPOSIO_BASE_URL = 'https://backend.composio.dev';
const COMPOSIO_LINK_CREATE_TIMEOUT_MS = 15_000;

/** Input for the hosted Composio management client. */
export interface ComposioManagedAccountClientOpts {
  /** Project API key; never logged or returned. */
  apiKey: string;
  /** Optional fixed API origin used by hermetic tests. */
  baseUrl?: string;
}

/** Exact private account facts the hosted service is allowed to persist. */
export interface ComposioManagedAccount {
  /** Composio connected-account id. */
  connectedAccountId: string;
  /** Server-derived provider user id. */
  providerUserId: string;
  /** Exact toolkit slug. */
  toolkit: string;
  /** Exact custom-auth configuration id. */
  authConfigId: string;
  /** Provider-reported authentication status. */
  status: string;
}

/** Successful link creation before the browser follows the provider URL. */
export interface ComposioManagedLink {
  /** Private provider connection id created for this flow. */
  connectedAccountId: string;
  /** Provider-owned authorization URL shown to the browser. */
  redirectUrl: string;
}

/** Safe error from the hosted provider-management boundary. */
export class ComposioManagedAccountError extends Error {
  /** Stable server-only classification. */
  readonly code:
    'cancelled' | 'provider_rejected' | 'invalid_provider_response' | 'outcome_unknown';
  /** Provider HTTP status when the fixed completion endpoint rejected the request. */
  readonly status?: number;

  constructor(
    code: 'cancelled' | 'provider_rejected' | 'invalid_provider_response' | 'outcome_unknown',
    message: string,
    status?: number
  ) {
    super(message);
    this.name = 'ComposioManagedAccountError';
    this.code = code;
    this.status = status;
  }
}

type SdkApiError = Error & { readonly status: number | undefined };
type SdkApiErrorConstructor = abstract new (...args: never[]) => SdkApiError;

/** Assert a non-empty string value from a provider response. */
function providerString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ComposioManagedAccountError(
      'invalid_provider_response',
      'Composio returned an invalid account response.'
    );
  }
  return value;
}

/** Assert an HTTPS provider URL before it is returned to a browser. */
function providerUrl(value: unknown): string {
  const raw = providerString(value);
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') return parsed.toString();
  } catch {
    // Fall through to the safe provider-response error.
  }
  throw new ComposioManagedAccountError(
    'invalid_provider_response',
    'Composio returned an invalid account response.'
  );
}

/** Assert a named non-empty string from an untyped provider record. */
function stringField(record: Record<string, unknown>, field: string): string {
  return providerString(record[field]);
}

/** Normalize SDK/raw connected-account output without retaining its private envelope. */
function normalizeAccount(value: unknown): ComposioManagedAccount {
  if (!value || typeof value !== 'object') {
    throw new ComposioManagedAccountError(
      'invalid_provider_response',
      'Composio returned an invalid account response.'
    );
  }
  const record = value as Record<string, unknown>;
  const toolkitRecord = record.toolkit;
  const authConfigRecord = record.auth_config;
  if (
    !toolkitRecord ||
    typeof toolkitRecord !== 'object' ||
    !authConfigRecord ||
    typeof authConfigRecord !== 'object'
  ) {
    throw new ComposioManagedAccountError(
      'invalid_provider_response',
      'Composio returned an invalid account response.'
    );
  }
  return {
    connectedAccountId: stringField(record, 'id'),
    providerUserId: stringField(record, 'user_id'),
    toolkit: stringField(toolkitRecord as Record<string, unknown>, 'slug'),
    authConfigId: stringField(authConfigRecord as Record<string, unknown>, 'id'),
    status: stringField(record, 'status'),
  };
}

/** Read only a bounded HTTP status from the pinned SDK's API error class. */
function providerHttpStatus(error: unknown, apiError: SdkApiErrorConstructor): number | undefined {
  if (!(error instanceof apiError)) return undefined;
  const status = error.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599
    ? status
    : undefined;
}

/** Map an SDK rejection without copying vendor error text or response bodies. */
function rethrowSafe(error: unknown, signal: AbortSignal, apiError: SdkApiErrorConstructor): never {
  if (signal.aborted || error instanceof ComposioRequestCancelledError) {
    throw new ComposioManagedAccountError('cancelled', 'The provider request was cancelled.');
  }
  if (
    error instanceof ComposioManagedAccountError ||
    error instanceof ComposioAuthenticationSetupError
  )
    throw error;
  throw new ComposioManagedAccountError(
    'provider_rejected',
    'Composio could not complete the account request.',
    providerHttpStatus(error, apiError)
  );
}

/**
 * Project-key Composio management client with retries and telemetry disabled.
 *
 * It never accepts a public owner, tenant, or provider-user selector. The hosted
 * service derives those values and passes only its trusted provider user here.
 */
export class ComposioManagedAccountClient {
  private readonly _client: ReturnType<Composio['getClient']>;
  private readonly _apiError: SdkApiErrorConstructor;
  /** Project-only resolver namespace; deliberately excludes tenant and automatic config IDs. */
  readonly authConfigProjectDigest: string;

  constructor(opts: ComposioManagedAccountClientOpts) {
    this.authConfigProjectDigest = createHash('sha256')
      .update(
        JSON.stringify([
          opts.apiKey,
          (opts.baseUrl ?? DEFAULT_COMPOSIO_BASE_URL).replace(/\/$/, ''),
        ])
      )
      .digest('hex');
    this._client = new Composio({
      apiKey: opts.apiKey,
      baseURL: (opts.baseUrl ?? DEFAULT_COMPOSIO_BASE_URL).replace(/\/$/, ''),
      allowTracking: false,
      dangerouslyAllowAutoUploadDownloadFiles: false,
      disableVersionCheck: true,
    })
      .getClient()
      .withOptions({ maxRetries: 0 });
    this._apiError = (
      this._client.constructor as unknown as { readonly APIError: SdkApiErrorConstructor }
    ).APIError;
  }

  /** Read one exact toolkit's authentication metadata without retaining vendor envelopes. */
  async getToolkitAuthentication(
    toolkit: string,
    signal: AbortSignal
  ): Promise<ComposioToolkitAuthentication> {
    signal.throwIfAborted();
    try {
      const response = await this._client.toolkits.retrieve(
        toolkit,
        {},
        { signal, timeout: 15_000 }
      );
      try {
        const result = normalizeComposioToolkitAuthentication(response);
        if (result.toolkit !== toolkit) throw new Error('Toolkit mismatch.');
        return result;
      } catch {
        throw new ComposioManagedAccountError(
          'invalid_provider_response',
          'Composio returned invalid account metadata.'
        );
      }
    } catch (error) {
      return rethrowSafe(error, signal, this._apiError);
    }
  }

  /** Read only identity/status from one server-selected auth configuration. */
  async getAuthenticationConfiguration(
    id: string,
    signal: AbortSignal
  ): Promise<ComposioAuthenticationConfiguration> {
    signal.throwIfAborted();
    try {
      const response = await this._client.authConfigs.retrieve(id, {
        signal,
        timeout: 15_000,
      });
      try {
        const result = normalizeComposioAuthenticationConfiguration(response);
        if (result.id !== id) throw new Error('Configuration mismatch.');
        return result;
      } catch {
        throw new ComposioManagedAccountError(
          'invalid_provider_response',
          'Composio returned invalid account metadata.'
        );
      }
    } catch (error) {
      return rethrowSafe(error, signal, this._apiError);
    }
  }

  /** Read a bounded exact-name candidate page; callers must verify identity and cursor progress. */
  async listAuthenticationConfigurations(input: {
    toolkit: string;
    name: string;
    cursor?: string;
    signal: AbortSignal;
  }): Promise<{ items: ComposioAuthenticationConfiguration[]; nextCursor?: string }> {
    input.signal.throwIfAborted();
    try {
      const page = await this._client.authConfigs.list(
        {
          toolkit_slug: input.toolkit,
          search: input.name,
          limit: 50,
          show_disabled: true,
          ...(input.cursor ? { cursor: input.cursor } : {}),
        },
        { signal: input.signal, timeout: 15_000 }
      );
      try {
        if (!Array.isArray(page.items) || page.items.length > 50)
          throw new Error('Invalid configuration page.');
        const cursor = page.next_cursor;
        if (
          cursor !== undefined &&
          cursor !== null &&
          (typeof cursor !== 'string' || cursor.length > 4096)
        )
          throw new Error('Invalid configuration cursor.');
        return {
          items: page.items.map(normalizeComposioAuthenticationConfiguration),
          ...(cursor ? { nextCursor: cursor } : {}),
        };
      } catch {
        throw new ComposioManagedAccountError(
          'invalid_provider_response',
          'Composio returned invalid account metadata.'
        );
      }
    } catch (error) {
      return rethrowSafe(error, input.signal, this._apiError);
    }
  }

  /** Create one default blueprint, never importing developer secrets or changing an existing config. */
  async createAuthenticationConfiguration(input: {
    descriptor: ComposioAuthenticationDescriptor;
    name: string;
    signal: AbortSignal;
  }): Promise<{ id: string }> {
    input.signal.throwIfAborted();
    if (input.descriptor.source === 'configured' || input.name.length > 512)
      throw new Error('Authentication configuration selection is invalid.');
    try {
      const descriptor = input.descriptor;
      const authConfig =
        descriptor.kind === 'oauth'
          ? {
              type: 'use_composio_managed_auth' as const,
              name: input.name,
              is_enabled_for_tool_router: false,
            }
          : {
              type: 'use_custom_auth' as const,
              authScheme: descriptor.scheme,
              name: input.name,
              credentials: {},
              is_enabled_for_tool_router: false,
            };
      const created = await this._client.authConfigs.create(
        { toolkit: { slug: descriptor.toolkit }, auth_config: authConfig },
        { signal: input.signal, timeout: 15_000 }
      );
      return { id: providerString(created.auth_config?.id) };
    } catch (error) {
      const status = providerHttpStatus(error, this._apiError);
      if (status === undefined || status >= 500)
        throw new ComposioManagedAccountError(
          'outcome_unknown',
          'Account setup could not be confirmed.'
        );
      return rethrowSafe(error, input.signal, this._apiError);
    }
  }

  /** Start exactly one account link for a trusted provider user and auth config. */
  async createLink(input: {
    providerUserId: string;
    authConfigId: string;
    signal: AbortSignal;
  }): Promise<ComposioManagedLink> {
    if (input.signal.aborted) {
      throw new ComposioManagedAccountError('cancelled', 'The provider request was cancelled.');
    }
    try {
      const response = await this._client.link.create(
        { user_id: input.providerUserId, auth_config_id: input.authConfigId },
        { signal: input.signal, timeout: COMPOSIO_LINK_CREATE_TIMEOUT_MS }
      );
      return {
        connectedAccountId: providerString(response.connected_account_id),
        redirectUrl: providerUrl(response.redirect_url),
      };
    } catch (error) {
      const status = providerHttpStatus(error, this._apiError);
      if (
        input.signal.aborted ||
        error instanceof ComposioRequestCancelledError ||
        status === undefined ||
        status >= 500
      ) {
        throw new ComposioManagedAccountError(
          'outcome_unknown',
          'Account sign-in could not be confirmed.',
          status
        );
      }
      rethrowSafe(error, input.signal, this._apiError);
    }
  }

  /** Create one exact non-OAuth account from a consumed hosted owner flow; never retry. */
  async createFieldAccount(input: {
    providerUserId: string;
    authConfigId: string;
    descriptor: ComposioAuthenticationDescriptor;
    fields: unknown;
    signal: AbortSignal;
  }): Promise<{ connectedAccountId: string }> {
    if (input.signal.aborted) {
      throw new ComposioManagedAccountError('cancelled', 'The provider request was cancelled.');
    }
    const fields = validateComposioAuthenticationFields(input.descriptor, input.fields);
    const scheme = input.descriptor.scheme;
    const text = (name: string): string => {
      const value = fields[name];
      if (typeof value !== 'string' || value.length === 0) {
        throw new ComposioManagedAccountError(
          'invalid_provider_response',
          'Required account details are missing.'
        );
      }
      return value;
    };
    // Discriminated unions keep the actual pinned wire names compile-time checked.
    const state =
      scheme === 'BASIC'
        ? {
            authScheme: 'BASIC' as const,
            val: { ...fields, username: text('username'), status: 'ACTIVE' as const },
          }
        : scheme === 'BEARER_TOKEN'
          ? {
              authScheme: 'BEARER_TOKEN' as const,
              val: { ...fields, token: text('token'), status: 'ACTIVE' as const },
            }
          : scheme === 'API_KEY'
            ? { authScheme: 'API_KEY' as const, val: { ...fields, status: 'ACTIVE' as const } }
            : scheme === 'NO_AUTH'
              ? { authScheme: 'NO_AUTH' as const, val: { status: 'ACTIVE' as const } }
              : undefined;
    if (!state)
      throw new ComposioManagedAccountError(
        'invalid_provider_response',
        'This sign-in method requires browser verification.'
      );
    try {
      const response = await this._client.connectedAccounts.create(
        {
          auth_config: { id: input.authConfigId },
          connection: { user_id: input.providerUserId, state },
        },
        { signal: input.signal }
      );
      return { connectedAccountId: providerString(response.id) };
    } catch (error) {
      const status = providerHttpStatus(error, this._apiError);
      if (status === undefined || status >= 500) {
        throw new ComposioManagedAccountError(
          'outcome_unknown',
          'Account creation could not be confirmed.',
          status
        );
      }
      rethrowSafe(error, input.signal, this._apiError);
    }
  }

  /** Read one exact private connected account. */
  async getAccount(
    connectedAccountId: string,
    signal: AbortSignal
  ): Promise<ComposioManagedAccount> {
    if (signal.aborted) {
      throw new ComposioManagedAccountError('cancelled', 'The provider request was cancelled.');
    }
    try {
      return normalizeAccount(
        await this._client.connectedAccounts.retrieve(connectedAccountId, { signal })
      );
    } catch (error) {
      rethrowSafe(error, signal, this._apiError);
    }
  }

  /** Delete one exact private connected account without retrying. */
  async deleteAccount(connectedAccountId: string, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw new ComposioManagedAccountError('cancelled', 'The provider request was cancelled.');
    }
    try {
      await this._client.connectedAccounts.delete(connectedAccountId, undefined, { signal });
    } catch (error) {
      // The provider may already have removed the credential after an earlier
      // response was lost. That is the desired idempotent cleanup state.
      if (providerHttpStatus(error, this._apiError) === 404) return;
      rethrowSafe(error, signal, this._apiError);
    }
  }

  /**
   * Redeem an opaque callback session at the one trusted completion endpoint.
   * The session value is never interpreted or used as a request destination.
   */
  async completeAuth(input: {
    sessionUri: string;
    providerUserId: string;
    signal: AbortSignal;
  }): Promise<{ connectedAccountId: string; toolkit: string }> {
    if (input.signal.aborted) {
      throw new ComposioManagedAccountError('cancelled', 'The provider request was cancelled.');
    }
    let body: unknown;
    try {
      body = await this._client.post('/api/v3.1/connected_accounts/complete_auth', {
        body: {
          session_uri: input.sessionUri,
          user_id: input.providerUserId,
        },
        signal: input.signal,
      });
    } catch (error) {
      const status = providerHttpStatus(error, this._apiError);
      if (status === undefined || status >= 500) {
        throw new ComposioManagedAccountError(
          'outcome_unknown',
          'Composio account completion could not be confirmed.',
          status
        );
      }
      rethrowSafe(error, input.signal, this._apiError);
    }
    if (!body || typeof body !== 'object') {
      throw new ComposioManagedAccountError(
        'invalid_provider_response',
        'Composio returned an invalid account response.'
      );
    }
    const record = body as Record<string, unknown>;
    return {
      connectedAccountId: stringField(record, 'connected_account_id'),
      toolkit: stringField(record, 'toolkit_slug'),
    };
  }
}

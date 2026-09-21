/**
 * Bounded, secret-safe HTTP boundary for the Fly GraphQL operations used by Community launch.
 *
 * @module commands/community-deploy/fly-graphql-client
 */
import {
  FLY_TIGRIS_CREATE_MUTATION,
  FLY_TIGRIS_DELETE_MUTATION,
  FLY_TIGRIS_READ_QUERY,
  FLY_TIGRIS_TERMS_QUERY,
  createTigrisVariables,
  parseTigrisCreateResponse,
  parseTigrisDeleteResponse,
  parseTigrisReadResponse,
  parseTigrisTermsResponse,
  FlyGraphqlContractError,
  type FlyGraphqlContractErrorCode,
  type TigrisAddOnIdentity,
  type TigrisCreateInput,
} from './fly-graphql-contract.js';
import { SAFE_PROVIDER_IDENTIFIER_PATTERN } from './provider-identifiers.js';

const FLY_GRAPHQL_ENDPOINT = 'https://api.fly.io/graphql';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

type FlyGraphqlFailureCode =
  | 'AUTH_REQUIRED'
  | 'ACCESS_DENIED'
  | 'TERMS_NOT_ACCEPTED'
  | 'PROVIDER_UNAVAILABLE'
  | 'INVALID_RESPONSE'
  | 'CREATION_OUTCOME_UNCERTAIN';

type FlyGraphqlClientErrorCode = FlyGraphqlFailureCode | FlyGraphqlContractErrorCode;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface FlyGraphqlClientOptions {
  /** Fly access token held only by this in-memory boundary. */
  accessToken: string;
  /** Request deadline for each bounded operation. */
  timeoutMs?: number;
  /** Operator cancellation shared by the complete guided launch. */
  signal?: AbortSignal;
  /** Maximum accepted response body size. */
  maxResponseBytes?: number;
  /** Test-only fetch implementation. */
  fetch?: FetchLike;
}

/** Stable failure with no provider response, URL, or credential text. */
export class FlyGraphqlClientError extends Error {
  /** Safe code suitable for the non-secret launch journal. */
  readonly code: FlyGraphqlClientErrorCode;

  /**
   * Create a Fly request failure without copying sensitive input or output.
   *
   * @param code - Stable failure classification.
   */
  constructor(code: FlyGraphqlClientErrorCode) {
    super(`Fly GraphQL request failed (${code})`);
    this.name = 'FlyGraphqlClientError';
    this.code = code;
  }
}

async function readBounded(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): Promise<unknown> {
  if (!response.body) throw new FlyGraphqlClientError('INVALID_RESPONSE');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    if (signal.aborted) {
      cancelReader();
      throw new FlyGraphqlClientError('PROVIDER_UNAVAILABLE');
    }
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined);
        throw new FlyGraphqlClientError('INVALID_RESPONSE');
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof FlyGraphqlClientError) throw error;
    throw new FlyGraphqlClientError('PROVIDER_UNAVAILABLE');
  } finally {
    signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
  const bytes = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    size
  );
  try {
    return JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    throw new FlyGraphqlClientError('INVALID_RESPONSE');
  } finally {
    bytes.fill(0);
    for (const chunk of chunks) chunk.fill(0);
  }
}

/** In-memory Fly GraphQL client restricted to the launcher's pinned Tigris operations. */
export class FlyTigrisGraphqlClient {
  private readonly accessToken: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly fetch: FetchLike;
  private readonly signal?: AbortSignal;

  /**
   * Create a bounded client around an already authenticated local Fly session token.
   *
   * @param options - Secret token plus bounded request controls.
   */
  constructor(options: FlyGraphqlClientOptions) {
    if (
      options.accessToken.length < 1 ||
      options.accessToken.length > 4096 ||
      !/^[\x21-\x7e]+$/u.test(options.accessToken)
    ) {
      throw new FlyGraphqlClientError('AUTH_REQUIRED');
    }
    if (
      !Number.isSafeInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS) ||
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) < 1 ||
      (options.timeoutMs ?? DEFAULT_TIMEOUT_MS) > MAX_TIMEOUT_MS
    ) {
      throw new FlyGraphqlClientError('INVALID_RESPONSE');
    }
    if (
      !Number.isSafeInteger(options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) ||
      (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) < 1 ||
      (options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) > MAX_RESPONSE_BYTES
    ) {
      throw new FlyGraphqlClientError('INVALID_RESPONSE');
    }
    this.accessToken = options.accessToken;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.fetch = options.fetch ?? fetch;
    this.signal = options.signal;
  }

  /** Read whether the signed-in Fly user has accepted the Tigris provider terms. */
  async hasAcceptedTerms(): Promise<boolean> {
    return this.request(
      FLY_TIGRIS_TERMS_QUERY,
      { provider: 'tigris' },
      parseTigrisTermsResponse,
      false
    );
  }

  /**
   * Create the planned private Tigris add-on.
   *
   * A transport or response failure is classified as uncertain because Fly may have accepted
   * the mutation. The caller must inspect by provider-issued provenance and must not retry blindly.
   *
   * @param input - Validated creation identity selected by the consented plan.
   */
  async createTigris(input: TigrisCreateInput): Promise<TigrisAddOnIdentity> {
    let variables: ReturnType<typeof createTigrisVariables>;
    try {
      variables = createTigrisVariables(input);
    } catch {
      throw new FlyGraphqlClientError('INVALID_RESPONSE');
    }
    if (!(await this.hasAcceptedTerms())) {
      throw new FlyGraphqlClientError('TERMS_NOT_ACCEPTED');
    }
    return this.request(FLY_TIGRIS_CREATE_MUTATION, variables, parseTigrisCreateResponse, true);
  }

  /** Read one Tigris add-on by its provider-issued exact ID. */
  async readTigris(addOnId: string): Promise<TigrisAddOnIdentity> {
    if (!SAFE_PROVIDER_IDENTIFIER_PATTERN.test(addOnId)) {
      throw new FlyGraphqlClientError('INVALID_RESPONSE');
    }
    return this.request(FLY_TIGRIS_READ_QUERY, { id: addOnId }, parseTigrisReadResponse, false);
  }

  /** Delete one exact Tigris name after the caller independently reverified its journal binding. */
  async deleteTigris(addOnName: string): Promise<string> {
    if (!SAFE_PROVIDER_IDENTIFIER_PATTERN.test(addOnName)) {
      throw new FlyGraphqlClientError('INVALID_RESPONSE');
    }
    return this.request(
      FLY_TIGRIS_DELETE_MUTATION,
      { name: addOnName, provider: 'tigris' },
      (response) => parseTigrisDeleteResponse(response, addOnName),
      true
    );
  }

  private async request<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    parse: (response: unknown) => T,
    mutating: boolean
  ): Promise<T> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    this.signal?.addEventListener('abort', cancel, { once: true });
    if (this.signal?.aborted) cancel();
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(
          new FlyGraphqlClientError(
            mutating ? 'CREATION_OUTCOME_UNCERTAIN' : 'PROVIDER_UNAVAILABLE'
          )
        );
      }, this.timeoutMs);
    });
    const operation = (async () => {
      try {
        const response = await this.fetch(FLY_GRAPHQL_ENDPOINT, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${this.accessToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ query, variables }),
          signal: controller.signal,
        });
        if (response.status === 401) {
          void response.body?.cancel().catch(() => undefined);
          throw new FlyGraphqlClientError('AUTH_REQUIRED');
        }
        if (response.status === 403) {
          void response.body?.cancel().catch(() => undefined);
          throw new FlyGraphqlClientError('ACCESS_DENIED');
        }
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new FlyGraphqlClientError(
            mutating ? 'CREATION_OUTCOME_UNCERTAIN' : 'PROVIDER_UNAVAILABLE'
          );
        }
        try {
          return parse(await readBounded(response, this.maxResponseBytes, controller.signal));
        } catch (error) {
          if (controller.signal.aborted) {
            throw new FlyGraphqlClientError(
              mutating ? 'CREATION_OUTCOME_UNCERTAIN' : 'PROVIDER_UNAVAILABLE'
            );
          }
          if (!mutating && error instanceof FlyGraphqlContractError) {
            throw new FlyGraphqlClientError(error.code);
          }
          if (!mutating && error instanceof FlyGraphqlClientError) throw error;
          throw new FlyGraphqlClientError(
            mutating ? 'CREATION_OUTCOME_UNCERTAIN' : 'INVALID_RESPONSE'
          );
        }
      } catch (error) {
        if (error instanceof FlyGraphqlClientError) throw error;
        throw new FlyGraphqlClientError(
          mutating ? 'CREATION_OUTCOME_UNCERTAIN' : 'PROVIDER_UNAVAILABLE'
        );
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', cancel);
    }
  }
}

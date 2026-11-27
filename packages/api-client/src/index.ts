/**
 * A typed client for the DorkOS HTTP API, generated from
 * `docs/api/openapi.json` and called by operationId. How to add a call:
 * `contributing/data-fetching.md`.
 *
 * @module api-client
 */
export {
  ApiProblemError,
  createApiClient,
  type ApiClient,
  type ApiClientOptions,
  type CallOptions,
  type FetchLike,
  type OperationId,
  type OperationInput,
  type OperationResult,
} from './client.js';
export type { components, operations, paths } from './generated/openapi.js';

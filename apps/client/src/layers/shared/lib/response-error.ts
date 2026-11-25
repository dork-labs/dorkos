/**
 * The app's one reader of a failed API response.
 *
 * Every failed answer is read the same way: a problem document
 * (`application/problem+json`), or one of the few answers that are not problems
 * on purpose, the login gate and a held action (`readErrorBody` in
 * `@dorkos/shared/problem` holds the rule). A caller gets a sentence for a
 * person and, when the server gave one, a code to branch on.
 *
 * @module shared/lib/response-error
 */
import { readErrorBody, type ErrorBodyReading } from '@dorkos/shared/problem';

/** What a failed response said, plus the parsed body as it came. */
export interface ResponseErrorReading extends ErrorBodyReading {
  /** The HTTP status of the response. */
  status: number;
  /** The parsed JSON body, or `undefined` when it was not JSON. */
  body: unknown;
}

/** The error a failed request rejects with: a message, and what the answer said. */
export type ResponseError = Error & {
  /** The machine-readable failure code, when the server gave one. */
  code?: string;
  /** The HTTP status. */
  status: number;
  /** The parsed body, for a refusal that carries data the caller acts on. */
  body?: unknown;
  /** What failed validation, in Zod's flattened form. */
  issues?: ErrorBodyReading['issues'];
  /** How long to wait before retrying, when the answer said. */
  retryAfterMs?: number;
};

/**
 * Read a failed response's body.
 *
 * @param res - The response; its body is consumed.
 * @param fallbackMessage - The message when the body says none. Defaults to
 *   the status text, then `HTTP <status>`.
 * @returns The reading.
 */
export async function readResponseError(
  res: Response,
  fallbackMessage?: string
): Promise<ResponseErrorReading> {
  const body: unknown = await res.json().catch(() => undefined);
  const fallback = fallbackMessage ?? (res.statusText || `HTTP ${res.status}`);
  return { ...readErrorBody(body, fallback), status: res.status, body };
}

/**
 * Turn a failed response into the error a request rejects with.
 *
 * @param res - The response; its body is consumed.
 * @param fallbackMessage - See {@link readResponseError}.
 * @returns The error, to throw.
 */
export async function responseError(
  res: Response,
  fallbackMessage?: string
): Promise<ResponseError> {
  return errorFromReading(await readResponseError(res, fallbackMessage));
}

/**
 * The error for a reading already taken, as {@link responseError} builds it.
 *
 * @param reading - What the failed response said.
 * @returns The error, to throw.
 */
export function errorFromReading(reading: ResponseErrorReading): ResponseError {
  const error = new Error(reading.message) as ResponseError;
  error.status = reading.status;
  error.body = reading.body;
  if (reading.code !== undefined) error.code = reading.code;
  if (reading.issues !== undefined) error.issues = reading.issues;
  if (reading.retryAfterMs !== undefined) error.retryAfterMs = reading.retryAfterMs;
  return error;
}

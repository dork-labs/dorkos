/**
 * The error an extension API call throws when the server refuses it.
 *
 * @module features/extensions/model/request-error
 */
import { readResponseError } from '@/layers/shared/lib';

/**
 * An Error carrying the server's own sentence and code, so an extension can
 * tell "not running" from "already settled" (`err.code`).
 *
 * The server answers a problem document (DOR-4979). Its finer word, when it
 * has one (`reason`: `not_running`, `already_resolved`), is the `code` an
 * extension matches on; otherwise the problem's own code (`not_found`).
 *
 * @param res - The refused response.
 * @param method - Which API member asked, for the fallback message.
 */
export async function requestError(
  res: Response,
  method: string
): Promise<Error & { code?: string; status: number }> {
  const body = await readResponseError(res, `${method} failed: ${res.status}`);
  const error = new Error(body.message) as Error & {
    code?: string;
    status: number;
  };
  error.status = res.status;
  const reason = (body.body as { reason?: unknown } | null | undefined)?.reason;
  const code = typeof reason === 'string' && reason !== '' ? reason : body.code;
  if (code) error.code = code;
  return error;
}

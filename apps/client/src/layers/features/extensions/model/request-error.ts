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
 * The server answers a problem document (DOR-4979); its `code` is the one an
 * extension matches on (`not_running`, `already_resolved`, `not_found`).
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
  if (body.code) error.code = body.code;
  return error;
}

/**
 * The one answer to a multipart body the upload parser refused
 * (`http/uploads.ts`): a problem document (DOR-4979).
 *
 * A file over the route's size limit is `413 request_too_large`; every other
 * limit, and a body the parser could not read, is `400 malformed_request` in
 * the parser's own words. A route that has something better to say about the
 * size limit (its own cap, in megabytes) passes that sentence.
 *
 * @module http/problems/upload-refusal
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import { UploadLimitError } from '../uploads.js';

/** Options for {@link uploadRefusalProblem}. */
export interface UploadRefusalOptions {
  /** The sentence for a file over the size limit, naming the route's cap. */
  tooLargeDetail?: string;
}

/**
 * Answer an upload the parser refused.
 *
 * @param c - The Hono context.
 * @param err - What `parseUploads` or `parseUploadForm` rejected with.
 * @param options - See {@link UploadRefusalOptions}.
 * @returns The response.
 */
export function uploadRefusalProblem(
  c: Context,
  err: unknown,
  options: UploadRefusalOptions = {}
): Response {
  if (err instanceof UploadLimitError && err.code === 'LIMIT_FILE_SIZE') {
    return problem(c, 'request_too_large', { detail: options.tooLargeDetail ?? err.message });
  }
  const detail =
    err instanceof Error && err.message ? err.message : 'That upload could not be read.';
  return problem(c, 'malformed_request', { detail });
}

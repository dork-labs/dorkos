/**
 * The one answer to a multipart body the upload parser refused
 * (`http/uploads.ts`): a problem document (DOR-4979).
 *
 * A file over the route's size limit is `413 request_too_large`; a file type
 * the config refuses is `415 unsupported_media_type`; every other limit is
 * `400 malformed_request` in the parser's table's words; and a body the parser
 * could not read is `400 malformed_request` with a fixed sentence. A route that has something better to say about the
 * size limit (its own cap, in megabytes) passes that sentence.
 *
 * @module http/problems/upload-refusal
 */
import type { Context } from 'hono';
import { problem } from '@dorkos/http-kit';
import { UploadTypeRefusedError } from '../../services/core/upload-handler.js';
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
  // Every sentence here is fixed: an `UploadLimitError`'s message comes from
  // the parser's own table (`http/uploads.ts`), and anything else (busboy's
  // words, a storage failure) is never echoed, since it can carry a path.
  if (err instanceof UploadLimitError && err.code === 'LIMIT_FILE_SIZE') {
    return problem(c, 'request_too_large', { detail: options.tooLargeDetail ?? err.message });
  }
  if (err instanceof UploadLimitError)
    return problem(c, 'malformed_request', { detail: err.message });
  if (err instanceof UploadTypeRefusedError) {
    return problem(c, 'unsupported_media_type', {
      detail: 'That type of file isn’t allowed in uploads.',
    });
  }
  return problem(c, 'malformed_request', {
    detail: 'That upload couldn’t be read. Send it again as one complete form.',
  });
}

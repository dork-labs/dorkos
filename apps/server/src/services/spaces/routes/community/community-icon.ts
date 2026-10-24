/** Reading an uploaded space icon and explaining why the blob store refused it. */
import { ApiError } from '../../http.js';
import { BlobStoreError } from '../../storage/index.js';

/** Read a request body as a stream of chunks, releasing the reader when done. */
export async function* requestBytes(body: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader();
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) return;
      yield item.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Turn a blob store refusal of a space icon into the error the person sees. */
export function mapIconBlobError(error: unknown): never {
  if (error instanceof BlobStoreError) {
    if (error.code === 'BLOB_TOO_LARGE')
      throw new ApiError(413, 'ATTACHMENT_TOO_LARGE', 'The icon is larger than 2 MiB.');
    if (error.code === 'BLOB_TYPE_REJECTED' || error.code === 'BLOB_EMPTY')
      throw new ApiError(415, 'UNSUPPORTED_ATTACHMENT_TYPE', 'Use a PNG, JPEG, GIF, or WebP icon.');
    if (error.code === 'BLOB_NOT_FOUND')
      throw new ApiError(404, 'NOT_FOUND', 'Space icon not found.');
  }
  throw error;
}

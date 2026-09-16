import {
  RemoteCommunityEventSchema,
  type RemoteCommunityTransport,
} from '@dorkos/shared/community-views';
import { buildQueryString, fetchResponse } from './http-client';
import { parseSSEStream } from './sse-parser';

/** Stream one qualified local API address; never contact a remote origin from the browser. */
export function createRemoteCommunityStream(
  baseUrl: string
): RemoteCommunityTransport['subscribeRemoteCommunityRoom'] {
  return async (ref, roomId, onEvent, options) => {
    const controller = new AbortController();
    const signal = options?.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const deadline = setTimeout(
      () => controller.abort(new DOMException('Community stream did not open.', 'TimeoutError')),
      30_000
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let body: ReadableStream<Uint8Array> | undefined;
    const cancelRead = () => {
      void reader?.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancelRead, { once: true });
    try {
      const path = `/communities/${encodeURIComponent(ref)}/rooms/${encodeURIComponent(roomId)}/events`;
      const response = await fetchResponse(
        baseUrl,
        path + buildQueryString({ since: options?.since }),
        {
          headers: { Accept: 'text/event-stream' },
          signal,
          timeout: null,
        }
      );
      clearTimeout(deadline);
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !==
          'text/event-stream' ||
        !response.body
      ) {
        await response.body?.cancel();
        throw new Error('The community stream returned an invalid response.');
      }
      body = response.body;
      reader = body.getReader();
      if (signal.aborted) return;
      let snapshotReceived = false;
      for await (const frame of parseSSEStream(reader, { onParseError: 'throw' })) {
        if (signal.aborted) return;
        if (frame.comment) continue;
        const event = RemoteCommunityEventSchema.parse(frame.data);
        const address =
          event.type === 'snapshot' ? event.room : event.type === 'entry' ? event.entry : event;
        if (address.community !== ref || address.roomId !== roomId || frame.type !== event.type) {
          throw new Error('The community stream returned data for a different room.');
        }
        if (event.type !== 'closed' && !snapshotReceived && event.type !== 'snapshot') {
          throw new Error('The community stream did not begin with a snapshot.');
        }
        if (event.type === 'snapshot') snapshotReceived = true;
        onEvent(event);
        if (event.type === 'closed') return;
      }
      if (!signal.aborted)
        throw new Error('The community connection ended. Reconnect to receive new messages.');
    } catch (error) {
      if (!options?.signal?.aborted) throw error;
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener('abort', cancelRead);
      controller.abort();
      await reader?.cancel().catch(() => undefined);
      // The parser releases its reader lock on exit; cancel the unlocked body too.
      await body?.cancel().catch(() => undefined);
    }
  };
}

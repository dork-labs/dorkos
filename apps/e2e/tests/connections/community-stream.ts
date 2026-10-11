/**
 * A Community room's live stream that a test writes to, for specs where a person posts and the
 * channel has to stay live (DOR-2268). Shared by the channel-view and member-conduct specs.
 *
 * @module e2e/connections/community-stream
 */
import type { Page } from '@playwright/test';
import { ROOM, room, type CommunitySpec } from './community-mocks.js';

/** A committed entry as the stream carries it; only its order fields are read here. */
export type StreamEntry = { cursor: string; remoteSeq: number } & Record<string, unknown>;

/** One SSE frame, as the local server writes it. */
export function frame(type: string, data: unknown) {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Write text into the newest open stream, from the test's side, once the app has opened one. */
export async function push(page: Page, text: string) {
  await page.waitForFunction(() => (window as unknown as { __streams: number }).__streams > 0);
  await page.evaluate(
    (value) => (window as unknown as { __push: (text: string) => void }).__push(value),
    text
  );
}

/**
 * Replace the room's live stream with one the test writes to.
 *
 * `page.route` can only answer a request whole, which ends the stream and
 * leaves the channel read-only while it reconnects. A person posting needs the
 * channel live, so the stream is answered inside the page instead: an open
 * body the test pushes frames into, which stays open until the app closes it.
 */
export async function controllableStream(page: Page, community: CommunitySpec) {
  await page.addInitScript(
    ({ path }) => {
      const encoder = new TextEncoder();
      const open: ReadableStreamDefaultController<Uint8Array>[] = [];
      const exposed = window as unknown as {
        __push: (text: string) => void;
        __streams: number;
        __opened: number;
      };
      exposed.__streams = 0;
      exposed.__opened = 0;
      exposed.__push = (text) => open.at(-1)?.enqueue(encoder.encode(text));
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!new URL(url, location.href).pathname.endsWith(path)) return original(input, init);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
        open.push(controller);
        exposed.__streams = open.length;
        exposed.__opened += 1;
        init?.signal?.addEventListener('abort', () => {
          open.splice(open.indexOf(controller), 1);
          exposed.__streams = open.length;
          try {
            controller.error(new DOMException('Aborted', 'AbortError'));
          } catch {
            // Already closed by the reader.
          }
        });
        return Promise.resolve(
          new Response(body, { headers: { 'content-type': 'text/event-stream' } })
        );
      };
    },
    { path: `/api/communities/${community.ref}/rooms/${ROOM}/events` }
  );
  return {
    /** Open the stream: the room and everything it holds now. */
    snapshot: (entries: StreamEntry[]) =>
      push(
        page,
        frame('snapshot', {
          type: 'snapshot',
          room: room(community),
          entries,
          cursor: entries.at(-1)?.cursor ?? null,
          lastRemoteSeq: entries.at(-1)?.remoteSeq ?? 0,
          stale: false,
        })
      ),
    /** Deliver committed entries one by one, the way a live burst arrives. */
    arrive: (entries: StreamEntry[]) =>
      push(page, entries.map((item) => frame('entry', { type: 'entry', entry: item })).join('')),
  };
}

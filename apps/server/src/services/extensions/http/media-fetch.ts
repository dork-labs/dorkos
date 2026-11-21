/**
 * How the media route asks a running extension for a video (DOR-4321): one
 * {@link ExtensionMediaFetch} per running extension that can answer it, kept
 * beside its HTTP handler by `extension-server-lifecycle.ts`.
 *
 * A media request carries a ticket, not a person (`media-tickets.ts`). So the
 * app is always told its caller is not a person ({@link NO_PERSON}), whoever
 * minted the ticket, and the request it gets holds only the headers the media
 * route copied (`Range`, `If-Range`): no cookie, no `Origin`, no agent and no
 * `x-dorkos-*` header. It never runs as the person's request either.
 *
 * Only an app with a `fetch` handler, or one in its own process, can answer.
 * An app with only an Express router gets no media fetch, so its window is
 * told the app cannot stream video.
 *
 * @module services/extensions/http/media-fetch
 */
import type { ExtensionFetchHandler, PersonRefusal } from '@dorkos/extension-api/server';

/**
 * Ask a running extension's own route for a video.
 *
 * @param subPath - The normalized path below its mount.
 * @param headers - The only request headers it sees.
 * @param method - `GET`, or `HEAD` for the headers only.
 * @param signal - Aborts when the person's player goes away.
 * @returns The extension's own answer, before the media route's reply rules.
 */
export type ExtensionMediaFetch = (
  subPath: string,
  headers: Headers,
  method: 'GET' | 'HEAD',
  signal?: AbortSignal
) => Promise<Response>;

/** The caller a media request names: never a person, whoever minted the ticket. */
export const NO_PERSON: PersonRefusal = Object.freeze({
  ok: false,
  status: 403,
  body: Object.freeze({
    error: 'A video link can only play the video.',
    code: 'extension_person_required',
    message: 'A video link can only play the video. Ask a person to do this in DorkOS.',
  }),
});

/**
 * The media fetch for an extension that runs in DorkOS's own process: its
 * `fetch` handler, given the path below its mount as every other request is
 * (`fetch-handler.ts`), and {@link NO_PERSON}.
 *
 * @param name - The extension's name, for the error when it answers wrongly.
 * @param fetch - The handler `register()` returned, if any.
 * @returns The media fetch, or `null` when it has no `fetch` handler.
 */
export function inProcessMediaFetch(
  name: string,
  fetch: ExtensionFetchHandler | null | undefined
): ExtensionMediaFetch | null {
  if (!fetch) return null;
  const caller = Object.freeze({ person: NO_PERSON });
  return async (subPath, headers, method, signal) => {
    const request = new Request(`http://dorkos.invalid${subPath}`, { method, headers, signal });
    const answer: unknown = await fetch(request, caller);
    if (!(answer instanceof Response)) {
      throw new Error(`${name} answered with something that is not a Response.`);
    }
    return answer;
  };
}

/**
 * Sending a file from a folder, for a route on the Hono chain:
 * {@link sendFileFromRoot} is Express's `res.sendFile` for a moved route, with
 * the folder guard the route used to write itself.
 *
 * Built on `send`, the module `res.sendFile` is, for the reason
 * `http/client-files.ts` gives: the same `Content-Type`, `Content-Length`,
 * `ETag` and `Last-Modified`, `Cache-Control: public, max-age=0`, ranges with
 * `206` and `416`, conditional `304` and `412`, `HEAD`, and the refusal of a
 * name with a dotfile segment in it, which `send` ignores (a `404`) unless
 * told otherwise. `send` writes the raw Node response itself, so the
 * route answers with the marker the adapter leaves alone.
 *
 * A file that cannot be sent is not answered here: the route gets the error,
 * before anything was written, and words the refusal itself, as the
 * `res.sendFile` callback did.
 *
 * @module http/send-file
 */
import path from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import type { Context } from 'hono';
import send from 'send';

/** The outcome of {@link sendFileFromRoot}. */
export type SendFileResult =
  /** The response is on its way: return `response` from the handler. */
  | { kind: 'sent'; response: Response }
  /** The name resolves outside `root`; nothing was read. */
  | { kind: 'outside' }
  /**
   * Nothing was written. `status` is what `send` would have answered (`404`
   * for a missing file or a dotfile path, `416` for a range past the end, and
   * so on); a folder is an `EISDIR` error with no status.
   */
  | { kind: 'failed'; error: NodeJS.ErrnoException & { status?: number } };

/** The Hono environment {@link sendFileFromRoot} writes to: the raw Node pair. */
type SendFileEnv = { Bindings: HttpBindings };

/**
 * Send the file `name` names inside `root`, refusing a name that resolves
 * anywhere else.
 *
 * `name` is resolved against `root`, and must land inside it (or be it), the
 * check `routes/uploads.ts` made before `res.sendFile`. It is then sent
 * relative to `root`, so the dotfile rule sees only the name's own segments.
 * Sending the whole absolute path, as `res.sendFile` did, made the rule see
 * the root's too, and every upload lives under `.dork/` (DOR-2990).
 *
 * @param c - The Hono context.
 * @param root - The folder the file must be in.
 * @param name - The file, relative to `root`.
 * @returns See {@link SendFileResult}.
 */
export function sendFileFromRoot<E extends SendFileEnv>(
  c: Context<E>,
  root: string,
  name: string
): Promise<SendFileResult> {
  const folder = path.resolve(root);
  const resolved = path.resolve(path.join(root, name));
  if (!resolved.startsWith(folder + path.sep) && resolved !== folder) {
    return Promise.resolve({ kind: 'outside' });
  }
  const { incoming, outgoing } = c.env;
  return new Promise((resolve) => {
    let settled = false;
    const sent = () => {
      if (settled) return;
      settled = true;
      // A fresh marker each time: the shared one has mutable headers.
      resolve({
        kind: 'sent',
        response: new Response(null, { headers: RESPONSE_ALREADY_SENT.headers }),
      });
    };
    // What `send` sets before it can still refuse: a `412` or a `416` comes
    // after its `headers` step, so a refusal must not carry the file's
    // `Content-Length`, `ETag` or `Content-Type` into the route's own answer.
    const before = new Set(outgoing.getHeaderNames());
    const failed = (error: NodeJS.ErrnoException & { status?: number }) => {
      if (settled) return;
      // Once bytes went out there is nothing left to answer, as with
      // `res.sendFile`, whose callback answered only when no header was sent.
      if (outgoing.headersSent) return sent();
      for (const name of outgoing.getHeaderNames()) {
        if (!before.has(name)) outgoing.removeHeader(name);
      }
      settled = true;
      resolve({ kind: 'failed', error });
    };
    // URI-encoded, as `res.sendFile` handed it; `send` decodes it.
    const relative = path.relative(folder, resolved).split(path.sep).join('/');
    send(incoming, encodeURI(`/${relative}`), { root: folder })
      .on('directory', () => failed(Object.assign(new Error('EISDIR, read'), { code: 'EISDIR' })))
      .on('error', failed)
      // Settled when the body starts, not on `headers`: `send` emits `headers`
      // before its precondition and range checks, and hands a `412` or `416`
      // to the `error` listener afterwards, which must still be answered.
      .on('stream', sent)
      .pipe(outgoing);
    // A `304` and a `HEAD` never stream; they still finish.
    outgoing.once('finish', sent);
    outgoing.once('close', sent);
  });
}

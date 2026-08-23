/**
 * The build-time constants every bundle of this client must substitute.
 *
 * **One source, because there is more than one bundler.** The client's source is
 * built twice from two configs: `apps/client/vite.config.ts` for the web cockpit
 * and the `renderer` section of `apps/desktop/electron.vite.config.ts` for the
 * desktop shell. A `define` only one of them knows about is not a build error —
 * it is a bare identifier left in the output, and the first line that evaluates
 * it throws `ReferenceError` before React can mount. That is what shipped in
 * v0.63.0: every desktop install opened a permanently black window (DOR-1448).
 *
 * So the map lives here and both configs import it. Adding a constant can no
 * longer reach one bundle and miss the other, and the renderer gate
 * (`apps/desktop/scripts/check-renderer-defines.ts`) fails the build if one ever
 * does.
 *
 * @module vite-define
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The `define` entries the client is built with.
 *
 * Read relative to THIS file rather than the working directory: plain vite runs
 * from `apps/client/` and electron-vite from `apps/desktop/`, so a cwd-relative
 * read would find the root `package.json` from only one of them. Both config
 * loaders bundle their config with a per-file `__dirname` injected, so it is
 * this file's own directory either way.
 *
 * @returns Vite `define` entries, values JSON-encoded as `define` requires.
 */
export function clientDefines(): Record<string, string> {
  // The release version, from the one package.json that carries it — the whole
  // monorepo bumps together at release, and `packages/cli` (what ships) reads
  // the same number. The client's own package.json is the `0.0.0` sentinel, so
  // it cannot be the source.
  const { version } = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../package.json'), 'utf-8')
  ) as { version: string };

  return {
    // The build's identity, for anything that must start over when the build
    // changes. Today that is the persisted query cache's `buster`
    // (`shared/lib/query-persister.ts`): a new build may have changed the shape
    // of a payload, so it starts from an empty local memory rather than
    // hydrating yesterday's shape into today's components.
    __APP_VERSION__: JSON.stringify(version),
  };
}

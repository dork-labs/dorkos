/**
 * The build-time constants every bundle of this client must substitute.
 *
 * **One source, because there is more than one bundler.** The client's source is
 * built three times from three configs: `apps/client/vite.config.ts` for the web
 * cockpit, the `renderer` section of `apps/desktop/electron.vite.config.ts` for
 * the desktop shell, and `apps/obsidian-plugin/vite.config.ts` for the Obsidian
 * embed. A `define` only one of them knows about is not a build error — it is a
 * bare identifier left in the output, and the first line that evaluates it
 * throws `ReferenceError` before React can mount. That is what shipped in
 * v0.63.0: every desktop install opened a permanently black window (DOR-1448).
 *
 * So the map lives here and all three configs import it. Adding a constant can
 * no longer reach some bundles and miss others, and each bundle's own gate
 * (`apps/desktop/scripts/check-renderer-defines.ts`,
 * `apps/obsidian-plugin/scripts/check-plugin-defines.ts`) fails its build if one
 * ever does.
 *
 * @module vite-define
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The `define` entries the client is built with.
 *
 * Read relative to THIS file rather than the working directory: plain vite runs
 * from `apps/client/`, electron-vite from `apps/desktop/`, and the Obsidian
 * plugin's vite from `apps/obsidian-plugin/`, so a cwd-relative read would find
 * the root `package.json` from only one of them. Every config loader bundles
 * its config with a per-file `__dirname` injected, so it is this file's own
 * directory either way.
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

import { createRequire } from 'node:module';

/**
 * Resolve modules relative to this file. ESM has no ambient `require`, and this
 * guard must load esbuild from the installed package on disk — never a copy
 * inlined into the CLI bundle (that is the exact failure it exists to catch).
 */
const requireFrom = createRequire(import.meta.url);

/**
 * Verify the packaged CLI can actually COMPILE a server-capable extension, not
 * just that the extension source shipped.
 *
 * DOR-245 fixed the missing `core-extensions/` directory, but its guard only
 * checked that the files existed. DOR-256 then found that every server-capable
 * extension (marketplace is `defaultEnabled: true`) still failed at runtime:
 * the esbuild JS API — used by `services/extensions/extension-compiler.ts` to
 * tsx-transpile extension source — was inlined into the single-file server
 * bundle, which broke its native-binary lookup. A file-existence check cannot
 * catch that; only running esbuild can.
 *
 * This exercises esbuild the same way the extension compiler does: resolve it
 * from `node_modules` (proving it ships as a real dependency rather than a
 * bundled copy) and transpile a trivial TypeScript snippet (proving its native
 * binary spawns). esbuild is loaded via `requireFrom` rather than a static
 * `import` on purpose — a static import would itself be inlined into the CLI
 * bundle and reintroduce the very failure this guard checks for.
 *
 * @returns true if esbuild resolves and transpiles TypeScript, false otherwise.
 */
export async function checkExtensionCompilation(): Promise<boolean> {
  let esbuild: typeof import('esbuild');
  try {
    esbuild = requireFrom('esbuild') as typeof import('esbuild');
  } catch {
    return false; // esbuild is not installed as a runtime dependency.
  }

  try {
    const { code } = await esbuild.transform('export const ok: boolean = true;', {
      loader: 'ts',
    });
    return code.includes('ok');
  } catch {
    return false; // esbuild resolved but its native binary could not run.
  }
}

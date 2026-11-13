import { execFileSync } from 'child_process';
import { rmSync } from 'fs';
import path from 'path';
import { build, type Message, type Plugin } from 'esbuild';

/** What fails a build on a warning it doesn't expect. */
type AssertNoWarnings = (warnings: Message[]) => Promise<void>;

/**
 * Check a forked child's bundle: no warnings, and it parses. A bad one takes the whole server
 * output with it, so a half-built folder can't be packaged.
 *
 * @param out - The desktop build's output folder.
 * @param outfile - The bundle.
 * @param warnings - What esbuild warned about.
 * @param assertNoWarnings - Fails the build on a warning it doesn't expect.
 */
export async function checkChildBundle(
  out: string,
  outfile: string,
  warnings: Message[],
  assertNoWarnings: AssertNoWarnings
): Promise<void> {
  try {
    await assertNoWarnings(warnings);
    execFileSync(process.execPath, ['--check', outfile], { stdio: 'inherit' });
  } catch (err) {
    rmSync(path.join(out, 'server'), { recursive: true, force: true });
    throw err;
  }
}

/**
 * Bundle the shell guard's child (DOR-3300): the server forks it to read a shell command, so a
 * command that stalls or crashes the reading can't touch the server. One self-contained CommonJS
 * file beside the server bundle, unpacked from app.asar (`electron-builder.yml`). Same entry and name
 * as the CLI build; scripts/__tests__/extension-child-build-entry.test.ts pins both.
 *
 * @param root - The repo's root.
 * @param out - The desktop build's output folder.
 * @param plugin - The plugin that resolves DorkOS's own packages to source.
 * @param assertNoWarnings - Fails the build on a warning it doesn't expect.
 */
export async function buildGuardChild(
  root: string,
  out: string,
  plugin: Plugin,
  assertNoWarnings: AssertNoWarnings
): Promise<void> {
  const outfile = path.join(out, 'server/shell-guard-child.cjs');
  const result = await build({
    entryPoints: [
      path.join(root, 'apps/server/src/services/runtimes/claude-code/shell-guard/guard-child.ts'),
    ],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'cjs',
    outfile,
    plugins: [plugin],
  });
  await checkChildBundle(out, outfile, result.warnings, assertNoWarnings);
}

/**
 * Bundle the Terminal command (DOR-3105): the `dorkos` that `~/.local/bin/dorkos` runs with the
 * app's own Node (`ELECTRON_RUN_AS_NODE`). One ES module at `dist/cli/dorkos.mjs` (ESM because the
 * browser code reads `import.meta.url`, with the server bundle's `require` shim), unpacked from
 * app.asar (`electron-builder.yml`) so it is a real file a shell can name. Only the browser commands
 * and the version; `packages/cli/src/desktop/terminal-command.ts` says why.
 *
 * @param root - The repo's root.
 * @param out - The desktop build's output folder.
 * @param plugin - The plugin that resolves DorkOS's own packages to source.
 * @param assertNoWarnings - Fails the build on a warning it doesn't expect.
 * @param version - The app's version, printed by `dorkos --version`.
 */
export async function buildTerminalCommand(
  root: string,
  out: string,
  plugin: Plugin,
  assertNoWarnings: AssertNoWarnings,
  version: string
): Promise<void> {
  rmSync(path.join(out, 'cli'), { recursive: true, force: true });
  const outfile = path.join(out, 'cli/dorkos.mjs');
  const result = await build({
    entryPoints: [path.join(root, 'packages/cli/src/desktop/terminal-command-main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node22.22',
    format: 'esm',
    outfile,
    banner: {
      js: "import { createRequire as __cjsRequire } from 'module'; const require = __cjsRequire(import.meta.url);",
    },
    // Unpacked beside it in the app (asarUnpack), like the server bundle's own copy.
    external: ['playwright-core'],
    define: { __CLI_VERSION__: JSON.stringify(version) },
    plugins: [plugin],
  });
  try {
    await assertNoWarnings(result.warnings);
    execFileSync(process.execPath, ['--check', outfile], { stdio: 'inherit' });
  } catch (err) {
    rmSync(path.join(out, 'cli'), { recursive: true, force: true });
    throw err;
  }
}

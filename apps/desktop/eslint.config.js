import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  // core-extensions/ is build output copied by scripts/build-server.ts —
  // raw apps/server source staged alongside dist/, not authored here
  // (mirrors packages/cli's identical ignore for the same reason, DOR-245).
  // .temp/ is the dev-mode DORK_HOME (src/main/dork-home.ts): running the
  // desktop app in dev writes a real data directory, extension cache
  // included, under here. ESLint's flat config does not read .gitignore, so
  // without this it becomes lintable the moment anyone runs the app (DOR-573).
  { ignores: ['dist/**', 'release/**', '.turbo/**', 'core-extensions/**', '.temp/**'] },
  ...nodeConfig,

  // process.env carve-outs. The desktop app has no env.ts: the main process
  // reads Electron/electron-vite runtime env (ELECTRON_RENDERER_URL) and
  // composes the child server's env, and server-entry runs inside that child
  // where env vars ARE the IPC contract with the main process.
  {
    files: ['src/main/server-spawn.ts', 'src/main/window-manager.ts', 'src/server-entry.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  // Same carve-out for the build/QA scripts, for the same reason: they compose
  // the environment of child processes they spawn (esbuild's specifier-
  // resolution child, the packaged app under smoke test), so process.env is the
  // interface, not a config read that an env.ts could own.
  {
    files: ['scripts/**/*.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  ...testConfig,
]);

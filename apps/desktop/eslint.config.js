import { defineConfig } from 'eslint/config';
import nodeConfig from '@dorkos/eslint-config/node';
import testConfig from '@dorkos/eslint-config/test';

export default defineConfig([
  // core-extensions/ is build output copied by scripts/build-server.ts —
  // raw apps/server source staged alongside dist/, not authored here
  // (mirrors packages/cli's identical ignore for the same reason, DOR-245).
  { ignores: ['dist/**', 'release/**', '.turbo/**', 'core-extensions/**'] },
  ...nodeConfig,

  // process.env carve-outs. The desktop app has no env.ts: the main process
  // reads Electron/electron-vite runtime env (ELECTRON_RENDERER_URL) and
  // composes the child server's env, and server-entry runs inside that child
  // where env vars ARE the IPC contract with the main process.
  {
    files: ['src/main/server-process.ts', 'src/main/window-manager.ts', 'src/server-entry.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },

  ...testConfig,
]);

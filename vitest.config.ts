import { defineConfig } from 'vitest/config';

// Root-level project list so `pnpm vitest run <path>` works from the repo
// root. Full-suite runs go through turbo (`pnpm test -- --run`) — see
// AGENTS.md; running the whole workspace via bare vitest is unsupported.
export default defineConfig({
  test: {
    projects: [
      'apps/client',
      'apps/server',
      'packages/cli',
      'packages/db',
      'packages/mesh',
      'packages/relay',
      'packages/shared',
      'packages/test-utils',
      // Repo-root scripts are outside the pnpm workspaces; `pnpm test:scripts`
      // runs this project, and `pnpm verify` runs that.
      'scripts',
    ],
  },
});

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/client',
  'apps/roadmap',
  'apps/server',
  'packages/cli',
  'packages/db',
  'packages/mesh',
  'packages/relay',
  'packages/shared',
]);

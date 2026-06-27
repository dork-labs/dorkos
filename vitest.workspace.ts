import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'apps/client',
  'apps/server',
  'packages/cli',
  'packages/db',
  'packages/mesh',
  'packages/relay',
  'packages/shared',
  // The /flow engine authoring package, relocated under .agents/flow (ADR-0294).
  '.agents/flow/engine',
]);

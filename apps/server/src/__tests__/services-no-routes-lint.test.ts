/**
 * Services never import a route (DOR-4922): the `ROUTES_BAN` in `eslint.config.js`. Linted with
 * the package's real config, so a block that drops the ban (rule options replace rather than
 * merge) fails here.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** Linting the whole config takes a few seconds on a loaded machine. */
const LINT_TIMEOUT_MS = 30_000;

/** The `no-restricted-imports` messages for `code` linted as if it were the file at `path`. */
async function restricted(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result!.messages
    .filter((message) => message.ruleId === 'no-restricted-imports')
    .map((message) => message.message);
}

const ROUTE_IMPORTS = (up: string) =>
  [
    `import { createMeshRoutes } from '${up}routes/mesh.js';`,
    `import type { ApiEnv } from '${up}routes/room-route.js';`,
    'export const use = (env: ApiEnv) => [createMeshRoutes, env];',
  ].join('\n');

describe('services never import routes', { timeout: LINT_TIMEOUT_MS }, () => {
  it.each([
    ['a service', 'src/services/mesh/doors/scratch-example.ts', '../../../'],
    ['a confined directory', 'src/services/runtimes/claude-code/scratch-example.ts', '../../../'],
    ['an Express host', 'src/services/extensions/inbox/extension-inbox-context.ts', '../../../'],
    ['the agents-user-home carve-out', 'src/services/harness/agents-user-home.ts', '../../'],
  ])('refuses a value and a type-only route import in %s', async (_where, path, up) => {
    // Purpose: fails if any block that restates `no-restricted-imports` for a service drops the ban.
    const messages = await restricted(path, ROUTE_IMPORTS(up));
    expect(messages).toEqual([
      expect.stringContaining('A service never imports a route (DOR-4922)'),
      expect.stringContaining('A service never imports a route (DOR-4922)'),
    ]);
  });

  it('keeps the dependency bans beside it', async () => {
    // Purpose: fails if adding the routes ban replaced the SDK confinement for services.
    const messages = await restricted(
      'src/services/mesh/scratch-example.ts',
      "import { Codex } from '@openai/codex-sdk';\nexport const codex = Codex;"
    );
    expect(messages).toEqual([expect.stringContaining('Codex SDK imports are confined')]);
  });

  it.each([
    [
      'the space server, which imports its own routes folder',
      'src/services/spaces/a/b/x.ts',
      '../../',
    ],
    ['a test', 'src/services/mesh/__tests__/scratch-example.test.ts', '../../../'],
    ['code outside services', 'src/startup/steps/scratch-example.ts', '../../'],
  ])('lets %s import a route', async (_where, path, up) => {
    // Purpose: fails if the ban reached past services, into the frozen space tree, or into tests.
    expect(await restricted(path, ROUTE_IMPORTS(up))).toEqual([]);
  });

  it('lets a route import a service, and a service import a sibling named like a route', async () => {
    // Purpose: fails if the pattern matched the word `routes` anywhere rather than a climb into it.
    const route =
      "import { enrichTopology } from '../services/mesh/mesh-topology.js';\nexport const e = enrichTopology;";
    expect(await restricted('src/routes/scratch-example.ts', route)).toEqual([]);
    const sibling = [
      "import { PROGRAM_KEY_ROUTES } from '../principal/program-key-routes.js';",
      "import { routes } from './routes.js';",
      'export const all = [PROGRAM_KEY_ROUTES, routes];',
    ].join('\n');
    expect(await restricted('src/services/connectors/access/scratch-example.ts', sibling)).toEqual(
      []
    );
  });
});

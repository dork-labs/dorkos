/**
 * Services never import middleware (DOR-4922): the `MIDDLEWARE_BAN` in `eslint.config.js`.
 * Linted with the package's real config, so a block that drops or overrides the ban fails here.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** Linting the whole config takes a few seconds on a loaded machine. */
const LINT_TIMEOUT_MS = 30_000;

/** The middleware ban's messages for `code` linted as if it were the file at `path`. */
async function banned(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result!.messages
    .filter((message) => message.ruleId === '@typescript-eslint/no-restricted-imports')
    .map((message) => message.message);
}

const MIDDLEWARE_IMPORTS = (up: string) =>
  [
    `import { remoteAccessOn } from '${up}middleware/remote-access-switch.js';`,
    `import type { RequestFactsEnv } from '${up}middleware/agent-identity.js';`,
    'export const use = (env: RequestFactsEnv) => [remoteAccessOn, env];',
  ].join('\n');

describe('services never import middleware', { timeout: LINT_TIMEOUT_MS }, () => {
  it.each([
    ['a service', 'src/services/core/streams/scratch-example.ts', '../../../'],
    ['a confined directory', 'src/services/runtimes/claude-code/scratch-example.ts', '../../../'],
    ['an Express host', 'src/services/extensions/inbox/extension-inbox-context.ts', '../../../'],
    ['the agents-user-home carve-out', 'src/services/harness/agents-user-home.ts', '../../'],
  ])('refuses a value and a type-only middleware import in %s', async (_where, path, up) => {
    // Purpose: fails if the ban is dropped, or a later block reaching a service turns it off.
    const messages = await banned(path, MIDDLEWARE_IMPORTS(up));
    expect(messages).toEqual([
      expect.stringContaining('A service never imports middleware (DOR-4922)'),
      expect.stringContaining('A service never imports middleware (DOR-4922)'),
    ]);
  });

  it.each([
    ['the frozen space server', 'src/services/spaces/a/b/x.ts', '../../../../'],
    ['a test', 'src/services/core/streams/__tests__/scratch-example.test.ts', '../../../../'],
    ['code outside services', 'src/startup/scratch-example.ts', '../'],
    ['the chain itself', 'src/http/scratch-example.ts', '../'],
  ])('lets %s import middleware', async (_where, path, up) => {
    // Purpose: fails if the ban reached past services, into the frozen space tree, or into tests.
    expect(await banned(path, MIDDLEWARE_IMPORTS(up))).toEqual([]);
  });

  it('lets a service import a sibling named like middleware', async () => {
    // Purpose: fails if the pattern matched the word `middleware` anywhere rather than a climb into it.
    const sibling = [
      "import { step } from '../middleware.js';",
      "import { chain } from './middleware/chain.js';",
      'export const all = [step, chain];',
    ].join('\n');
    expect(await banned('src/services/core/streams/scratch-example.ts', sibling)).toEqual([]);
  });
});

/**
 * The hard syntax bans on `dorkos/restricted-syntax` (DOR-4938): a raw `c.req.json()` in a route,
 * a `projectVersion` string literal in server source, and a test bounding a timestamp by a later
 * `Date.now()`. Linted with the real configs, so a block that drops a selector (rule options
 * replace rather than merge) fails here.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const RELAY = fileURLToPath(new URL('../../../../packages/relay/', import.meta.url));
const linters = { [SERVER]: new ESLint({ cwd: SERVER }), [RELAY]: new ESLint({ cwd: RELAY }) };

/** Linting the whole config takes a few seconds on a loaded machine. */
const LINT_TIMEOUT_MS = 30_000;

/** The `dorkos/restricted-syntax` messages for `code` linted as the file at `root` + `path`. */
async function refusals(path: string, code: string, root = SERVER): Promise<string[]> {
  const [result] = await linters[root]!.lintText(code, { filePath: `${root}${path}` });
  return result!.messages
    .filter((message) => message.ruleId === 'dorkos/restricted-syntax')
    .map((message) => message.message);
}

const RAW_READ =
  'export const h = async (c: { req: { json(): Promise<unknown> } }) => c.req.json();';
const LITERAL_VERSION = "export const confOptions = { projectVersion: '0.92.0' };";
const DATE_NOW_BOUNDS = [
  'declare const at: number;',
  'expect(at).toBeLessThanOrEqual(Date.now());',
  'expect(Date.now()).toBeGreaterThanOrEqual(at);',
].join('\n');

describe('the hard syntax bans', { timeout: LINT_TIMEOUT_MS }, () => {
  it('refuses a raw body read and a projectVersion literal in a route', async () => {
    // Purpose: fails if the routes block drops either selector, the second by not restating it.
    expect(
      await refusals('src/routes/scratch-example.ts', `${RAW_READ}\n${LITERAL_VERSION}`)
    ).toEqual([
      expect.stringContaining('readJsonBody(c)'),
      expect.stringContaining('SERVER_VERSION'),
    ]);
  });

  it('refuses a projectVersion literal in a service, and lets it read the raw body', async () => {
    // Purpose: fails if the literal ban stops at routes, or the body ban reaches past them.
    const messages = await refusals(
      'src/services/core/scratch-example.ts',
      `${RAW_READ}\n${LITERAL_VERSION}\nexport const live = { projectVersion: SERVER_VERSION };`
    );
    expect(messages).toEqual([expect.stringContaining('SERVER_VERSION')]);
  });

  it.each([
    ['the server', SERVER, 'src/routes/__tests__/scratch-example.test.ts'],
    ['a package', RELAY, 'src/__tests__/scratch-example.test.ts'],
  ])(
    'refuses a Date.now() bound in a test in %s, and nothing else there',
    async (_w, root, path) => {
      // Purpose: fails if the shared test preset loses a direction, or the source bans reach tests.
      const code = `${DATE_NOW_BOUNDS}\nexpect(Date.now() - at).toBeLessThan(1000);\n${RAW_READ}\n${LITERAL_VERSION}`;
      expect(await refusals(path, code, root)).toEqual([
        expect.stringContaining('.claude/rules/testing.md'),
        expect.stringContaining('.claude/rules/testing.md'),
      ]);
    }
  );
});

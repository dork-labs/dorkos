/**
 * The space server's lint boundary (server-merge step 7, `eslint-rules/space-boundary.js`):
 * its code imports only itself and the packages its image installs, and the rest of the server
 * never imports it. Linted with the package's real config, so a rule left unwired fails here.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** The boundary rules' messages for `code` linted as if it were the file at `path`. */
async function boundary(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result.messages
    .filter((message) => message.ruleId?.startsWith('spaces/'))
    .map((message) => `${message.ruleId}: ${message.message}`);
}

describe('the space server boundary', () => {
  it("keeps the space server's code inside itself and its image's packages", async () => {
    // Purpose: fails if space code can import another server folder or a package the space
    // image does not install, such as the machine store.
    const found = await boundary(
      'src/services/spaces/example.ts',
      [
        "import { a } from './config.js';",
        "import { b } from '../rooms/room-service.js';",
        "import Database from 'better-sqlite3';",
        "import { Pool } from 'pg';",
        "import { createHash } from 'node:crypto';",
        "import type { C } from '../../lib/logger.js';",
        "export { d } from '../../lib/version.js';",
        'export const e = [a, b, Database, Pool, createHash];',
        'export type { C };',
      ].join('\n')
    );
    expect(found).toEqual([
      expect.stringMatching(/^spaces\/stay-inside: '\.\.\/rooms\/room-service\.js' is outside/u),
      expect.stringMatching(/^spaces\/stay-inside: 'better-sqlite3' is not a package/u),
      expect.stringMatching(/^spaces\/stay-inside: '\.\.\/\.\.\/lib\/version\.js' is outside/u),
    ]);
  });

  it("keeps the rest of the server out of the space server's code", async () => {
    // Purpose: fails if a server file outside spaces can import space code, which would put it
    // in the DorkOS server's own program.
    const found = await boundary(
      'src/services/communities/example.ts',
      [
        "import { a } from '../spaces/config.js';",
        "import type { B } from '../spaces/app.js';",
        'export const c = a;',
        'export type { B };',
      ].join('\n')
    );
    expect(found).toEqual([
      expect.stringMatching(/^spaces\/no-reach-in: '\.\.\/spaces\/config\.js' is the space server/u),
    ]);
  });
});

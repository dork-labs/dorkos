/**
 * The work graph's lint boundary (`eslint-rules/work-graph-boundary.js`, ADR 261124-131941):
 * runtime and session code never imports `services/work-graph`, by any import form. Linted
 * with the package's real config, so a rule left unwired fails here.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** The boundary rule's messages for `code` linted as if it were the file at `path`. */
async function boundary(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result.messages
    .filter((message) => message.ruleId === 'work-graph/stay-out')
    .map((message) => message.message);
}

const EVERY_FORM = [
  "import '../../work-graph/index.js';",
  "import { recordChatRekey } from '../../work-graph/index.js';",
  "import type { WorkLink } from '../../work-graph/work-link-store.js';",
  "export { recordChatFork } from '../../work-graph';",
  "export const later = () => import('../../work-graph/index.js');",
  "export type Inline = import('../../work-graph/work-link-store.js').WorkLink;",
  "import required = require('../../work-graph/index.js');",
  'export type { WorkLink };',
  'void recordChatRekey;',
  'void required;',
].join('\n');

describe('the work graph boundary', () => {
  it('refuses every import form from session code, its tests included', async () => {
    // Purpose: fails if turn code could reach the work graph by a side-effect, named,
    // type-only, re-export, dynamic, inline type or `import = require` import.
    for (const path of [
      'src/services/session/turn-identity/example.ts',
      'src/services/session/__tests__/example.test.ts',
    ])
      expect(await boundary(path, EVERY_FORM)).toHaveLength(7);
  });

  it('refuses it from runtime code', async () => {
    expect(
      await boundary(
        'src/services/runtimes/claude-code/example.ts',
        "import '../../work-graph/index.js';"
      )
    ).toEqual([expect.stringMatching(/^'\.\.\/\.\.\/work-graph\/index\.js' is the work graph/u)]);
  });

  it('leaves the space side alone', async () => {
    // Purpose: fails if the rule reaches past turn code; routes and startup wire the graph.
    expect(
      await boundary('src/routes/example.ts', "import '../services/work-graph/index.js';")
    ).toEqual([]);
    expect(
      await boundary(
        'src/services/session/turn-identity/example.ts',
        "import '../../work-graphs-elsewhere/index.js';"
      )
    ).toEqual([]);
  });
});

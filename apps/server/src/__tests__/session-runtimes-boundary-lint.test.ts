/**
 * The session domain's lint boundary (`eslint-rules/session-runtimes-boundary.js`, DOR-4928):
 * session code never imports `services/runtimes`, by any import form; its tests may. Linted with
 * the package's real config, so a rule left unwired fails here.
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
    .filter((message) => message.ruleId === 'session-runtimes/no-runtimes')
    .map((message) => message.message);
}

const EVERY_FORM = [
  "import '../../runtimes/shared/derive-title.js';",
  "import { projectSlug } from '../../runtimes/claude-code/sessions/project-slug.js';",
  "import type { AgentSession } from '../../runtimes/claude-code/agent-types.js';",
  "export { deriveTitle } from '../../runtimes/shared/derive-title.js';",
  "export const later = () => import('../../runtimes/codex/index.js');",
  "export type Inline = import('../../runtimes/claude-code/agent-types.js').AgentSession;",
  "import required = require('../../runtimes/shared/derive-title.js');",
  'export type { AgentSession };',
  'void projectSlug;',
  'void required;',
].join('\n');

describe('the session to runtimes boundary', () => {
  it('refuses every import form from session code', async () => {
    // Purpose: fails if session code could reach a runtime by a side-effect, named,
    // type-only, re-export, dynamic, inline type or `import = require` import.
    expect(await boundary('src/services/session/launch/example.ts', EVERY_FORM)).toHaveLength(7);
    expect(
      await boundary('src/services/session/example.ts', "import '../runtimes/index.js';")
    ).toEqual([expect.stringMatching(/^'\.\.\/runtimes\/index\.js' is runtime code/u)]);
  });

  it('leaves session tests, the runtimes and the rest of the server alone', async () => {
    // Purpose: fails if the rule reaches past session source; tests wire real runtimes.
    for (const path of [
      'src/services/session/__tests__/example.test.ts',
      'src/services/session/launch/__tests__/example.test.ts',
    ])
      expect(await boundary(path, "import '../../../runtimes/shared/derive-title.js';")).toEqual(
        []
      );
    expect(
      await boundary(
        'src/services/runtimes/claude-code/example.ts',
        "import '../../session/index.js';"
      )
    ).toEqual([]);
    expect(
      await boundary('src/startup/example.ts', "import '../services/runtimes/index.js';")
    ).toEqual([]);
    expect(
      await boundary(
        'src/services/session/launch/example.ts',
        "import '../../runtimes-elsewhere/index.js';"
      )
    ).toEqual([]);
  });
});

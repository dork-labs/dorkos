// @vitest-environment node
/**
 * The app and the space's own website never import each other (server-merge step 7e,
 * `eslint-rules/space.js`). Linted with the package's real config, so a rule left unwired fails.
 */
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const CLIENT = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: CLIENT });

/** The boundary rule's messages for `code` linted as if it were the file at `path`. */
async function boundary(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${CLIENT}${path}` });
  return result.messages
    .filter((message) => message.ruleId === 'space/separate-sites')
    .map((message) => message.message);
}

describe('the space website boundary', () => {
  it("keeps the space's website out of the app's code", async () => {
    // Purpose: fails if a space file can reach the app by alias or by a relative path.
    const found = await boundary(
      'src/space/components/Example.tsx',
      [
        "import { a } from '../api.js';",
        "import { b } from '@/layers/shared/lib/utils';",
        "import { c } from '../../main';",
        "import { d } from '@dorkos/shared/space-page';",
        'export const e = [a, b, c, d];',
      ].join('\n')
    );
    expect(found).toEqual([
      expect.stringMatching(/^'@\/layers\/shared\/lib\/utils' is the app's code/u),
      expect.stringMatching(/^'\.\.\/\.\.\/main' is the app's code/u),
    ]);
  });

  it("keeps the app out of the space's website", async () => {
    // Purpose: fails if app code can import the space's website, which would put it in the app.
    const found = await boundary(
      'src/layers/features/example/model/example.ts',
      [
        "import { a } from '../../../../space/api.js';",
        "import { b } from '@/space/owner-claim';",
        "import { c } from '../lib/workspace-name';",
        'export const d = [a, b, c];',
      ].join('\n')
    );
    expect(found).toEqual([
      expect.stringMatching(
        /^'\.\.\/\.\.\/\.\.\/\.\.\/space\/api\.js' is the space's own website/u
      ),
      expect.stringMatching(/^'@\/space\/owner-claim' is the space's own website/u),
    ]);
  });
});

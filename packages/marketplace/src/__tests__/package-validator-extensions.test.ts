/**
 * `dorkos marketplace validate` judges a package's bundled extensions with the
 * same checks DorkOS discovery runs (DOR-2685): the extension manifest schema,
 * and the tool check that decides which declared tools agents get.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePackage } from '../package-validator.js';

const VALID_PLUGIN = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'valid-plugin'
);

/** A tool declaration that passes, to bend one field of. */
function tool(overrides: Record<string, unknown> = {}) {
  return {
    name: 'list_inbox',
    title: 'List the inbox',
    description: 'Lists the newest messages.',
    tier: 'observe',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer' } },
      additionalProperties: false,
    },
    ...overrides,
  };
}

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

/** Copy the valid plugin fixture and add one extension with this manifest. */
async function pluginWithExtension(manifest: unknown): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dor-2685-validate-'));
  temps.push(root);
  const dir = path.join(root, 'valid-plugin');
  await fs.cp(VALID_PLUGIN, dir, { recursive: true });
  const extDir = path.join(dir, '.dork', 'extensions', 'mail-app');
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(path.join(extDir, 'extension.json'), JSON.stringify(manifest));
  return dir;
}

/** A manifest declaring the given tools. */
function extension(tools: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'mail-app',
    name: 'Mail',
    version: '1.0.0',
    serverCapabilities: { serverEntry: './server.ts' },
    tools,
    ...extra,
  };
}

describe('validatePackage: bundled extensions', () => {
  it('passes an extension whose tools discovery would accept', async () => {
    // Purpose: the happy path stays green, so the checks below are not noise.
    const result = await validatePackage(await pluginWithExtension(extension([tool()])));
    expect(result.issues.filter((i) => i.code.startsWith('EXTENSION_'))).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('refuses a tool whose input is an open-ended map, as discovery would', async () => {
    // Purpose: the listability check runs here too, so an author learns
    // before publishing that agents would never get this tool.
    const result = await validatePackage(
      await pluginWithExtension(
        extension([
          tool(),
          tool({
            name: 'dump_headers',
            inputSchema: { type: 'object', additionalProperties: { type: 'string' } },
          }),
        ])
      )
    );
    expect(result.ok).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'EXTENSION_TOOL_REFUSED',
        path: '.dork/extensions/mail-app/extension.json',
        message: expect.stringMatching(/"dump_headers".*open-ended map/),
      })
    );
    expect(
      result.issues.filter((i) => i.code === 'EXTENSION_TOOL_REFUSED').map((i) => i.message)
    ).toHaveLength(1);
  });

  it('refuses a tool the registry would refuse, such as a quoted title', async () => {
    // Purpose: the registry's own rules (one-line titles, no quotes) are part
    // of the shared check, not only the schema subset.
    const result = await validatePackage(
      await pluginWithExtension(extension([tool({ title: 'List "everything"' })]))
    );
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'EXTENSION_TOOL_REFUSED',
        message: expect.stringMatching(/no quotes/),
      })
    );
  });

  it('reports a manifest the extension schema rejects', async () => {
    // Purpose: a manifest DorkOS would not load at all fails validation.
    const { serverCapabilities: _none, ...clientOnly } = extension([tool()]);
    const result = await validatePackage(await pluginWithExtension(clientOnly));
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: 'EXTENSION_MANIFEST_INVALID',
        message: expect.stringMatching(/Tools need a server entry/),
      })
    );
  });
});

/**
 * `hono` is built in for every extension's server half (DOR-2857), against
 * the REAL filesystem and REAL esbuild: it builds from a folder with nothing
 * installed, carries DorkOS's own copy inline, offers only what hono exports,
 * passes a plugin's containment, and is cached like any other build.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { ExtensionRecord } from '@dorkos/extension-api';

vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../lib/logger.js';
import { ExtensionCompiler } from '../extension-compiler.js';
import { hostHono } from '../server-bundle/host-hono.js';

let tmp: string;
let compiler: ExtensionCompiler;

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

/** A server-entry record for an extension in `dir`. */
function record(dir: string, overrides: Partial<ExtensionRecord> = {}): ExtensionRecord {
  return {
    id: 'hono-ext',
    manifest: { id: 'hono-ext', name: 'Hono Ext', version: '1.0.0' },
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    path: dir,
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
    serverEntryPath: path.join(dir, 'server.ts'),
    ...overrides,
  };
}

/** Compile and return the code, failing the test on an error. */
async function compiled(rec: ExtensionRecord): Promise<string> {
  const result = await compiler.compileServer(rec);
  if ('error' in result) throw new Error(JSON.stringify(result.error));
  return result.code;
}

/** Evaluate a CommonJS bundle that needs nothing from the host. */
function evaluate(code: string): Record<string, unknown> {
  const mod: { exports: Record<string, unknown> } = { exports: {} };
  new Function('exports', 'require', 'module', code)(mod.exports, () => ({}), mod);
  return mod.exports;
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-hono-')));
  compiler = new ExtensionCompiler(path.join(tmp, 'dork'));
  vi.mocked(logger.debug).mockClear();
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('hono, built in', () => {
  it('builds the docs’ example from a folder with no node_modules, and it serves', async () => {
    const dir = path.join(tmp, 'extensions', 'hono-ext');
    await write(
      path.join(dir, 'server.ts'),
      [
        "import { Hono } from 'hono';",
        "import { HTTPException } from 'hono/http-exception';",
        'const app = new Hono();',
        "app.get('/items', (c) => c.json({ items: [1, 2] }));",
        "app.get('/teapot', () => { throw new HTTPException(418, { message: 'short and stout' }); });",
        'export default app;',
      ].join('\n')
    );

    const code = await compiled(record(dir));
    expect(code).not.toMatch(/require\(["']hono/);

    const app = (evaluate(code).default ?? evaluate(code)) as {
      fetch: (r: Request) => Promise<Response>;
    };
    const items = await app.fetch(new Request('http://x/items'));
    expect(await items.json()).toEqual({ items: [1, 2] });
    expect((await app.fetch(new Request('http://x/teapot'))).status).toBe(418);
  });

  it('uses DorkOS’s own hono even when the extension ships another', async () => {
    const dir = path.join(tmp, 'extensions', 'hono-ext');
    await write(
      path.join(dir, 'node_modules', 'hono', 'package.json'),
      '{"name":"hono","version":"0.0.1","main":"index.js"}'
    );
    await write(path.join(dir, 'node_modules', 'hono', 'index.js'), 'exports.Hono = "fake";\n');
    await write(
      path.join(dir, 'server.ts'),
      "import { Hono } from 'hono';\nexport const kind = typeof Hono;\n"
    );

    expect(evaluate(await compiled(record(dir))).kind).toBe('function');
  });

  it('offers only what hono exports', async () => {
    const dir = path.join(tmp, 'extensions', 'hono-ext');
    await write(
      path.join(dir, 'server.ts'),
      "import x from 'hono/../../package.json';\nexport default x;\n"
    );

    const result = await compiler.compileServer(record(dir));
    expect('error' in result && JSON.stringify(result.error)).toContain(
      `is not something hono ${hostHono()!.version} offers`
    );
  });

  it('passes a plugin’s containment, which still refuses everything else from outside', async () => {
    const project = path.join(tmp, 'repo');
    const pluginRoot = path.join(project, '.dork', 'plugins', 'flow');
    const dir = path.join(pluginRoot, '.dork', 'extensions', 'flow');
    await write(path.join(project, 'node_modules', 'leftpad', 'index.js'), 'exports.pad = 1;\n');
    await write(
      path.join(dir, 'server.ts'),
      "import { Hono } from 'hono';\nexport default new Hono();\n"
    );
    const contained = record(dir, { id: 'flow', sourcePlugin: 'flow', scope: 'local' });

    expect(await compiled(contained)).toContain('class Hono');

    await write(
      path.join(dir, 'server.ts'),
      "import { Hono } from 'hono';\nimport { pad } from 'leftpad';\nexport default [Hono, pad];\n"
    );
    const refused = await compiler.compileServer(contained);
    expect('error' in refused && JSON.stringify(refused.error)).toContain(
      "outside this plugin's folder"
    );
  });

  it('is cached like any other build, so a second load does not rebuild', async () => {
    const dir = path.join(tmp, 'extensions', 'hono-ext');
    await write(
      path.join(dir, 'server.ts'),
      "import { Hono } from 'hono';\nexport default new Hono();\n"
    );

    const first = await compiler.compileServer(record(dir));
    const second = await compiler.compileServer(record(dir));

    expect(second).toEqual(first);
    expect(vi.mocked(logger.debug).mock.calls.flat().join('\n')).toContain(
      'Cache hit for hono-ext'
    );
  });
});

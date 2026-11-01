/**
 * The install-time compile holds a staged extension to the same folder the
 * compiler holds it to once installed (DOR-3537), against the REAL filesystem
 * and REAL esbuild:
 *
 * - a plugin's extension may import its own plugin's files, as it can after
 *   install, and nothing outside the staged plugin folder, links followed;
 * - an extension from a package that is not a plugin stays held to its own
 *   folder;
 * - a refusal says which import failed and which folder applied, all the way
 *   up to the error the install reports.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import type { Logger } from '@dorkos/shared/logger';
import { ExtensionCompiler } from '../../../extensions/extension-compiler.js';
import {
  buildCompilerRecord,
  compileStagedExtensions,
  describeCompileError,
  discoverStagedExtensions,
} from '../staged-extensions.js';

let tmp: string;
let stage: string;
let extDir: string;
let compiler: ExtensionCompiler;
const logger: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

async function write(file: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

/** Compile the staged package as the plugin flow does, and return what it threw. */
async function install(plugin?: string): Promise<Error | null> {
  return compileStagedExtensions(stage, compiler, logger, '[install-plugin]', plugin).then(
    () => null,
    (err: Error) => err
  );
}

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'staged-ext-')));
  // Named as the install engine names a project plugin's stage.
  stage = path.join(tmp, 'repo', '.dork', 'plugins', 'flow.dorkos-stage-abc123');
  extDir = path.join(stage, '.dork', 'extensions', 'flow');
  await write(path.join(extDir, 'extension.json'), '{"id":"flow","name":"Flow","version":"1.0.0"}');
  await write(path.join(stage, 'scripts', 'dial.ts'), 'export const dial = 1;\n');
  compiler = new ExtensionCompiler(path.join(tmp, 'dork'));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('a staged plugin install', () => {
  it("compiles an extension that imports its own plugin's scripts", async () => {
    await write(path.join(extDir, 'index.ts'), "export { dial } from './lib/dial';\n");
    await write(
      path.join(extDir, 'lib', 'dial.ts'),
      "export { dial } from '../../../../scripts/dial';\n"
    );
    expect(await install('flow')).toBeNull();
  });

  it('holds the record to the staged plugin folder and nothing wider', async () => {
    const [ext] = await discoverStagedExtensions(stage);
    const record = buildCompilerRecord(ext!, 'flow');
    expect(record.sourcePlugin).toBe('flow');
    expect(buildCompilerRecord(ext!).sourcePlugin).toBeUndefined();
  });

  it('refuses an import outside the staged plugin folder, and says why', async () => {
    await write(path.join(tmp, 'repo', 'secret.ts'), 'export const secret = 1;\n');
    await write(
      path.join(extDir, 'index.ts'),
      "export { secret } from '../../../../../../secret';\n"
    );
    const err = await install('flow');
    expect(err?.message).toMatch(
      /^Extension 'flow' failed to compile: '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/secret' resolves to /
    );
    expect(err?.message).toContain(`outside this plugin's folder (${stage})`);
    expect(err?.message).toContain('index.ts:1:');
  });

  it('refuses an import that leaves the plugin folder through a link', async () => {
    await write(path.join(tmp, 'outside', 'secret.ts'), 'export const secret = 1;\n');
    await fs.symlink(path.join(tmp, 'outside'), path.join(stage, 'scripts', 'linked'));
    await write(
      path.join(extDir, 'index.ts'),
      "export { secret } from '../../../scripts/linked/secret';\n"
    );
    const err = await install('flow');
    expect(err?.message).toContain(path.join(tmp, 'outside', 'secret.ts'));
    expect(err?.message).toContain("outside this plugin's folder");
  });
});

describe('a staged package that is not a plugin', () => {
  it('holds each extension to its own folder, and names that folder', async () => {
    await write(path.join(extDir, 'index.ts'), "export { dial } from '../../../scripts/dial';\n");
    const err = await install();
    expect(err?.message).toContain(`outside this extension's folder (${extDir})`);
  });
});

describe('describeCompileError', () => {
  it('keeps the summary alone when the bundler gave no reason', () => {
    expect(describeCompileError({ code: 'compilation_failed', message: 'No entry point' })).toBe(
      'No entry point'
    );
  });

  it('adds the first reason, where it was raised, and how many more there are', () => {
    expect(
      describeCompileError({
        code: 'compilation_failed',
        message: 'Compilation failed for flow',
        errors: [
          { text: 'first', location: { file: 'index.ts', line: 2, column: 7 } },
          { text: 'second' },
        ],
      })
    ).toBe('first (index.ts:2:7) (and 1 more)');
  });
});

/**
 * Census (DOR-3293, Security item 1): no app code runs in the DorkOS page.
 *
 * An app bundle is fetched as text and handed to its sandboxed frame. Any
 * dynamic `import()` of a bundle address, or of a computed address that could
 * be one, would run that code with the person's sign-in, so this fails on one
 * anywhere in the client's source.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Every source file under `apps/client/src`, tests left out. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

/** `import(` with anything but a plain string literal: a computed address. */
const COMPUTED_IMPORT = /\bimport\s*\(\s*(?!['"][^'"]+['"]\s*\))/;

describe('no app bundle is imported into the DorkOS page', () => {
  const files = sourceFiles(SRC);

  it('finds the client source to check', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('has no import() of an extension bundle address', () => {
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf-8');
      return /import\s*\([^)]*(\/bundle|extensionApiUrl|\/api\/extensions)/.test(text);
    });
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it('has no computed import() anywhere in the page code', () => {
    const offenders = files.filter((file) => {
      return readFileSync(file, 'utf-8')
        .split('\n')
        .some((line) => COMPUTED_IMPORT.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line));
    });
    expect(offenders.map((file) => path.relative(SRC, file))).toEqual([]);
  });

  it('never evaluates text in the frame code: only nonce-carrying script elements run it', () => {
    const frameFiles = files.filter((file) =>
      file.includes(`${path.sep}extensions${path.sep}frame${path.sep}`)
    );
    expect(frameFiles.length).toBeGreaterThan(2);
    const offenders = frameFiles.filter((file) =>
      /\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/.test(readFileSync(file, 'utf-8'))
    );
    expect(offenders).toEqual([]);
    const runtime = readFileSync(
      frameFiles.find((file) => file.endsWith('runtime.tsx'))!,
      'utf-8'
    );
    expect(runtime).toContain('script.nonce =');
  });
});

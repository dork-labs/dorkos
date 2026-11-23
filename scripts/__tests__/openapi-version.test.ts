import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readProductVersion } from '../lib/openapi-version.js';

describe('readProductVersion', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'openapi-version-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Write a VERSION file holding `text` and return its path. */
  function versionFile(text: string): string {
    const file = path.join(dir, 'VERSION');
    writeFileSync(file, text);
    return file;
  }

  it('returns the trimmed version', () => {
    expect(readProductVersion(versionFile('1.42.0\n'))).toBe('1.42.0');
    expect(readProductVersion(versionFile('2.0.0-rc.1'))).toBe('2.0.0-rc.1');
  });

  it('refuses a missing file rather than falling back to 0.0.0', () => {
    expect(() => readProductVersion(path.join(dir, 'VERSION'))).toThrow(/Cannot read/);
  });

  it('refuses contents that are not a version', () => {
    expect(() => readProductVersion(versionFile(''))).toThrow(/not a version/);
    expect(() => readProductVersion(versionFile('v1.2.3'))).toThrow(/not a version/);
    expect(() => readProductVersion(versionFile('1.2'))).toThrow(/not a version/);
  });

  it('is the version the committed API document carries', () => {
    // A release bumps VERSION and must regenerate the document in the same PR.
    const spec = JSON.parse(readFileSync('docs/api/openapi.json', 'utf8')) as {
      info: { version: string };
    };
    expect(spec.info.version).toBe(readProductVersion('VERSION'));
  });
});

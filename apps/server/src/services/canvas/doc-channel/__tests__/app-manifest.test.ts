import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDocAppManifest } from '../app-manifest.js';
const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-app-manifest-'));
  directories.push(dir);
  fs.mkdirSync(path.join(dir, '.dork'));
  return dir;
}
function write(dir: string, data: unknown): void {
  fs.writeFileSync(path.join(dir, '.dork/app.json'), JSON.stringify(data));
}
const manifest = { v: 1, types: { 'app.changed': { type: 'boolean' } } };
describe('server-confined app manifests', () => {
  it('does not fetch remote sources or search outside the supplied local root', () => {
    expect(readDocAppManifest(null)).toBeUndefined();
    expect(readDocAppManifest(root())).toBeUndefined();
    expect(() => readDocAppManifest('https://example.invalid')).toThrow();
    expect(() => readDocAppManifest('.')).toThrow();
  });
  it('refuses file and directory symlink escapes, while allowing a confined symlink', () => {
    const dir = root();
    const outside = root();
    write(outside, manifest);
    fs.symlinkSync(path.join(outside, '.dork/app.json'), path.join(dir, '.dork/app.json'));
    expect(() => readDocAppManifest(dir)).toThrow(/leaves/);
    fs.unlinkSync(path.join(dir, '.dork/app.json'));
    fs.rmSync(path.join(dir, '.dork'), { recursive: true });
    fs.symlinkSync(path.join(outside, '.dork'), path.join(dir, '.dork'));
    expect(() => readDocAppManifest(dir)).toThrow(/leaves/);
    const inside = root();
    fs.writeFileSync(path.join(inside, 'manifest.json'), JSON.stringify(manifest));
    fs.symlinkSync(path.join(inside, 'manifest.json'), path.join(inside, '.dork/app.json'));
    expect(readDocAppManifest(inside)?.compiled.validate('app.changed', true)).toBe('valid');
  });
  it('rejects oversized bytes, invalid UTF-8 and nonregular files before compilation', () => {
    const dir = root();
    const file = path.join(dir, '.dork/app.json');
    fs.writeFileSync(file, Buffer.alloc(65537));
    expect(() => readDocAppManifest(dir)).toThrow(/bounded/);
    fs.writeFileSync(file, Buffer.from([0xff]));
    expect(() => readDocAppManifest(dir)).toThrow(/UTF-8/);
    fs.unlinkSync(file);
    fs.mkdirSync(file);
    expect(() => readDocAppManifest(dir)).toThrow(/regular/);
  });
});

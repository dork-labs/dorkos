import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PACKAGE_TEXT_MAX_BYTES } from '@dorkos/shared/bounded-read';
import { readDeclarationJson, readPackageText } from '../package-declarations.js';

let pkg: string;

beforeEach(async () => {
  pkg = await mkdtemp(path.join(tmpdir(), 'dorkos-declarations-'));
  await mkdir(path.join(pkg, 'hooks'), { recursive: true });
});

afterEach(async () => {
  await rm(pkg, { recursive: true, force: true });
});

describe('readPackageText size limit (DOR-2319)', () => {
  // Purpose: a declaration larger than DorkOS reads is reported unreadable,
  // the answer that keeps an install from being approved, and is never loaded.
  it('reports a file larger than the limit as unreadable', async () => {
    await writeFile(path.join(pkg, 'hooks', 'hooks.json'), ' '.repeat(PACKAGE_TEXT_MAX_BYTES + 1));
    expect(await readPackageText(pkg, 'hooks/hooks.json')).toEqual({ kind: 'unreadable' });
    expect(await readDeclarationJson(pkg, 'hooks/hooks.json')).toEqual({ kind: 'unreadable' });
  });

  // Purpose: a file at the limit still reads.
  it('reads a file at the limit', async () => {
    await writeFile(path.join(pkg, 'hooks', 'hooks.json'), ' '.repeat(PACKAGE_TEXT_MAX_BYTES));
    expect((await readPackageText(pkg, 'hooks/hooks.json')).kind).toBe('ok');
  });
});

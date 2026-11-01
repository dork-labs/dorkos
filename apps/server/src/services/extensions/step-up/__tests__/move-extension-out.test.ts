/**
 * "Move out of {agent}'s folder" (DOR-3234, Must 3): copy, verify, remove.
 * A folder holding a link is refused, a name already taken is refused, and a
 * failed move leaves the original where it was. Real folders throughout.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MoveExtensionError, moveExtensionOut } from '../move-extension-out.js';

let root: string;
let source: string;
let dorkHome: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'move-ext-')));
  source = path.join(root, 'agent', '.dork', 'extensions', 'social-queue');
  dorkHome = path.join(root, 'dork');
  fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'extension.json'), '{"id":"social-queue"}');
  fs.writeFileSync(path.join(source, 'src', 'index.ts'), 'export {}');
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('moveExtensionOut', () => {
  it('moves every file into DorkOS’s own folder, then removes the original', async () => {
    const target = await moveExtensionOut(source, 'social-queue', dorkHome);
    expect(target).toBe(path.join(dorkHome, 'extensions', 'social-queue'));
    expect(fs.readFileSync(path.join(target, 'extension.json'), 'utf8')).toBe(
      '{"id":"social-queue"}'
    );
    expect(fs.readFileSync(path.join(target, 'src', 'index.ts'), 'utf8')).toBe('export {}');
    expect(fs.existsSync(source)).toBe(false);
    // No staging folder is left behind.
    expect(fs.readdirSync(path.join(dorkHome, 'extensions'))).toEqual(['social-queue']);
  });

  it('refuses a folder holding a link, and moves nothing', async () => {
    fs.symlinkSync('/etc/hosts', path.join(source, 'src', 'link'));
    await expect(moveExtensionOut(source, 'social-queue', dorkHome)).rejects.toMatchObject({
      code: 'has-link',
    });
    expect(fs.existsSync(path.join(source, 'extension.json'))).toBe(true);
    expect(fs.existsSync(path.join(dorkHome, 'extensions', 'social-queue'))).toBe(false);
  });

  it('refuses when the folder itself is a link', async () => {
    const link = path.join(root, 'link-to-it');
    fs.symlinkSync(source, link);
    await expect(moveExtensionOut(link, 'social-queue', dorkHome)).rejects.toBeInstanceOf(
      MoveExtensionError
    );
    expect(fs.existsSync(source)).toBe(true);
  });

  it('refuses a name already in DorkOS’s folder, and leaves both alone', async () => {
    fs.mkdirSync(path.join(dorkHome, 'extensions', 'social-queue'), { recursive: true });
    await expect(moveExtensionOut(source, 'social-queue', dorkHome)).rejects.toMatchObject({
      code: 'exists',
    });
    expect(fs.existsSync(path.join(source, 'extension.json'))).toBe(true);
  });
});

/**
 * Undo on the server sheet removes one standing yes and nothing else
 * (DOR-4118, Security's conditions of Nov 12).
 *
 * Real agent folders in a temp tree, made-up agents and servers.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeStandingAllow, StandingAllowUndoError } from '../global-mcp-allow-undo.js';

let root: string;
let home: string;
let file: string;

const SETTINGS = {
  permissions: {
    allow: ['mcp__tracker', 'mcp__tracker__create_issue', 'Bash(npm test)'],
    deny: ['Bash(rm -rf:*)'],
  },
  env: { MADE_UP: '1' },
};

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4118-undo-')));
  home = path.join(root, 'quill');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  file = path.join(home, '.claude', 'settings.local.json');
  fs.writeFileSync(file, JSON.stringify(SETTINGS, null, 2) + '\n', { mode: 0o640 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('removing one standing yes (DOR-4118)', () => {
  it('removes exactly that rule and leaves every other line as it was', async () => {
    const before = fs.readFileSync(file, 'utf8');
    expect(await removeStandingAllow(home, 'mcp__tracker')).toBe('removed');

    const after = fs.readFileSync(file, 'utf8');
    expect(JSON.parse(after)).toEqual({
      ...SETTINGS,
      permissions: { ...SETTINGS.permissions, allow: SETTINGS.permissions.allow.slice(1) },
    });
    // The only line that changed is the removed one.
    expect(before.split('\n').filter((line) => line !== '      "mcp__tracker",')).toEqual(
      after.split('\n')
    );
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
    expect(fs.readdirSync(path.join(home, '.claude'))).toEqual(['settings.local.json']);
  });

  it('removes a one-tool rule too', async () => {
    expect(await removeStandingAllow(home, 'mcp__tracker__create_issue')).toBe('removed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toEqual([
      'mcp__tracker',
      'Bash(npm test)',
    ]);
  });

  it('removes mcp__{server}__*, the other whole-server shape (DOR-4240)', async () => {
    const allow = ['mcp__tracker__*', 'mcp__tracker__create_issue'];
    fs.writeFileSync(file, JSON.stringify({ permissions: { allow } }, null, 2) + '\n');
    expect(await removeStandingAllow(home, 'mcp__tracker__*')).toBe('removed');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).permissions.allow).toEqual([
      'mcp__tracker__create_issue',
    ]);
  });

  it('answers not-found, writing nothing, when the rule or the file is not there', async () => {
    const before = fs.readFileSync(file, 'utf8');
    expect(await removeStandingAllow(home, 'mcp__weather')).toBe('not-found');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    fs.rmSync(file);
    expect(await removeStandingAllow(home, 'mcp__tracker')).toBe('not-found');
    expect(fs.existsSync(file)).toBe(false);
  });

  it.each([
    'Bash(npm test)',
    'mcp__tracker*',
    'mcp__*',
    'mcp__tracker__*__x',
    'mcp__tracker__x*',
    'mcp__tracker__create_issue(x)',
    ' mcp__tracker',
    'mcp__tracker\n',
    'mcp__',
  ])('refuses %j before touching the file', async (rule) => {
    const before = fs.readFileSync(file, 'utf8');
    await expect(removeStandingAllow(home, rule)).rejects.toMatchObject({ code: 'bad-rule' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses a settings file that is a symlink, and leaves its target alone', async () => {
    const elsewhere = path.join(root, 'elsewhere.json');
    fs.writeFileSync(elsewhere, JSON.stringify(SETTINGS));
    fs.rmSync(file);
    fs.symlinkSync(elsewhere, file);

    await expect(removeStandingAllow(home, 'mcp__tracker')).rejects.toBeInstanceOf(
      StandingAllowUndoError
    );
    expect(JSON.parse(fs.readFileSync(elsewhere, 'utf8'))).toEqual(SETTINGS);
  });

  it('refuses a .claude folder that is a symlink out of the agent’s home', async () => {
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'settings.local.json'), JSON.stringify(SETTINGS));
    fs.rmSync(path.join(home, '.claude'), { recursive: true });
    fs.symlinkSync(outside, path.join(home, '.claude'));

    await expect(removeStandingAllow(home, 'mcp__tracker')).rejects.toMatchObject({
      code: 'not-a-real-file',
    });
    expect(JSON.parse(fs.readFileSync(path.join(outside, 'settings.local.json'), 'utf8'))).toEqual(
      SETTINGS
    );
  });

  it('refuses a file that does not parse, rather than rewriting it', async () => {
    fs.writeFileSync(file, '{ "permissions": ');
    await expect(removeStandingAllow(home, 'mcp__tracker')).rejects.toMatchObject({
      code: 'unreadable',
    });
    expect(fs.readFileSync(file, 'utf8')).toBe('{ "permissions": ');
  });
});

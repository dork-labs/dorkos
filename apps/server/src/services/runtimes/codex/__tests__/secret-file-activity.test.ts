/**
 * @vitest-environment node
 *
 * DOR-4358: a secret file that appears between two renders of one chat's
 * macOS profile was readable for the rest of that turn, so the next render
 * writes one Activity line naming it (the path, never what it holds). Made-up
 * files only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  forgetSecretFileRenders,
  noteRenderedSecrets,
  setSecretFileActivity,
  type SecretFileActivityEntry,
} from '../policy/secret-file-activity.js';
import { resetBackgroundScans, settleBackgroundScans } from '../policy/expand-deep-globs.js';
import { codexVendoredRg } from '../policy/hidden-folder-scans.js';
import { codexProtectedConfig } from '../policy/protected-profile.js';

let lines: SecretFileActivityEntry[];

beforeEach(() => {
  lines = [];
  forgetSecretFileRenders();
  setSecretFileActivity((entry) => lines.push(entry));
});
afterEach(() => setSecretFileActivity(undefined));

const exact = (byBase: Record<string, string[]>) =>
  new Map(Object.entries(byBase).map(([base, keys]) => [base, new Set(keys)]));

describe('noteRenderedSecrets (DOR-4358)', () => {
  it('only remembers a chat’s first render', () => {
    expect(noteRenderedSecrets('chat', exact({ '/w': ['/w/.env'] }))).toEqual([]);
    expect(lines).toEqual([]);
  });

  it('writes one line with the path when a file appears, and none when nothing does', () => {
    noteRenderedSecrets('chat', exact({ '/w': ['/w/.env'] }));
    noteRenderedSecrets('chat', exact({ '/w': ['/w/.env', '/w/app/.env.local'] }));
    expect(lines).toEqual([
      {
        sessionId: 'chat',
        file: '/w/app/.env.local',
        files: ['/w/app/.env.local'],
        summary:
          "A secret file appeared after the last Codex turn started: /w/app/.env.local. It's protected now.",
      },
    ]);
    noteRenderedSecrets('chat', exact({ '/w': ['/w/.env', '/w/app/.env.local'] }));
    expect(lines).toHaveLength(1);
  });

  it('says nothing for a base that kept its globs at the last render, or for another chat', () => {
    noteRenderedSecrets('chat', exact({ '/w': [] }));
    noteRenderedSecrets('chat', exact({ '/w': [], '/home': ['/home/x/.env'] }));
    noteRenderedSecrets('other', exact({ '/w': ['/w/.env'] }));
    expect(lines).toEqual([]);
  });

  it('says a file once when it sits in two bases, the chat’s folder under the home', () => {
    noteRenderedSecrets('chat', exact({ '/home': [], '/home/w': [] }));
    expect(
      noteRenderedSecrets('chat', exact({ '/home': ['/home/w/.env'], '/home/w': ['/home/w/.env'] }))
    ).toEqual(['/home/w/.env']);
    expect(lines).toHaveLength(1);
  });
});

describe.skipIf(!codexVendoredRg())('a render of the macOS profile (DOR-4358)', () => {
  const realPlatform = process.platform;
  let root: string;
  beforeEach(() => {
    resetBackgroundScans();
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-secret-activity-')));
  });
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    await settleBackgroundScans();
    resetBackgroundScans();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the line for a .env made in the chat’s folder between two renders', () => {
    const project = path.join(root, 'project');
    fs.mkdirSync(project);
    const roots = {
      cwd: project,
      data: path.join(root, 'data'),
      home: path.join(root, 'home'),
      accounts: [],
      agentFolders: [project],
      agentHomes: [],
    };
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const render = () =>
      codexProtectedConfig(project, { roots, writable: [] }, {}, undefined, 'chat-1');
    render();
    render();
    expect(lines).toEqual([]);
    fs.writeFileSync(path.join(project, '.env'), 'made-up');
    render();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sessionId: 'chat-1', files: [`${project}/.env`] });
    expect(JSON.stringify(lines[0])).not.toContain('made-up');
  });
});

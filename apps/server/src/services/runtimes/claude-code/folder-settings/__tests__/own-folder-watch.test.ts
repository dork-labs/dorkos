/**
 * Every change to an agent's open folder setup is one Activity line, found by
 * hashing the files, never from tool events: a plain write to the disk (what a
 * Bash command does) is seen the same way (DOR-3483, Security's second Must).
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setMarkedFullActivity } from '../../../../core/turn-power/full-autonomy.js';
import {
  changedPaths,
  noteOwnFolderChanges,
  resetOwnFolderWatch,
  snapshotOwnFolder,
} from '../own-folder-watch.js';

let home: string;
const emit = vi.fn(async () => {});
const watch = () => ({ home, agentName: 'Media Manager', sessionId: 'chat-1' });

function write(rel: string, body: string): void {
  const file = path.join(home, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

beforeEach(() => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-folder-watch-')));
  write('.claude/settings.json', '{}');
  write('.agents/skills/x/SKILL.md', 'skill');
  resetOwnFolderWatch();
  emit.mockClear();
  setMarkedFullActivity({ emit });
});

afterEach(() => {
  setMarkedFullActivity(undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

describe('noteOwnFolderChanges', () => {
  it('only remembers the first look', async () => {
    await noteOwnFolderChanges(watch(), 'launch');
    expect(emit).not.toHaveBeenCalled();
  });

  it('logs a write no tool reported, at turn end, naming the files', async () => {
    await noteOwnFolderChanges(watch(), 'launch');
    write('.claude/hooks/source-guard.py', 'print(1)');
    write('.claude/settings.json', '{"hooks":{}}');
    await noteOwnFolderChanges(watch(), 'turn-end');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'agent.full_action',
        resourceId: 'files.own-folder',
        actorId: home,
        actorLabel: 'Media Manager',
        resourceLabel:
          'changed its own folder setup: .claude/hooks/source-guard.py, .claude/settings.json',
        metadata: expect.objectContaining({ changedCount: 2, seenAt: 'turn-end' }),
      })
    );
  });

  it('logs a change made between turns at the next launch, then nothing while it holds still', async () => {
    await noteOwnFolderChanges(watch(), 'turn-end');
    write('.mcp.json', '{"mcpServers":{}}');
    await noteOwnFolderChanges(watch(), 'launch');
    await noteOwnFolderChanges(watch(), 'turn-end');
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ resourceLabel: 'changed its own folder setup: .mcp.json' })
    );
  });

  it('logs a removed file, and names at most five', async () => {
    for (let i = 0; i < 6; i += 1) write(`.claude/rules/r${i}.md`, 'x');
    await noteOwnFolderChanges(watch(), 'launch');
    fs.rmSync(path.join(home, '.claude', 'rules'), { recursive: true });
    await noteOwnFolderChanges(watch(), 'turn-end');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ resourceLabel: expect.stringMatching(/ and 1 more$/) })
    );
  });

  it('never throws for a home that is not there', async () => {
    home = path.join(home, 'missing');
    await expect(noteOwnFolderChanges(watch(), 'launch')).resolves.toBeUndefined();
  });
});

describe('snapshotOwnFolder', () => {
  it('hashes a link by where it points, without following it', async () => {
    fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
    fs.symlinkSync('../../.agents/skills/x', path.join(home, '.claude', 'skills', 'x'));
    const before = await snapshotOwnFolder(home);
    expect(before.get(path.join('.claude', 'skills', 'x'))).toBe('link:../../.agents/skills/x:dir');
    write('.agents/skills/x/SKILL.md', 'changed');
    expect(changedPaths(before, await snapshotOwnFolder(home))).toEqual([
      path.join('.agents', 'skills', 'x', 'SKILL.md'),
    ]);
  });

  it('logs a write through a link to a file outside the home (Security M1 on #3319)', async () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'own-folder-shared-')));
    try {
      fs.writeFileSync(path.join(outside, 'safety.md'), 'never pay without a person');
      fs.mkdirSync(path.join(home, '.claude', 'rules'), { recursive: true });
      fs.symlinkSync(
        path.join(outside, 'safety.md'),
        path.join(home, '.claude', 'rules', 'safety.md')
      );
      await noteOwnFolderChanges(watch(), 'launch');
      fs.writeFileSync(path.join(home, '.claude', 'rules', 'safety.md'), 'pay freely');
      await noteOwnFolderChanges(watch(), 'turn-end');
      expect(emit).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceLabel: `changed its own folder setup: ${path.join('.claude', 'rules', 'safety.md')}`,
        })
      );
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('leaves out everything outside the watched parts', async () => {
    write('notes.md', 'x');
    write('.dork/agent.json', '{}');
    expect([...(await snapshotOwnFolder(home)).keys()].sort()).toEqual([
      path.join('.agents', 'skills', 'x', 'SKILL.md'),
      path.join('.claude', 'settings.json'),
    ]);
  });
});

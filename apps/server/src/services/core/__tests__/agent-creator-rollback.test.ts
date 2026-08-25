/**
 * Real-filesystem tests for what {@link createAgentWorkspace} deletes when a
 * scaffold fails partway through (DOR-507).
 *
 * These run against a real temp tree on purpose. The bug being fixed was a
 * recursive delete of a directory the user already had, and only a real
 * filesystem can show whether the user's files are still there afterwards.
 *
 * Only the boundary check, the config store, and the logger are faked. Every
 * write the scaffold makes is a real write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import { writeFileSync } from 'fs';
import os from 'os';
import path from 'path';

const mockConfigGet = vi.fn();
const mockConfigSet = vi.fn();
vi.mock('../config-manager.js', () => ({
  configManager: {
    get: (...args: unknown[]) => mockConfigGet(...args),
    set: (...args: unknown[]) => mockConfigSet(...args),
  },
}));

vi.mock('../../../lib/boundary.js', () => ({
  validateBoundary: vi.fn(),
  validateBoundaryOrDorkHome: vi.fn(),
  expandTilde: (p: string) => p,
  BoundaryError: class BoundaryError extends Error {},
}));

vi.mock('../../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { createAgentWorkspace, AgentCreationError } from '../agent-creator.js';
import { setOnAgentCreated } from '../agent-created-hook.js';

let tmpRoot: string;
let projectDir: string;
let agentsHome: string;

/** Every path in `dir`, relative and sorted, walked recursively. */
async function listTree(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { recursive: true });
  return entries.map(String).sort();
}

/** Whether anything exists at `p`. */
async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Make `configManager.set` fail the way a full disk does. */
function failOnConfigSet(): void {
  mockConfigSet.mockImplementation(() => {
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-agent-rollback-'));
  projectDir = path.join(tmpRoot, 'my-important-project');
  agentsHome = path.join(tmpRoot, 'agents-home');
  await fs.mkdir(projectDir);
  await fs.mkdir(agentsHome);

  // The default agent never exists on disk here, so `maybeSetDefaultAgent`
  // always reaches `configManager.set`: the last step of a creation, and the
  // one these tests fail on to leave a fully scaffolded workspace behind.
  mockConfigGet.mockReturnValue({
    defaultDirectory: agentsHome,
    defaultAgent: 'nobody',
  });
  mockConfigSet.mockImplementation(() => undefined);
});

afterEach(async () => {
  setOnAgentCreated(null);
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('createAgentWorkspace rollback', () => {
  // ── The folder the user already had ──────────────────────────────────────

  it('leaves an existing folder and its contents alone when the scaffold fails', async () => {
    await fs.writeFile(path.join(projectDir, 'important.txt'), 'a year of work', 'utf-8');
    await fs.mkdir(path.join(projectDir, 'src'));
    await fs.writeFile(path.join(projectDir, 'src', 'index.ts'), 'export {};', 'utf-8');
    const before = await listTree(projectDir);

    failOnConfigSet();

    await expect(createAgentWorkspace({ name: 'my-agent', directory: projectDir })).rejects.toThrow(
      AgentCreationError
    );

    // The user's folder and every file in it survived.
    expect(await exists(projectDir)).toBe(true);
    expect(await fs.readFile(path.join(projectDir, 'important.txt'), 'utf-8')).toBe(
      'a year of work'
    );
    expect(await fs.readFile(path.join(projectDir, 'src', 'index.ts'), 'utf-8')).toBe('export {};');

    // The scaffold's own files AND the directories it made are gone again, so
    // the folder is exactly what it was. Anything less makes the message the
    // user reads ("the new files were removed") untrue.
    expect(await listTree(projectDir)).toEqual(before);
  });

  // Red when: `ledger.claimFile` is dropped from the MEMORY.md scaffold. The
  // file then survives a failed creation, and the next agent created at this
  // path inherits a stranger's notes — which, unlike a stray SOUL.md, is
  // content the new agent will read out in rooms as if it were its own.
  //
  // Asserted by name rather than only through the whole-tree comparison above,
  // because the tree assertion is one line and reads as "nothing is left"
  // whatever the reason; this one says which file, and why it matters.
  it('takes the memory file with it when the scaffold fails', async () => {
    failOnConfigSet();

    await expect(createAgentWorkspace({ name: 'my-agent', directory: projectDir })).rejects.toThrow(
      AgentCreationError
    );

    expect(await exists(path.join(projectDir, '.dork', 'MEMORY.md'))).toBe(false);
  });

  it('leaves no empty directories behind after a failed scaffold', async () => {
    failOnConfigSet();

    await expect(createAgentWorkspace({ name: 'my-agent', directory: projectDir })).rejects.toThrow(
      AgentCreationError
    );

    // .agents/, .agents/skills/, the six per-skill folders, .claude/ and
    // .github/ are all created on the way in and must all be pruned.
    expect(await listTree(projectDir)).toEqual([]);
  });

  it('prunes its own directories but keeps one holding a file it did not write', async () => {
    mockConfigSet.mockImplementation(() => {
      // Stand in for another process dropping a file into a folder the
      // scaffold created. That folder, and its parents, have to survive.
      writeFileSync(path.join(projectDir, '.claude', 'settings.json'), '{}', 'utf-8');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    let thrown: AgentCreationError | undefined;
    try {
      await createAgentWorkspace({ name: 'my-agent', directory: projectDir });
    } catch (err) {
      thrown = err as AgentCreationError;
    }

    expect(await fs.readFile(path.join(projectDir, '.claude', 'settings.json'), 'utf-8')).toBe(
      '{}'
    );
    expect(await listTree(projectDir)).toEqual(['.claude', '.claude/settings.json']);
    // And the survivor is named, relative to the folder the message states.
    expect(thrown?.message).toContain('still in it and you can delete them: .claude');
    expect(thrown?.message).not.toContain(`${projectDir}/.claude`);
  });

  it('reports the failure as a scaffold error that names the folder and the reason', async () => {
    failOnConfigSet();

    let thrown: AgentCreationError | undefined;
    try {
      await createAgentWorkspace({ name: 'my-agent', directory: projectDir });
    } catch (err) {
      thrown = err as AgentCreationError;
    }

    expect(thrown).toBeInstanceOf(AgentCreationError);
    expect(thrown?.code).toBe('SCAFFOLD');
    expect(thrown?.statusCode).toBe(500);
    expect(thrown?.message).toContain(projectDir);
    expect(thrown?.message).toContain('Your folder was kept');
    expect(thrown?.message).toContain('ENOSPC');
  });

  it('keeps a file that was already at a path the scaffold also writes', async () => {
    // `scaffoldInstructions` skips AGENTS.md when it is already there, so the
    // rollback must skip it too.
    await fs.writeFile(path.join(projectDir, 'AGENTS.md'), '# my own notes', 'utf-8');

    failOnConfigSet();

    await expect(createAgentWorkspace({ name: 'my-agent', directory: projectDir })).rejects.toThrow(
      AgentCreationError
    );

    expect(await fs.readFile(path.join(projectDir, 'AGENTS.md'), 'utf-8')).toBe('# my own notes');
  });

  it('keeps a symlink that sits at a path the scaffold also writes', async () => {
    const target = path.join(tmpRoot, 'linked-notes.md');
    await fs.writeFile(target, '# linked notes', 'utf-8');
    await fs.symlink(target, path.join(projectDir, 'AGENTS.md'));

    failOnConfigSet();

    await expect(createAgentWorkspace({ name: 'my-agent', directory: projectDir })).rejects.toThrow(
      AgentCreationError
    );

    const stats = await fs.lstat(path.join(projectDir, 'AGENTS.md'));
    expect(stats.isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('# linked notes');
  });

  it('keeps a .dork folder that picked up a file the scaffold did not write', async () => {
    mockConfigSet.mockImplementation(() => {
      // Stand in for another process writing into .dork/ mid-creation.
      // `configManager.set` is synchronous, so this write has to be too.
      writeFileSync(path.join(projectDir, '.dork', 'other.json'), '{}', 'utf-8');
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    });

    let thrown: AgentCreationError | undefined;
    try {
      await createAgentWorkspace({ name: 'my-agent', directory: projectDir });
    } catch (err) {
      thrown = err as AgentCreationError;
    }

    expect(await fs.readFile(path.join(projectDir, '.dork', 'other.json'), 'utf-8')).toBe('{}');
    // The scaffold's own files inside .dork/ still went away.
    expect(await listTree(path.join(projectDir, '.dork'))).toEqual(['other.json']);
    expect(thrown?.message).toContain('still in it');
  });

  // ── The folder this run created ──────────────────────────────────────────

  it('removes a folder it created itself when the scaffold fails', async () => {
    const newDir = path.join(tmpRoot, 'brand-new-agent');
    failOnConfigSet();

    await expect(
      createAgentWorkspace({ name: 'brand-new-agent', directory: newDir })
    ).rejects.toThrow(AgentCreationError);

    expect(await exists(newDir)).toBe(false);
  });

  it('says the new folder was removed', async () => {
    const newDir = path.join(tmpRoot, 'brand-new-agent');
    failOnConfigSet();

    let thrown: AgentCreationError | undefined;
    try {
      await createAgentWorkspace({ name: 'brand-new-agent', directory: newDir });
    } catch (err) {
      thrown = err as AgentCreationError;
    }

    expect(thrown?.message).toContain('The new folder was removed.');
  });

  // ── The happy path still works ───────────────────────────────────────────

  it('scaffolds into an existing folder and keeps everything when nothing fails', async () => {
    await fs.writeFile(path.join(projectDir, 'important.txt'), 'a year of work', 'utf-8');

    const result = await createAgentWorkspace({ name: 'my-agent', directory: projectDir });

    expect(result.manifest.name).toBe('my-agent');
    expect(await exists(path.join(projectDir, '.dork', 'agent.json'))).toBe(true);
    expect(await exists(path.join(projectDir, '.dork', 'SOUL.md'))).toBe(true);
    // The positive control for the rollback case above: without it, that case
    // passes for a scaffold that never writes a memory file at all.
    expect(await exists(path.join(projectDir, '.dork', 'MEMORY.md'))).toBe(true);
    expect(await exists(path.join(projectDir, 'AGENTS.md'))).toBe(true);
    expect(await fs.readFile(path.join(projectDir, 'important.txt'), 'utf-8')).toBe(
      'a year of work'
    );
  });

  it('does not project until every step that can still roll back has finished', async () => {
    // Pins the projection OUTSIDE the rollback-protected block. `ScaffoldLedger`
    // classifies a symlink as `other` and never unlinks it, and `pruneEmpty`
    // only `rmdir`s, so a symlink made inside that block would survive a
    // rollback and pin `.claude/` in place, stranding a half-built workspace.
    //
    // The agent-created listener is the last thing the block awaits, so it is
    // the latest possible moment to observe that nothing has been linked yet.
    // (Nothing after it can throw — `notifyAgentCreated` swallows its own
    // listener's errors — so this is as late as any test can look.)
    let linkedDuringScaffold: boolean | undefined;
    setOnAgentCreated(async () => {
      linkedDuringScaffold = await exists(path.join(projectDir, '.claude', 'skills'));
    });

    await createAgentWorkspace({ name: 'my-agent', directory: projectDir });

    expect(linkedDuringScaffold).toBe(false);
    // ...and it certainly happened by the time creation returned.
    expect(await exists(path.join(projectDir, '.claude', 'skills', 'operating-dorkos'))).toBe(true);
  });

  it('links the seeded skills where the default runtime reads them (DOR-659)', async () => {
    await createAgentWorkspace({ name: 'my-agent', directory: projectDir });

    // Seeding writes the canonical copies, which Claude Code cannot see...
    const source = path.join(projectDir, '.agents', 'skills', 'operating-dorkos');
    expect(await exists(path.join(source, 'SKILL.md'))).toBe(true);

    // ...so creation also links every seeded skill into `.claude/skills/`.
    const seeded = await fs.readdir(path.join(projectDir, '.agents', 'skills'));
    expect(seeded.length).toBeGreaterThan(0);
    for (const name of seeded) {
      const link = path.join(projectDir, '.claude', 'skills', name);
      expect((await fs.lstat(link)).isSymbolicLink()).toBe(true);
      expect(await fs.realpath(link)).toBe(
        await fs.realpath(path.join(projectDir, '.agents', 'skills', name))
      );
    }
  });
});

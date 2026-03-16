import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs/promises';
import type { Dirent } from 'fs';

vi.mock('fs/promises');

describe('CommandRegistryService', () => {
  let CommandRegistryService: typeof import('../../runtimes/claude-code/command-registry.js').CommandRegistryService;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import('../../runtimes/claude-code/command-registry.js');
    CommandRegistryService = mod.CommandRegistryService;
  });

  function makeDirent(name: string, isDir: boolean): Dirent {
    return {
      name,
      isDirectory: () => isDir,
      isFile: () => !isDir,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isSymbolicLink: () => false,
      parentPath: '',
      path: '',
    } as Dirent;
  }

  it('scans directory structure and parses frontmatter', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('daily', true)] as never)
      .mockResolvedValueOnce(['plan.md', 'note.md'] as never);

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce('---\ndescription: Plan your day\nargument-hint: none\n---\n# Plan\n')
      .mockResolvedValueOnce('---\ndescription: Open daily note\n---\n# Note\n');

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();

    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toMatchObject({
      namespace: 'daily',
      command: 'note',
      fullCommand: '/daily:note',
      description: 'Open daily note',
    });
    expect(result.commands[1]).toMatchObject({
      namespace: 'daily',
      command: 'plan',
      fullCommand: '/daily:plan',
      description: 'Plan your day',
    });
  });

  it('caches results on second call', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('ns', true)] as never)
      .mockResolvedValueOnce(['cmd.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValueOnce('---\ndescription: Test\n---\n');

    const registry = new CommandRegistryService('/vault');
    const first = await registry.getCommands();
    const second = await registry.getCommands();

    expect(first).toBe(second); // Same reference
    expect(fs.readdir).toHaveBeenCalledTimes(2); // Only called during first scan
  });

  it('invalidateCache forces rescan', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('ns', true)] as never)
      .mockResolvedValueOnce(['cmd.md'] as never)
      .mockResolvedValueOnce([makeDirent('ns', true)] as never)
      .mockResolvedValueOnce(['cmd.md', 'new.md'] as never);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce('---\ndescription: Test\n---\n')
      .mockResolvedValueOnce('---\ndescription: Test\n---\n')
      .mockResolvedValueOnce('---\ndescription: New\n---\n');

    const registry = new CommandRegistryService('/vault');
    const first = await registry.getCommands();
    expect(first.commands).toHaveLength(1);

    registry.invalidateCache();
    const second = await registry.getCommands();
    expect(second.commands).toHaveLength(2);
  });

  it('handles missing commands directory', async () => {
    vi.mocked(fs.readdir).mockRejectedValueOnce(new Error('ENOENT'));

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();
    expect(result.commands).toEqual([]);
  });

  it('sorts commands alphabetically', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('system', true), makeDirent('daily', true)] as never)
      .mockResolvedValueOnce(['review.md'] as never)
      .mockResolvedValueOnce(['plan.md'] as never);

    vi.mocked(fs.readFile)
      .mockResolvedValueOnce('---\ndescription: System review\n---\n')
      .mockResolvedValueOnce('---\ndescription: Daily plan\n---\n');

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();

    expect(result.commands[0].fullCommand).toBe('/daily:plan');
    expect(result.commands[1].fullCommand).toBe('/system:review');
  });

  it('discovers root-level .md files as non-namespaced commands', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      makeDirent('ideate.md', false),
      makeDirent('daily', true),
    ] as never);
    vi.mocked(fs.readdir).mockResolvedValueOnce(['plan.md'] as never);
    vi.mocked(fs.readFile)
      .mockResolvedValueOnce('---\ndescription: Run ideation\n---\n')
      .mockResolvedValueOnce('---\ndescription: Plan\n---\n');

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();

    expect(result.commands).toHaveLength(2);

    const ideate = result.commands.find((c) => c.fullCommand === '/ideate');
    expect(ideate).toMatchObject({
      command: 'ideate',
      fullCommand: '/ideate',
      description: 'Run ideation',
    });
    expect(ideate?.namespace).toBeUndefined();

    const plan = result.commands.find((c) => c.fullCommand === '/daily:plan');
    expect(plan).toMatchObject({
      namespace: 'daily',
      command: 'plan',
      fullCommand: '/daily:plan',
    });
  });

  it('skips non-md non-directory entries', async () => {
    vi.mocked(fs.readdir).mockResolvedValueOnce([
      makeDirent('.DS_Store', false),
      makeDirent('daily', true),
    ] as never);
    vi.mocked(fs.readdir).mockResolvedValueOnce(['plan.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValueOnce('---\ndescription: Plan\n---\n');

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();

    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].namespace).toBe('daily');
  });

  it('skips non-md files', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('daily', true)] as never)
      .mockResolvedValueOnce(['plan.md', 'notes.txt', '.DS_Store'] as never);
    vi.mocked(fs.readFile).mockResolvedValueOnce('---\ndescription: Plan\n---\n');

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();

    expect(result.commands).toHaveLength(1);
  });

  it('parses allowed-tools from frontmatter', async () => {
    vi.mocked(fs.readdir)
      .mockResolvedValueOnce([makeDirent('daily', true)] as never)
      .mockResolvedValueOnce(['plan.md'] as never);
    vi.mocked(fs.readFile).mockResolvedValueOnce(
      '---\ndescription: Plan\nallowed-tools: Read, Write, Bash\n---\n'
    );

    const registry = new CommandRegistryService('/vault');
    const result = await registry.getCommands();

    expect(result.commands[0].allowedTools).toEqual(['Read', 'Write', 'Bash']);
  });
});

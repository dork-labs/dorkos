import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudeCodeStrategy } from '../strategies/claude-code-strategy.js';
import { CursorStrategy } from '../strategies/cursor-strategy.js';
import { CodexStrategy } from '../strategies/codex-strategy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-strategy-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ClaudeCodeStrategy
// ---------------------------------------------------------------------------

describe('ClaudeCodeStrategy', () => {
  const strategy = new ClaudeCodeStrategy();

  it('returns true for a directory with .claude/CLAUDE.md', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'CLAUDE.md'), '# Test project', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns false when .claude/ exists but CLAUDE.md is missing', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('returns false for a non-existent path', async () => {
    expect(await strategy.detect('/nonexistent/path/abc123')).toBe(false);
  });

  it('extractHints returns suggestedName = basename(dir) and detectedRuntime = claude-code', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'claude-project');
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'CLAUDE.md'), '# My Project', 'utf-8');

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('claude-project');
    expect(hints.detectedRuntime).toBe('claude-code');
  });

  it('has name = claude-code and runtime = claude-code', () => {
    expect(strategy.name).toBe('claude-code');
    expect(strategy.runtime).toBe('claude-code');
  });
});

// ---------------------------------------------------------------------------
// CursorStrategy
// ---------------------------------------------------------------------------

describe('CursorStrategy', () => {
  const strategy = new CursorStrategy();

  it('returns true for a directory with .cursor/', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'cursor-project');
    await fs.mkdir(path.join(dir, '.cursor'), { recursive: true });

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('cursor-project');
    expect(hints.detectedRuntime).toBe('cursor');
  });

  it('has name = cursor and runtime = cursor', () => {
    expect(strategy.name).toBe('cursor');
    expect(strategy.runtime).toBe('cursor');
  });
});

// ---------------------------------------------------------------------------
// CodexStrategy
// ---------------------------------------------------------------------------

describe('CodexStrategy', () => {
  const strategy = new CodexStrategy();

  it('returns true for a directory with .codex/', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.codex'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'codex-project');
    await fs.mkdir(path.join(dir, '.codex'), { recursive: true });

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('codex-project');
    expect(hints.detectedRuntime).toBe('codex');
  });

  it('has name = codex and runtime = codex', () => {
    expect(strategy.name).toBe('codex');
    expect(strategy.runtime).toBe('codex');
  });
});

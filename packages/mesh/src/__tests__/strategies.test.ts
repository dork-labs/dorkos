import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudeCodeStrategy } from '../strategies/claude-code-strategy.js';
import { CursorStrategy } from '../strategies/cursor-strategy.js';
import { CodexStrategy } from '../strategies/codex-strategy.js';
import { WindsurfStrategy } from '../strategies/windsurf-strategy.js';
import { GeminiStrategy } from '../strategies/gemini-strategy.js';
import { ClineStrategy } from '../strategies/cline-strategy.js';
import { RooCodeStrategy } from '../strategies/roo-code-strategy.js';
import { CopilotStrategy } from '../strategies/copilot-strategy.js';
import { AmazonQStrategy } from '../strategies/amazon-q-strategy.js';
import { ContinueStrategy } from '../strategies/continue-strategy.js';

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

  it('returns true for a directory with CLAUDE.md at the root', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# My Project', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with AGENTS.md at the root', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# My Project', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true when both CLAUDE.md and .claude/ exist (typical project layout)', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# My Project', 'utf-8');
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('prefers CLAUDE.md description over AGENTS.md', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# Title\n\nFrom CLAUDE', 'utf-8');
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# Title\n\nFrom AGENTS', 'utf-8');

    const hints = await strategy.extractHints(dir);
    expect(hints.description).toBe('From CLAUDE');
  });

  it('returns false when only .claude/ exists without root markdown files (global config dir pattern)', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns suggestedName = basename(dir) and detectedRuntime = claude-code', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'claude-project');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# My Project', 'utf-8');

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('claude-project');
    expect(hints.detectedRuntime).toBe('claude-code');
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

  it('returns true for a directory with .cursorrules file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, '.cursorrules'), 'Use TypeScript', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
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
});

// ---------------------------------------------------------------------------
// WindsurfStrategy
// ---------------------------------------------------------------------------

describe('WindsurfStrategy', () => {
  const strategy = new WindsurfStrategy();

  it('returns true for a directory with .windsurfrules file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, '.windsurfrules'), 'Use TypeScript', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with .windsurf/ directory', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.windsurf'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GeminiStrategy
// ---------------------------------------------------------------------------

describe('GeminiStrategy', () => {
  const strategy = new GeminiStrategy();

  it('returns true for a directory with GEMINI.md', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'GEMINI.md'), '# Gemini context', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with .gemini/ directory', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.gemini'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ClineStrategy
// ---------------------------------------------------------------------------

describe('ClineStrategy', () => {
  const strategy = new ClineStrategy();

  it('returns true for a directory with .clinerules file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, '.clinerules'), 'Follow TDD', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with .clinerules/ directory', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.clinerules'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RooCodeStrategy
// ---------------------------------------------------------------------------

describe('RooCodeStrategy', () => {
  const strategy = new RooCodeStrategy();

  it('returns true for a directory with .roo/ directory', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.roo'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with .roorules file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, '.roorules'), 'rules', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CopilotStrategy
// ---------------------------------------------------------------------------

describe('CopilotStrategy', () => {
  const strategy = new CopilotStrategy();

  it('returns true for a directory with .github/copilot-instructions.md', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.github'), { recursive: true });
    await fs.writeFile(path.join(dir, '.github/copilot-instructions.md'), 'instructions', 'utf-8');

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with .github/instructions/', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.github', 'instructions'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns true for a directory with .github/agents/', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.github', 'agents'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });

  it('returns false when only .github/ exists without copilot files', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.github'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AmazonQStrategy
// ---------------------------------------------------------------------------

describe('AmazonQStrategy', () => {
  const strategy = new AmazonQStrategy();

  it('returns true for a directory with .amazonq/', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.amazonq'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ContinueStrategy
// ---------------------------------------------------------------------------

describe('ContinueStrategy', () => {
  const strategy = new ContinueStrategy();

  it('returns true for a directory with .continue/', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.continue'), { recursive: true });

    expect(await strategy.detect(dir)).toBe(true);
  });
});

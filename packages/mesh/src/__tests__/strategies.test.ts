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

  it('returns false for a non-existent path', async () => {
    expect(await strategy.detect('/nonexistent/path/abc123')).toBe(false);
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

  it('returns true for a directory with .cursorrules file', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, '.cursorrules'), 'Use TypeScript', 'utf-8');

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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'windsurf-project');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.windsurfrules'), '', 'utf-8');

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('windsurf-project');
    expect(hints.detectedRuntime).toBe('windsurf');
  });

  it('has name = windsurf and runtime = windsurf', () => {
    expect(strategy.name).toBe('windsurf');
    expect(strategy.runtime).toBe('windsurf');
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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'gemini-project');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'GEMINI.md'), '', 'utf-8');

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('gemini-project');
    expect(hints.detectedRuntime).toBe('gemini');
  });

  it('has name = gemini and runtime = gemini', () => {
    expect(strategy.name).toBe('gemini');
    expect(strategy.runtime).toBe('gemini');
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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'cline-project');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.clinerules'), '', 'utf-8');

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('cline-project');
    expect(hints.detectedRuntime).toBe('cline');
  });

  it('has name = cline and runtime = cline', () => {
    expect(strategy.name).toBe('cline');
    expect(strategy.runtime).toBe('cline');
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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'roo-project');
    await fs.mkdir(path.join(dir, '.roo'), { recursive: true });

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('roo-project');
    expect(hints.detectedRuntime).toBe('roo-code');
  });

  it('has name = roo-code and runtime = roo-code', () => {
    expect(strategy.name).toBe('roo-code');
    expect(strategy.runtime).toBe('roo-code');
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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'copilot-project');
    await fs.mkdir(path.join(dir, '.github'), { recursive: true });
    await fs.writeFile(path.join(dir, '.github/copilot-instructions.md'), '', 'utf-8');

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('copilot-project');
    expect(hints.detectedRuntime).toBe('copilot');
  });

  it('has name = copilot and runtime = copilot', () => {
    expect(strategy.name).toBe('copilot');
    expect(strategy.runtime).toBe('copilot');
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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'q-project');
    await fs.mkdir(path.join(dir, '.amazonq'), { recursive: true });

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('q-project');
    expect(hints.detectedRuntime).toBe('amazon-q');
  });

  it('has name = amazon-q and runtime = amazon-q', () => {
    expect(strategy.name).toBe('amazon-q');
    expect(strategy.runtime).toBe('amazon-q');
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

  it('returns false for an empty project directory', async () => {
    const dir = await makeTempDir();

    expect(await strategy.detect(dir)).toBe(false);
  });

  it('extractHints returns correct suggestedName and detectedRuntime', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'continue-project');
    await fs.mkdir(path.join(dir, '.continue'), { recursive: true });

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('continue-project');
    expect(hints.detectedRuntime).toBe('continue');
  });

  it('has name = continue and runtime = continue', () => {
    expect(strategy.name).toBe('continue');
    expect(strategy.runtime).toBe('continue');
  });
});

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

  it('returns true for a directory with AGENTS.md at the root', async () => {
    const dir = await makeTempDir();
    await fs.writeFile(path.join(dir, 'AGENTS.md'), '# My Project', 'utf-8');

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

/**
 * Every other strategy detects by a marker file or folder. One row per marker;
 * a strategy's whole contract is "this marker means this tool".
 */
describe('marker-based strategies', () => {
  const rows: Array<[string, { detect(dir: string): Promise<boolean> }, string, 'dir' | 'file']> = [
    ['Cursor', new CursorStrategy(), '.cursor', 'dir'],
    ['Cursor', new CursorStrategy(), '.cursorrules', 'file'],
    ['Codex', new CodexStrategy(), '.codex', 'dir'],
    ['Windsurf', new WindsurfStrategy(), '.windsurfrules', 'file'],
    ['Windsurf', new WindsurfStrategy(), '.windsurf', 'dir'],
    ['Gemini', new GeminiStrategy(), 'GEMINI.md', 'file'],
    ['Gemini', new GeminiStrategy(), '.gemini', 'dir'],
    ['Cline', new ClineStrategy(), '.clinerules', 'file'],
    ['Cline', new ClineStrategy(), '.clinerules', 'dir'],
    ['RooCode', new RooCodeStrategy(), '.roo', 'dir'],
    ['RooCode', new RooCodeStrategy(), '.roorules', 'file'],
    ['Copilot', new CopilotStrategy(), '.github/copilot-instructions.md', 'file'],
    ['Copilot', new CopilotStrategy(), '.github/instructions', 'dir'],
    ['Copilot', new CopilotStrategy(), '.github/agents', 'dir'],
    ['AmazonQ', new AmazonQStrategy(), '.amazonq', 'dir'],
    ['Continue', new ContinueStrategy(), '.continue', 'dir'],
  ];

  it.each(rows)('%s detects a project with %s (%s)', async (_name, strategy, marker, kind) => {
    const dir = await makeTempDir();
    if (kind === 'dir') await fs.mkdir(path.join(dir, marker), { recursive: true });
    else {
      await fs.mkdir(path.dirname(path.join(dir, marker)), { recursive: true });
      await fs.writeFile(path.join(dir, marker), 'x', 'utf-8');
    }
    expect(await strategy.detect(dir)).toBe(true);
  });

  it('Copilot ignores a bare .github/ with no Copilot files', async () => {
    const dir = await makeTempDir();
    await fs.mkdir(path.join(dir, '.github'), { recursive: true });
    expect(await new CopilotStrategy().detect(dir)).toBe(false);
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ClaudeCodeStrategy, extractFirstParagraph } from '../strategies/claude-code-strategy.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mesh-claude-desc-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// extractFirstParagraph (pure function)
// ---------------------------------------------------------------------------

describe('extractFirstParagraph', () => {
  it('extracts the first paragraph after a heading', () => {
    const content = `# My Project

This is a project that does something useful.

## More details
`;
    expect(extractFirstParagraph(content)).toBe(
      'This is a project that does something useful.',
    );
  });

  it('skips multiple headings before content', () => {
    const content = `# Title
## Subtitle

The actual content starts here.
`;
    expect(extractFirstParagraph(content)).toBe('The actual content starts here.');
  });

  it('joins multi-line paragraphs', () => {
    const content = `# Title

First line of paragraph.
Second line of paragraph.

Next paragraph.
`;
    expect(extractFirstParagraph(content)).toBe(
      'First line of paragraph. Second line of paragraph.',
    );
  });

  it('truncates to 200 chars with ellipsis', () => {
    const longLine = 'A'.repeat(250);
    const content = `# Title\n\n${longLine}\n`;
    const result = extractFirstParagraph(content);
    expect(result).toHaveLength(200);
    expect(result!.endsWith('...')).toBe(true);
  });

  it('returns undefined for content with only headings', () => {
    const content = `# Title\n## Subtitle\n### Another\n`;
    expect(extractFirstParagraph(content)).toBeUndefined();
  });

  it('returns undefined for empty content', () => {
    expect(extractFirstParagraph('')).toBeUndefined();
  });

  it('returns content that starts without a heading', () => {
    const content = 'No heading, just content.';
    expect(extractFirstParagraph(content)).toBe('No heading, just content.');
  });

  it('stops at the next heading after collecting a paragraph', () => {
    const content = `# Title

First paragraph here.
# Next Section

Should not appear.
`;
    expect(extractFirstParagraph(content)).toBe('First paragraph here.');
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeStrategy.extractHints with description
// ---------------------------------------------------------------------------

describe('ClaudeCodeStrategy description extraction', () => {
  const strategy = new ClaudeCodeStrategy();

  it('extracts description from CLAUDE.md', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'my-project');
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'CLAUDE.md'),
      `# CLAUDE.md

This project is a backend API for managing widgets.

## Commands
Some commands here.
`,
      'utf-8',
    );

    const hints = await strategy.extractHints(dir);

    expect(hints.suggestedName).toBe('my-project');
    expect(hints.detectedRuntime).toBe('claude-code');
    expect(hints.inferredCapabilities).toEqual(['code']);
    expect(hints.description).toBe(
      'This project is a backend API for managing widgets.',
    );
  });

  it('returns no description when CLAUDE.md has only headings', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'headings-only');
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'CLAUDE.md'),
      `# Title\n## Subtitle\n### Section\n`,
      'utf-8',
    );

    const hints = await strategy.extractHints(dir);
    expect(hints.description).toBeUndefined();
  });

  it('returns no description when CLAUDE.md is empty', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'empty-md');
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(path.join(dir, '.claude', 'CLAUDE.md'), '', 'utf-8');

    const hints = await strategy.extractHints(dir);
    expect(hints.description).toBeUndefined();
  });

  it('returns no description when CLAUDE.md does not exist (extractHints still works)', async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, 'no-claude-md');
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    // No CLAUDE.md file — extractDescription should return undefined gracefully

    const hints = await strategy.extractHints(dir);
    expect(hints.suggestedName).toBe('no-claude-md');
    expect(hints.description).toBeUndefined();
  });
});

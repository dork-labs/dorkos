/**
 * Discovery strategy for Claude Code agent projects.
 *
 * Detects directories containing a `.claude/` folder with a `CLAUDE.md` file.
 * Extracts the project name from the directory basename and attempts to
 * read a description from the CLAUDE.md contents.
 *
 * @module mesh/strategies/claude-code-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/** Maximum bytes to read from CLAUDE.md for description extraction. */
const MAX_CLAUDEMD_BYTES = 4096;

/**
 * Detects Claude Code agent projects by the presence of `.claude/` directory
 * containing a `CLAUDE.md` file.
 */
export class ClaudeCodeStrategy implements DiscoveryStrategy {
  readonly name = 'claude-code';
  readonly runtime = 'claude-code' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      await fs.access(path.join(dir, '.claude', 'CLAUDE.md'));
      return true;
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    const suggestedName = path.basename(dir);
    const description = await this.extractDescription(dir);

    return {
      suggestedName,
      detectedRuntime: 'claude-code',
      inferredCapabilities: ['code'],
      ...(description && { description }),
    };
  }

  /**
   * Extract a description from the CLAUDE.md file.
   *
   * Reads the first chunk and returns the first non-heading paragraph.
   */
  private async extractDescription(dir: string): Promise<string | undefined> {
    try {
      const claudeMdPath = path.join(dir, '.claude', 'CLAUDE.md');
      const fd = await fs.open(claudeMdPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_CLAUDEMD_BYTES);
        const { bytesRead } = await fd.read(buf, 0, MAX_CLAUDEMD_BYTES, 0);
        const content = buf.toString('utf-8', 0, bytesRead);
        return extractFirstParagraph(content);
      } finally {
        await fd.close();
      }
    } catch {
      return undefined;
    }
  }
}

/**
 * Extract the first meaningful paragraph from markdown content.
 *
 * Skips leading headings and blank lines, then collects the first
 * non-empty paragraph up to 200 characters.
 *
 * @internal Exported for testing only.
 */
export function extractFirstParagraph(content: string): string | undefined {
  const lines = content.split('\n');
  const paragraphLines: string[] = [];
  let foundContent = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip headings and blank lines before content
    if (!foundContent) {
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      foundContent = true;
    }

    // Stop at next heading or blank line after we've started collecting
    if (foundContent && paragraphLines.length > 0 && (trimmed === '' || trimmed.startsWith('#'))) {
      break;
    }

    if (foundContent && trimmed !== '') {
      paragraphLines.push(trimmed);
    }
  }

  if (paragraphLines.length === 0) return undefined;

  const paragraph = paragraphLines.join(' ');
  if (paragraph.length > 200) {
    return paragraph.slice(0, 197) + '...';
  }
  return paragraph;
}

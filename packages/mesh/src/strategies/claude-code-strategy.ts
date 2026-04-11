/**
 * Discovery strategy for Claude Code agent projects.
 *
 * Detects directories containing `CLAUDE.md` or `AGENTS.md` at the project
 * root. These are the canonical markers for a Claude Code project.
 *
 * @module mesh/strategies/claude-code-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/** Maximum bytes to read from a markdown file for description extraction. */
const MAX_MD_BYTES = 4096;

/**
 * Root-level files that indicate a Claude Code project. Checked in priority
 * order — the first match wins. We deliberately exclude `.claude/` as a
 * standalone signal because the global `~/.claude/` directory exists on every
 * machine running Claude Code and would cause false positives.
 */
const DETECTION_FILES = ['CLAUDE.md', 'AGENTS.md'] as const;

/**
 * Detects Claude Code agent projects by the presence of `CLAUDE.md` or
 * `AGENTS.md` at the project root.
 *
 * `CLAUDE.md` is the primary project instructions file for Claude Code.
 * `AGENTS.md` is the cross-tool standard originated by Claude Code.
 */
export class ClaudeCodeStrategy implements DiscoveryStrategy {
  readonly name = 'claude-code';
  readonly runtime = 'claude-code' as const;

  async detect(dir: string): Promise<boolean> {
    for (const file of DETECTION_FILES) {
      try {
        const stat = await fs.stat(path.join(dir, file));
        if (stat.isFile()) return true;
      } catch {
        // continue to next signal
      }
    }
    return false;
  }

  async extractHints(dir: string): Promise<AgentHints> {
    const suggestedName = path.basename(dir);
    // Prefer CLAUDE.md for description, fall back to AGENTS.md
    const description =
      (await this.extractDescription(dir, 'CLAUDE.md')) ??
      (await this.extractDescription(dir, 'AGENTS.md'));

    return {
      suggestedName,
      detectedRuntime: 'claude-code',
      inferredCapabilities: ['code'],
      ...(description && { description }),
    };
  }

  /**
   * Extract a description from a markdown file at the project root.
   *
   * Reads the first chunk and returns the first non-heading paragraph.
   */
  private async extractDescription(dir: string, filename: string): Promise<string | undefined> {
    try {
      const mdPath = path.join(dir, filename);
      const fd = await fs.open(mdPath, 'r');
      try {
        const buf = Buffer.alloc(MAX_MD_BYTES);
        const { bytesRead } = await fd.read(buf, 0, MAX_MD_BYTES, 0);
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

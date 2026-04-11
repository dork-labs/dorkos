/**
 * Discovery strategy for Gemini CLI agent projects.
 *
 * Detects directories containing a `GEMINI.md` file or a `.gemini/`
 * directory at the project root.
 *
 * @module mesh/strategies/gemini-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Gemini CLI projects by the presence of `GEMINI.md` (context file)
 * or a `.gemini/` directory (settings, commands, extensions, policies).
 */
export class GeminiStrategy implements DiscoveryStrategy {
  readonly name = 'gemini';
  readonly runtime = 'gemini' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, 'GEMINI.md'));
      if (stat.isFile()) return true;
    } catch {
      // continue
    }
    try {
      const stat = await fs.stat(path.join(dir, '.gemini'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'gemini',
      inferredCapabilities: ['code'],
    };
  }
}

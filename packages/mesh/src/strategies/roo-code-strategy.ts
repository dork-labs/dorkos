/**
 * Discovery strategy for Roo Code agent projects.
 *
 * Detects directories containing a `.roo/` directory or `.roorules` file
 * at the project root.
 *
 * @module mesh/strategies/roo-code-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Roo Code projects by the presence of a `.roo/` directory (which
 * contains `rules/` and mode-specific rule directories) or a `.roorules`
 * file at the project root.
 */
export class RooCodeStrategy implements DiscoveryStrategy {
  readonly name = 'roo-code';
  readonly runtime = 'roo-code' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.roo'));
      if (stat.isDirectory()) return true;
    } catch {
      // continue
    }
    try {
      const stat = await fs.stat(path.join(dir, '.roorules'));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'roo-code',
      inferredCapabilities: ['code'],
    };
  }
}

/**
 * Discovery strategy for Cline (formerly Claude Dev) agent projects.
 *
 * Detects directories containing a `.clinerules` file or directory at the
 * project root.
 *
 * @module mesh/strategies/cline-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Cline agent projects by the presence of `.clinerules` (file or
 * directory) at the project root. Cline supports both a single `.clinerules`
 * text file and a `.clinerules/` directory containing multiple rule files.
 */
export class ClineStrategy implements DiscoveryStrategy {
  readonly name = 'cline';
  readonly runtime = 'cline' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      await fs.stat(path.join(dir, '.clinerules'));
      return true;
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'cline',
      inferredCapabilities: ['code'],
    };
  }
}

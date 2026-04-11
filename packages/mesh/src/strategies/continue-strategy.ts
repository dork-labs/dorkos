/**
 * Discovery strategy for Continue.dev agent projects.
 *
 * Detects directories containing a `.continue/` directory at the project root.
 *
 * @module mesh/strategies/continue-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Continue.dev projects by the presence of a `.continue/` directory
 * (which contains `rules/`, `checks/`, and project-specific config).
 */
export class ContinueStrategy implements DiscoveryStrategy {
  readonly name = 'continue';
  readonly runtime = 'continue' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.continue'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'continue',
      inferredCapabilities: ['code'],
    };
  }
}

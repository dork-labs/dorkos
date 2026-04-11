/**
 * Discovery strategy for Amazon Q Developer agent projects.
 *
 * Detects directories containing a `.amazonq/` directory at the project root.
 *
 * @module mesh/strategies/amazon-q-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Amazon Q Developer projects by the presence of a `.amazonq/`
 * directory (which contains `rules/` with markdown rule files).
 */
export class AmazonQStrategy implements DiscoveryStrategy {
  readonly name = 'amazon-q';
  readonly runtime = 'amazon-q' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.amazonq'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'amazon-q',
      inferredCapabilities: ['code'],
    };
  }
}

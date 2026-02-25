/**
 * Discovery strategy for Cursor agent projects.
 *
 * Detects directories containing a `.cursor/` folder. Optionally reads
 * `.cursor/rules` files to infer capabilities and description.
 *
 * @module mesh/strategies/cursor-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Cursor agent projects by the presence of a `.cursor/` directory.
 */
export class CursorStrategy implements DiscoveryStrategy {
  readonly name = 'cursor';
  readonly runtime = 'cursor' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.cursor'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'cursor',
      inferredCapabilities: ['code'],
    };
  }
}

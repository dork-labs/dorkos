/**
 * Discovery strategy for Cursor agent projects.
 *
 * Detects directories containing a `.cursor/` directory or a `.cursorrules`
 * file at the project root.
 *
 * @module mesh/strategies/cursor-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Cursor agent projects by the presence of a `.cursor/` directory
 * or a `.cursorrules` file at the project root.
 */
export class CursorStrategy implements DiscoveryStrategy {
  readonly name = 'cursor';
  readonly runtime = 'cursor' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.cursor'));
      if (stat.isDirectory()) return true;
    } catch {
      // continue
    }
    try {
      const stat = await fs.stat(path.join(dir, '.cursorrules'));
      return stat.isFile();
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

/**
 * Discovery strategy for Windsurf (Codeium) agent projects.
 *
 * Detects directories containing a `.windsurfrules` file or a `.windsurf/`
 * directory at the project root.
 *
 * @module mesh/strategies/windsurf-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Windsurf agent projects by the presence of `.windsurfrules` or
 * a `.windsurf/` directory (which contains `rules/` for workspace-level rules).
 */
export class WindsurfStrategy implements DiscoveryStrategy {
  readonly name = 'windsurf';
  readonly runtime = 'windsurf' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.windsurfrules'));
      if (stat.isFile()) return true;
    } catch {
      // continue
    }
    try {
      const stat = await fs.stat(path.join(dir, '.windsurf'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'windsurf',
      inferredCapabilities: ['code'],
    };
  }
}

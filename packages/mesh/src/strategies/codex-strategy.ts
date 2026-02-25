/**
 * Discovery strategy for Codex agent projects.
 *
 * Detects directories containing a `.codex/` folder.
 *
 * @module mesh/strategies/codex-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/**
 * Detects Codex agent projects by the presence of a `.codex/` directory.
 */
export class CodexStrategy implements DiscoveryStrategy {
  readonly name = 'codex';
  readonly runtime = 'codex' as const;

  async detect(dir: string): Promise<boolean> {
    try {
      const stat = await fs.stat(path.join(dir, '.codex'));
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'codex',
      inferredCapabilities: ['code'],
    };
  }
}

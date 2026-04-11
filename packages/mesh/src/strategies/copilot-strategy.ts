/**
 * Discovery strategy for GitHub Copilot agent projects.
 *
 * Detects directories containing Copilot-specific files within a `.github/`
 * directory: `copilot-instructions.md`, `instructions/`, or `agents/`.
 *
 * @module mesh/strategies/copilot-strategy
 */
import fs from 'fs/promises';
import path from 'path';
import type { AgentHints } from '@dorkos/shared/mesh-schemas';
import type { DiscoveryStrategy } from '../types.js';

/** Copilot-specific paths within `.github/`, checked in priority order. */
const COPILOT_SIGNALS = [
  '.github/copilot-instructions.md',
  '.github/instructions',
  '.github/agents',
] as const;

/**
 * Detects GitHub Copilot projects by the presence of Copilot-specific
 * configuration within the `.github/` directory (e.g., `copilot-instructions.md`,
 * `instructions/`, `agents/`).
 *
 * We check for Copilot-specific artifacts rather than just `.github/` to avoid
 * false positives from any GitHub-hosted repository.
 */
export class CopilotStrategy implements DiscoveryStrategy {
  readonly name = 'copilot';
  readonly runtime = 'copilot' as const;

  async detect(dir: string): Promise<boolean> {
    for (const signal of COPILOT_SIGNALS) {
      try {
        await fs.stat(path.join(dir, signal));
        return true;
      } catch {
        // continue to next signal
      }
    }
    return false;
  }

  async extractHints(dir: string): Promise<AgentHints> {
    return {
      suggestedName: path.basename(dir),
      detectedRuntime: 'copilot',
      inferredCapabilities: ['code'],
    };
  }
}

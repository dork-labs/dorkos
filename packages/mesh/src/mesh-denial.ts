/**
 * Denial management operations extracted from MeshCore.
 *
 * Delegates to the DenialList for deny/undeny/list operations,
 * providing the MeshCore-level API surface with default registrar naming.
 *
 * @module mesh/mesh-denial
 */
import type { DenialRecord } from '@dorkos/shared/mesh-schemas';
import type { DenialList } from './denial-list.js';

/** Default registrar identifier when none is provided. */
const DEFAULT_REGISTRAR = 'mesh';

/** Dependencies required by denial management functions. */
export interface DenialDeps {
  denialList: DenialList;
}

/**
 * Add a project path to the denial list.
 *
 * Denied paths are filtered from future discovery scans.
 *
 * @param deps - Denial dependencies
 * @param filePath - Absolute path to the project directory to deny
 * @param reason - Human-readable reason for denial (optional)
 * @param denier - Identifier of the entity performing the denial (default: "mesh")
 */
export async function deny(
  deps: DenialDeps,
  filePath: string,
  reason?: string,
  denier = DEFAULT_REGISTRAR
): Promise<void> {
  deps.denialList.deny(filePath, 'manual', reason, denier);
}

/**
 * Remove a project path from the denial list.
 *
 * @param deps - Denial dependencies
 * @param filePath - Absolute path to clear from the denial list
 */
export async function undeny(deps: DenialDeps, filePath: string): Promise<void> {
  deps.denialList.clear(filePath);
}

/**
 * List all denial records.
 *
 * @param deps - Denial dependencies
 * @returns All denials ordered by denial date (newest first)
 */
export function listDenied(deps: DenialDeps): DenialRecord[] {
  return deps.denialList.list();
}

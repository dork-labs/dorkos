/**
 * Concrete adapters that back the Shape apply/fork/list flows in production —
 * the thin glue between the pure services ({@link ./apply-shape}, {@link ./fork})
 * and the server's real singletons (config manager, extension secret store,
 * on-disk Shape installs).
 *
 * @module services/shapes/shape-services
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { ShapePackageManifest } from '@dorkos/marketplace';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import { ExtensionSecretStore } from '@dorkos/shared/extension-secrets';
import { configManager } from '../core/config-manager.js';
import type {
  ShapeConfigStoreLike,
  ShapeManifestResolverLike,
  ShapeSecretCheckerLike,
} from './apply-shape.js';

/** A summary of an installed Shape returned by `GET /api/shapes`. */
export interface InstalledShapeSummary {
  /** Shape name (the install directory + manifest name). */
  name: string;
  /** Human-facing display name, when the manifest declares one. */
  displayName?: string;
  /** Whether this Shape is the currently-applied one (`ui.shapes.active`). */
  active: boolean;
  /** Fork lineage, present only on forked Shapes. */
  lineage?: ShapePackageManifest['lineage'];
}

/**
 * Read + parse an installed Shape's manifest from
 * `{dorkHome}/shapes/<name>/.dork/manifest.json`. Returns `null` when it is
 * missing, unparseable, or not a Shape.
 *
 * @param dorkHome - Resolved data directory.
 * @param name - Installed Shape name.
 * @returns The parsed manifest, or `null`.
 */
async function readInstalledShape(
  dorkHome: string,
  name: string
): Promise<ShapePackageManifest | null> {
  try {
    const raw = await readFile(
      path.join(dorkHome, 'shapes', name, '.dork', 'manifest.json'),
      'utf-8'
    );
    const parsed = MarketplacePackageManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.type !== 'shape') return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * Build the on-disk manifest resolver the apply flow uses to resolve an
 * installed Shape (the missing case is the one fatal error).
 *
 * @param dorkHome - Resolved data directory.
 * @returns A {@link ShapeManifestResolverLike}.
 */
export function createFsShapeManifestResolver(dorkHome: string): ShapeManifestResolverLike {
  return { resolve: (name) => readInstalledShape(dorkHome, name) };
}

/**
 * Build the config store the apply flow uses to read the Shape prefs and record
 * the active Shape. Writes are whole-object per section (deepMerge replaces
 * arrays), preserving `agentDefaults` / `autoFollowAgent` (ADR 260717-001409).
 *
 * @returns A {@link ShapeConfigStoreLike}.
 */
export function createShapeConfigStore(): ShapeConfigStoreLike {
  return {
    getShapePrefs: () => configManager.get('ui').shapes,
    setActiveShape: (name) => {
      const ui = configManager.get('ui');
      configManager.set('ui', { ...ui, shapes: { ...ui.shapes, active: name } });
    },
  };
}

/**
 * Build the extension-secret checker the apply flow uses to decide whether a
 * connection needs setup. Never returns the secret value.
 *
 * @param dorkHome - Resolved data directory.
 * @returns A {@link ShapeSecretCheckerLike}.
 */
export function createShapeSecretChecker(dorkHome: string): ShapeSecretCheckerLike {
  return { isSet: (extensionId, key) => new ExtensionSecretStore(extensionId, dorkHome).has(key) };
}

/**
 * The currently-enabled extension ids (the `extensions.enabled` deviation list —
 * the "turned ON that defaults OFF" set). Used by the capture-current fork.
 *
 * @returns The enabled extension ids.
 */
export function getEnabledExtensionIds(): string[] {
  return configManager.get('extensions').enabled;
}

/**
 * The currently-active Shape name (`ui.shapes.active`), or `null`.
 *
 * @returns The active Shape name.
 */
export function getActiveShapeName(): string | null {
  return configManager.get('ui').shapes.active;
}

/**
 * Clear the active Shape (`ui.shapes.active` → `null`). Called when the active
 * Shape is uninstalled so the pointer never dangles at a deleted install. The
 * whole-section write preserves the sibling `agentDefaults` / `autoFollowAgent`
 * prefs (deepMerge replaces arrays), mirroring {@link createShapeConfigStore}.
 */
export function clearActiveShape(): void {
  const ui = configManager.get('ui');
  configManager.set('ui', { ...ui, shapes: { ...ui.shapes, active: null } });
}

/**
 * List every installed Shape under `{dorkHome}/shapes/`, tagging the active one.
 * Unreadable / non-Shape directories are skipped silently, mirroring the
 * best-effort discovery elsewhere in the marketplace.
 *
 * @param dorkHome - Resolved data directory.
 * @param activeName - The currently-active Shape name (`ui.shapes.active`).
 * @returns The installed Shape summaries, sorted by name.
 */
export async function listInstalledShapes(
  dorkHome: string,
  activeName: string | null
): Promise<InstalledShapeSummary[]> {
  const shapesRoot = path.join(dorkHome, 'shapes');
  let entries: string[];
  try {
    const dirents = await readdir(shapesRoot, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return []; // No shapes/ dir yet — nothing installed.
  }

  const summaries: InstalledShapeSummary[] = [];
  for (const name of entries) {
    const manifest = await readInstalledShape(dorkHome, name);
    if (!manifest) continue;
    summaries.push({
      name: manifest.name,
      displayName: manifest.displayName,
      active: manifest.name === activeName,
      lineage: manifest.lineage,
    });
  }
  return summaries.sort((a, b) => a.name.localeCompare(b.name));
}

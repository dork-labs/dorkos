/**
 * Fork-shape service (DOR-355, spec §6.2).
 *
 * Forking clones an installed Shape into a new, independently-editable Shape and
 * stamps it with `lineage` (the durable "forked from …" metadata the share loop
 * reads, P7). The original is only ever read, so it stays byte-identical.
 *
 * The **capture-current-arrangement** fork is the flywheel: when forking the
 * *active* Shape with `captureCurrent`, the new manifest captures the user's
 * live arrangement — the currently-enabled extensions among the Shape's
 * `activates` candidates, and the client's live chrome (`layout`) when supplied.
 * Per Open Question Q2, only Shape-originated schedules are carried (exactly the
 * source manifest's `schedules`); unrelated tasks are never vacuumed in.
 *
 * The clone rides the same file-scoped transaction as install (ADR-0304): a
 * failure leaves zero residue at the new target and never touches the original.
 *
 * @module services/shapes/fork
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ShapePackageManifest } from '@dorkos/marketplace';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { atomicMove } from '../marketplace/lib/atomic-move.js';
import { stagePackageContents } from '../marketplace/lib/stage-package.js';
import { readInstallMetadata } from '../marketplace/installed-metadata.js';
import { runTransaction } from '../marketplace/transaction.js';
import { pathExists } from '../marketplace/lib/staged-extensions.js';
import { ShapeNotInstalledError, type ShapeLayout } from './apply-shape.js';

/** Options for {@link forkShape}. */
export interface ForkShapeOptions {
  /** New Shape name. Defaults to `<name>-fork`. Must be a kebab-case slug. */
  as?: string;
  /**
   * When true AND the source Shape is currently active, capture the live
   * arrangement into the new manifest (enabled extensions + client chrome).
   */
  captureCurrent?: boolean;
  /**
   * The client's live chrome to snapshot when `captureCurrent`. The server
   * cannot observe UI chrome on its own, so the route passes it through; absent,
   * the source manifest's `layout` is kept.
   */
  liveLayout?: ShapeLayout;
}

/** Injected collaborators for {@link forkShape}. */
export interface ForkShapeDeps {
  /** Resolved DorkOS data directory (see `.claude/rules/dork-home.md`). */
  dorkHome: string;
  logger: Logger;
  /** For `captureCurrent`: currently-enabled extension ids (config `extensions.enabled`). */
  getEnabledExtensions?: () => string[];
  /** For `captureCurrent`: the currently-active Shape name (`ui.shapes.active`). */
  getActiveShape?: () => string | null;
}

/** The outcome of a successful {@link forkShape}. */
export interface ForkShapeResult {
  ok: true;
  /** The new Shape's name. */
  name: string;
  /** The `<name>@<source>` lineage stamp on the fork. */
  forkedFrom: string;
  /** Absolute path the new Shape landed at. */
  installPath: string;
  /** The forked manifest. */
  manifest: ShapePackageManifest;
}

/** Thrown when a fork target name is invalid or already taken. */
export class ShapeForkConflictError extends Error {
  /**
   * Build the conflict error with a human-readable reason.
   *
   * @param message - Human-readable reason the fork cannot proceed.
   */
  constructor(message: string) {
    super(message);
    this.name = 'ShapeForkConflictError';
  }
}

/** Kebab-case package-name shape (mirrors the manifest `name` constraint). */
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

/**
 * Fork an installed Shape into a new one, stamping lineage.
 *
 * @param name - The installed source Shape name.
 * @param opts - Fork options (`as`, `captureCurrent`, `liveLayout`).
 * @param deps - Injected collaborators.
 * @returns The fork result.
 * @throws {ShapeNotInstalledError} When the source Shape is not installed.
 * @throws {ShapeForkConflictError} When the target name is invalid or already exists.
 */
export async function forkShape(
  name: string,
  opts: ForkShapeOptions,
  deps: ForkShapeDeps
): Promise<ForkShapeResult> {
  const sourceRoot = path.join(deps.dorkHome, 'shapes', name);
  const sourceManifestPath = path.join(sourceRoot, '.dork', 'manifest.json');

  // Resolve the source manifest. Missing → not installed (zero residue: nothing
  // has been written yet).
  const sourceManifest = await readShapeManifest(sourceManifestPath);
  if (!sourceManifest) {
    throw new ShapeNotInstalledError(name);
  }

  const newName = opts.as ?? `${name}-fork`;
  if (!SLUG_RE.test(newName)) {
    throw new ShapeForkConflictError(
      `Invalid fork name '${newName}' — must be a kebab-case slug (a-z, 0-9, -)`
    );
  }
  if (newName === name) {
    throw new ShapeForkConflictError(`Fork name must differ from the source Shape '${name}'`);
  }

  const targetRoot = path.join(deps.dorkHome, 'shapes', newName);
  if (await pathExists(targetRoot)) {
    throw new ShapeForkConflictError(`A Shape named '${newName}' already exists`);
  }

  // Derive the lineage source label from install provenance (falls back to
  // 'local' for a directly-installed / hand-authored Shape).
  const metadata = await readInstallMetadata(sourceRoot);
  const source = metadata?.installedFrom ?? 'local';
  const forkedFrom = `${name}@${source}`;

  // Build the forked manifest: rewrite name, stamp lineage, and — when forking
  // the ACTIVE Shape with captureCurrent — snapshot the live arrangement.
  // (Q2: schedules are carried from the source manifest unchanged — only
  // Shape-originated schedules, never live tasks vacuumed from elsewhere.)
  const shouldCapture = opts.captureCurrent === true && deps.getActiveShape?.() === name;
  const forkedManifest: ShapePackageManifest = {
    ...sourceManifest,
    name: newName,
    lineage: {
      forkedFrom,
      forkedFromVersion: sourceManifest.version,
      forkedAt: new Date().toISOString(),
    },
    ...(shouldCapture
      ? captureCurrentFields(sourceManifest, deps.getEnabledExtensions?.() ?? [], opts.liveLayout)
      : {}),
  };

  // Re-validate through the union so a fork can never write an invalid manifest.
  const validated = MarketplacePackageManifestSchema.parse(forkedManifest) as ShapePackageManifest;

  const result = await runTransaction<ForkShapeResult>({
    name: `fork-shape-${newName}`,
    target: targetRoot,
    stage: async (staging) => {
      // Clone the source tree (symlinks stripped), then overwrite the manifest
      // with the forked one. Reading the source never mutates it.
      await stagePackageContents(sourceRoot, staging.path, deps.logger);
      await writeFile(
        path.join(staging.path, '.dork', 'manifest.json'),
        JSON.stringify(validated, null, 2) + '\n',
        'utf-8'
      );
      await rewritePluginManifestName(staging.path, newName, deps.logger);
    },
    activate: async (staging) => {
      await mkdir(path.dirname(targetRoot), { recursive: true });
      await atomicMove(staging.path, targetRoot);
      return {
        ok: true,
        name: newName,
        forkedFrom,
        installPath: targetRoot,
        manifest: validated,
      };
    },
  });

  return result;
}

/**
 * Read + parse an installed Shape's manifest through the union. Returns `null`
 * when the file is missing, unreadable, unparseable, or not a Shape.
 *
 * @param manifestPath - Absolute path to a `.dork/manifest.json`.
 * @returns The parsed Shape manifest, or `null`.
 */
async function readShapeManifest(manifestPath: string): Promise<ShapePackageManifest | null> {
  try {
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = MarketplacePackageManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.type !== 'shape') return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/**
 * The subset of `candidates` that appears in the `enabled` list, order
 * preserved. Used to snapshot the currently-enabled extensions among a Shape's
 * `activates` candidates.
 *
 * @param candidates - The Shape's declared `activates` ids.
 * @param enabled - Currently-enabled extension ids.
 * @returns The enabled candidates, in `candidates` order.
 */
function filterEnabled(candidates: string[], enabled: string[]): string[] {
  const set = new Set(enabled);
  return candidates.filter((id) => set.has(id));
}

/**
 * The capture-current-arrangement snapshot fields (spec §6.2):
 *
 * - `activates` narrows to the candidates currently enabled;
 * - `layout` takes the client's live chrome when supplied (the server cannot
 *   observe UI chrome on its own — until the client passes `liveLayout`, e.g.
 *   the Phase-3 switcher, the source manifest's layout is kept);
 * - `connections` drops every `extension-secret` whose target extension left
 *   the narrowed `activates` ∪ `extensions` set. Without this, cross-field
 *   rule 3 ("a secret must target an extension the Shape turns on") correctly
 *   refuses the forked manifest at the re-validate step — the narrowing must
 *   be mirrored onto connections, not discovered as a ZodError.
 *
 * @param source - The source Shape manifest.
 * @param enabledExtensions - Currently-enabled extension ids.
 * @param liveLayout - The client's live chrome, when the caller supplied it.
 * @returns The manifest fields to overlay for a capture-current fork.
 */
function captureCurrentFields(
  source: ShapePackageManifest,
  enabledExtensions: string[],
  liveLayout: ShapeLayout | undefined
): Pick<ShapePackageManifest, 'activates' | 'layout' | 'connections'> {
  const activates = filterEnabled(source.activates, enabledExtensions);
  const stillEnabled = new Set([...activates, ...source.extensions]);
  return {
    activates,
    layout: liveLayout ?? source.layout,
    connections: source.connections.filter(
      (c) => c.kind !== 'extension-secret' || stillEnabled.has(c.extension)
    ),
  };
}

/**
 * Best-effort rewrite of the forked package's `.claude-plugin/plugin.json`
 * `name` so it matches the new Shape name. A missing or malformed plugin
 * manifest is left alone — it is not load-bearing for the fork.
 *
 * @param root - Staged package root.
 * @param newName - The fork's name.
 * @param logger - Logger for diagnostics.
 */
async function rewritePluginManifestName(
  root: string,
  newName: string,
  logger: Logger
): Promise<void> {
  const pluginManifestPath = path.join(root, '.claude-plugin', 'plugin.json');
  try {
    const raw = await readFile(pluginManifestPath, 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    parsed.name = newName;
    await writeFile(pluginManifestPath, JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  } catch {
    logger.warn(`[fork-shape] No plugin.json to rewrite for '${newName}' (non-fatal)`);
  }
}

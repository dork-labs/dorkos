/**
 * Manifest reader/writer for agent `.dork/agent.json` files.
 *
 * Provides atomic file writing (temp file + rename) and Zod-validated
 * reading of agent manifests stored in project directories.
 *
 * @module shared/manifest
 */
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { AgentManifestSchema, AgentWorkspaceBindingSchema } from './mesh-schemas.js';
import { CONVENTION_DIR } from './convention-files.js';
import type { AgentManifest } from './mesh-schemas.js';
import type { Logger } from './logger.js';

/**
 * The agent directory, re-exported under the name most of the codebase uses.
 * The value is owned by `./convention-files.js`, which is browser-safe.
 */
export const MANIFEST_DIR = CONVENTION_DIR;
export const MANIFEST_FILE = 'agent.json';

/**
 * Read and validate an agent manifest from a project directory.
 *
 * The return contract is `null` for both "no manifest here" and "manifest
 * present but invalid" so callers can treat a directory as un-agented either
 * way. The two cases differ operationally, though: a missing file is the
 * common, expected case and stays silent, while a present-but-invalid file is
 * a divergent on-disk state (a schema-invalid manifest `safeParse`s to `null`
 * forever) — so it is logged with the offending path and issues.
 *
 * @param projectPath - Project directory containing `.dork/agent.json`
 * @param logger - Warn sink for present-but-invalid manifests (defaults to `console`)
 * @returns Parsed manifest, or `null` if the file doesn't exist or fails validation
 */
export async function readManifest(
  projectPath: string,
  logger: Pick<Logger, 'warn'> = console
): Promise<AgentManifest | null> {
  const manifestPath = path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE);

  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch {
    // Missing or unreadable file — the expected "not an agent" case. Silent.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    logger.warn(
      `[manifest] ${manifestPath} contains invalid JSON: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return null;
  }

  const result = AgentManifestSchema.safeParse(parsed);
  if (!result.success) {
    logger.warn(
      `[manifest] ${manifestPath} failed schema validation: ${JSON.stringify(result.error.issues)}`
    );
    return null;
  }
  warnIfBindingDegraded(parsed, manifestPath, logger);
  return result.data;
}

/**
 * Say so when a `workspace` binding was read as `home` because it could not be
 * read as itself.
 *
 * The degradation lives on the schema (`.catch()`), and it has to be a STATIC
 * value there — a function catch breaks JSON Schema generation for every MCP
 * tool that embeds the manifest. So the schema cannot speak, and this does:
 * degrading is fine, degrading QUIETLY is not. A binding nobody can parse is
 * either a typo somebody needs to hear about or a mode written by a newer build,
 * and both are worth one line rather than an agent that appears to have a
 * preference it does not have.
 *
 * An ABSENT `workspace` key is not a degradation — it is the migration
 * guarantee, and it is silent.
 *
 * @param raw - The manifest as parsed from JSON, before schema coercion.
 * @param manifestPath - Path to name in the warning.
 * @param logger - Warn sink.
 */
function warnIfBindingDegraded(
  raw: unknown,
  manifestPath: string,
  logger: Pick<Logger, 'warn'>
): void {
  if (raw === null || typeof raw !== 'object') return;
  const declared = (raw as { workspace?: unknown }).workspace;
  if (declared === undefined) return;
  if (AgentWorkspaceBindingSchema.safeParse(declared).success) return;
  logger.warn(
    `[manifest] ${manifestPath} has a workspace binding this build cannot read; ` +
      `running the agent in its own folder instead: ${JSON.stringify(declared)}`
  );
}

/**
 * What a directory has to say about the manifest it holds, with every failure
 * kept apart from every other.
 *
 * - `absent` — there is demonstrably no manifest here (`ENOENT`/`ENOTDIR`).
 * - `unreadable` — a manifest may well be here and we could not read it: a
 *   permission drop, an I/O error, a descriptor limit, a `.dork/agent.json`
 *   that is a DIRECTORY (`EISDIR`), invalid JSON, a body that fails the schema.
 *   `detail` carries the errno, the parse error, or the schema issues, so one
 *   log line can name what is actually wrong.
 * - `present` — read and validated; `id` is the manifest's ULID.
 */
export type ManifestProbe =
  { state: 'absent' } | { state: 'unreadable'; detail: string } | { state: 'present'; id: string };

/**
 * Ask a directory whether it still holds a manifest, **without collapsing
 * "gone" into "could not tell"**.
 *
 * {@link readManifest} answers `null` to both, which is right for its callers —
 * a directory you cannot read is not an agent you can import. It is wrong for
 * the one caller that has to decide whether an id has been GIVEN UP: treating a
 * transient `EACCES` as "gone" would hand a live agent's identity to a duplicate
 * checkout permanently, and the guard that reads this would then refuse the true
 * owner's return (ADR 260801-003050). So the two cases get two answers here, and
 * only `absent` may be read as "the incumbent released this".
 *
 * @param projectPath - Project directory that may contain `.dork/agent.json`.
 * @returns Which of the three states the directory is in.
 */
export async function probeManifest(projectPath: string): Promise<ManifestProbe> {
  const manifestPath = path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE);

  let content: string;
  try {
    content = await fs.readFile(manifestPath, 'utf-8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: no such file. ENOTDIR: a path component is not a directory, which
    // is the same fact arrived at one level up. Everything else — EACCES, EIO,
    // EMFILE, ELOOP — means the file may be sitting right there.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { state: 'absent' };
    return { state: 'unreadable', detail: code ?? (err as Error).message };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    return { state: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
  }

  const result = AgentManifestSchema.safeParse(parsed);
  if (!result.success) {
    return { state: 'unreadable', detail: JSON.stringify(result.error.issues) };
  }
  return { state: 'present', id: result.data.id };
}

/**
 * Write an agent manifest to a project directory atomically.
 *
 * Creates the `.dork/` directory if it doesn't exist. Writes to a temp
 * file first, then atomically renames to `agent.json` to prevent partial
 * writes from corrupting the manifest.
 *
 * Validates `manifest` against {@link AgentManifestSchema} before touching the
 * filesystem — persisting a schema-invalid manifest would make {@link readManifest}
 * `safeParse` it to `null` forever, so the write is rejected up front with a
 * clear error rather than leaving a permanently unreadable file on disk.
 *
 * @param projectPath - Project directory to write `.dork/agent.json` into
 * @param manifest - The agent manifest to write
 * @throws Error when `manifest` fails schema validation
 */
export async function writeManifest(projectPath: string, manifest: AgentManifest): Promise<void> {
  const dorkDir = path.join(projectPath, MANIFEST_DIR);
  const manifestPath = path.join(dorkDir, MANIFEST_FILE);

  const validation = AgentManifestSchema.safeParse(manifest);
  if (!validation.success) {
    throw new Error(
      `Refusing to write invalid agent manifest to ${manifestPath}: ${JSON.stringify(
        validation.error.issues
      )}`
    );
  }

  await fs.mkdir(dorkDir, { recursive: true });

  const tempPath = path.join(dorkDir, `.agent-${randomUUID()}.tmp`);

  const content = JSON.stringify(manifest, null, 2) + '\n';
  try {
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, manifestPath);
  } catch (err) {
    // A write that runs out of disk, or a rename that cannot land, leaves the
    // temp file behind. Clean it up so a failure never strands a stray
    // dot-file in the user's `.dork/` for them to find and wonder about.
    try {
      await fs.rm(tempPath, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/**
 * Remove the agent manifest file from a project directory.
 *
 * @param projectPath - Absolute path to the agent's project directory
 */
export async function removeManifest(projectPath: string): Promise<void> {
  try {
    await fs.unlink(path.join(projectPath, MANIFEST_DIR, MANIFEST_FILE));
  } catch {
    // Best-effort cleanup — ignore if file already gone
  }
}

/**
 * Remove the entire `.dork` directory for an agent project.
 *
 * @param projectPath - Absolute path to the project directory
 * @returns List of deleted file paths relative to the project root
 */
export async function removeDorkDirectory(projectPath: string): Promise<string[]> {
  const dorkPath = path.join(projectPath, MANIFEST_DIR);

  const stat = await fs.stat(dorkPath).catch(() => null);
  if (!stat?.isDirectory()) return [];

  const entries = await fs.readdir(dorkPath, { recursive: true });

  await fs.rm(dorkPath, { recursive: true, force: true });

  return entries.map((e) => path.join(MANIFEST_DIR, String(e)));
}

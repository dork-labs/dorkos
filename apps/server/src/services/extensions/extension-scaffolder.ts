/**
 * Scaffolds new extension directories with manifest, starter code, and optional server.ts.
 *
 * Used by {@link ExtensionManager.createExtension} and the MCP `create_extension` tool.
 *
 * @module services/extensions/extension-scaffolder
 */
import fs from 'fs/promises';
import path from 'path';
import { EXTENSION_ID_REGEX } from '@dorkos/extension-api';
import {
  generateManifest,
  generateTemplate,
  generateServerTemplate,
} from './extension-templates.js';
import type { ExtensionTemplate } from './extension-templates.js';
import type { CreateExtensionResult } from './extension-manager-types.js';

/**
 * Resolve an extension name to a directory sitting directly inside `root`.
 *
 * The name is also a path segment, so a name like `../../evil` would otherwise
 * write outside the extensions folder. {@link EXTENSION_ID_REGEX} already rules
 * that out, and this second check confirms it against the resolved path: the
 * result must be a direct child of the root, which no escape and no nested path
 * can satisfy.
 *
 * @param root - Directory that must contain the extension
 * @param name - Extension name, used as the directory name
 * @returns Absolute path of the extension directory
 * @throws Error when the name does not resolve to a direct child of `root`
 */
function resolveExtensionDir(root: string, name: string): string {
  const resolvedRoot = path.resolve(root);
  const targetDir = path.resolve(resolvedRoot, name);

  if (path.dirname(targetDir) !== resolvedRoot) {
    throw new Error(
      `Invalid extension name '${name}': an extension must be created directly inside ${resolvedRoot}`
    );
  }

  return targetDir;
}

/**
 * Whether `dir` exists, as a plain yes/no.
 *
 * Replaces the `fs.access` + throw-and-catch dance this file used to run inline,
 * which threw the "already exists" error INSIDE its own `try` and then had to
 * recognise its own message in the `catch` to avoid swallowing it. That worked
 * for one path and does not generalise to the two this now checks.
 *
 * Any error other than "not there" answers `true`: a directory this process
 * cannot stat is not a directory it may scaffold over.
 *
 * @param dir - Absolute path to test.
 */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    await fs.access(dir);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
  }
}

/**
 * Scaffold a new extension directory with manifest and starter code.
 *
 * @param options - Creation parameters
 * @param dorkHome - Resolved DorkOS data directory
 * @param currentCwd - Active working directory (required for local scope)
 * @returns Created extension info (status/bundleReady populated by caller after enable)
 */
export async function scaffoldExtension(options: {
  name: string;
  description?: string;
  template: ExtensionTemplate;
  scope: 'global' | 'local';
  dorkHome: string;
  currentCwd: string | null;
}): Promise<{ targetDir: string; files: string[] }> {
  const { name, description, template, scope, dorkHome, currentCwd } = options;

  // The name becomes a directory name, so it is checked before it is used as
  // one. Anything with a dot, a slash, or a non-ASCII character is refused.
  if (!EXTENSION_ID_REGEX.test(name)) {
    throw new Error(
      `Invalid extension name '${name}': use lowercase letters, numbers, and hyphens only`
    );
  }

  // Resolve target directory
  const globalRoot = path.join(dorkHome, 'extensions');
  const localRoot = currentCwd ? path.join(currentCwd, '.dork', 'extensions') : null;

  let extensionsRoot: string;
  if (scope === 'local') {
    if (!localRoot) {
      throw new Error('Cannot create local extension: no working directory is active');
    }
    extensionsRoot = localRoot;
  } else {
    extensionsRoot = globalRoot;
  }
  const targetDir = resolveExtensionDir(extensionsRoot, name);

  // The id must be free in BOTH roots, not merely in the one this scope writes
  // to (DOR-1507). `scope` comes from the CALLER — it is an argument of the
  // `create_extension` MCP tool, which is tier `act` and shows no approval card
  // — so a per-scope check is a check the caller chooses the outcome of: ask for
  // the scope the name is free in and the collision is never seen.
  //
  // Two things went wrong with that, and neither is theoretical — both were
  // reproduced:
  //
  //  1. **Re-arm.** A person approves `foo`, then turns it off. An agent
  //     scaffolds `foo` in the OTHER scope; `createExtension` enables the id it
  //     was given, and the person's own approved server half starts again. The
  //     planted copy does not even have to win discovery for this to work — the
  //     write to `extensions.enabled` is the whole effect.
  //  2. **Squat.** The discovery merge ignores a project copy whose id is core
  //     or currently approved (`extension-discovery.ts`) — but that guard is
  //     conditional on the very approval it protects. Once the person REVOKES,
  //     the id is no longer approved, the planted local copy wins the merge, and
  //     a person who later re-approves the name they recognise approves the
  //     agent's code instead. That is the "different code under a familiar name"
  //     trap `forgetRunApproval` exists to close on the uninstall path, reached
  //     by another road.
  //
  // Refusing the collision at the root closes both, and costs nothing real: a
  // project copy that OVERRIDES a global extension is still supported and is
  // what the local scope is for — it is authored, or copied, or installed. This
  // refuses only minting a fresh template over a name already spoken for, which
  // was never a way to produce a useful override anyway.
  // The target scope first, so a same-scope collision keeps naming its own path.
  const rootsToCheck = [extensionsRoot];
  const otherRoot = scope === 'local' ? globalRoot : localRoot;
  // Skipped when the two resolve to one directory — the working directory IS the
  // DorkOS home, which `extension-discovery.ts` handles for the same reason
  // (DOR-1336). Checking it twice would only repeat the same answer.
  if (otherRoot && path.resolve(otherRoot) !== path.resolve(extensionsRoot)) {
    rootsToCheck.push(otherRoot);
  }

  for (const root of rootsToCheck) {
    const candidate = resolveExtensionDir(root, name);
    if (await directoryExists(candidate)) {
      throw new Error(`Extension '${name}' already exists at ${candidate}`);
    }
  }

  // Create directory and write files
  await fs.mkdir(targetDir, { recursive: true });

  const manifest = generateManifest(name, description, template);
  await fs.writeFile(
    path.join(targetDir, 'extension.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );

  const indexContent = generateTemplate(name, description ?? '', template);
  await fs.writeFile(path.join(targetDir, 'index.ts'), indexContent, 'utf-8');

  const files = ['extension.json', 'index.ts'];
  if (template === 'data-provider') {
    const serverContent = generateServerTemplate(name, description ?? '');
    await fs.writeFile(path.join(targetDir, 'server.ts'), serverContent, 'utf-8');
    files.push('server.ts');
  }

  return { targetDir, files };
}

/**
 * Build a {@link CreateExtensionResult} from the scaffolded extension and its post-enable state.
 *
 * @param scaffoldResult - Output from {@link scaffoldExtension}
 * @param options - Original creation options
 * @param record - The extension record after enable (may be undefined if enable failed)
 */
export function buildCreateResult(
  scaffoldResult: { targetDir: string; files: string[] },
  options: { name: string; template: ExtensionTemplate; scope: 'global' | 'local' },
  record:
    | {
        status: string;
        bundleReady: boolean;
        error?: { code: string; message: string; details?: string };
      }
    | undefined
): CreateExtensionResult {
  const result: CreateExtensionResult = {
    id: options.name,
    path: scaffoldResult.targetDir,
    scope: options.scope,
    template: options.template,
    status: (record?.status as CreateExtensionResult['status']) ?? 'compile_error',
    bundleReady: record?.bundleReady ?? false,
    files: scaffoldResult.files,
  };

  if (record?.error) {
    result.error = {
      code: record.error.code,
      message: record.error.message,
      ...(record.error.details && {
        errors: record.error.details.split('\n').map((text) => ({ text })),
      }),
    };
  }

  return result;
}

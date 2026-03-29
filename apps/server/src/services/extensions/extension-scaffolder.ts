/**
 * Scaffolds new extension directories with manifest, starter code, and optional server.ts.
 *
 * Used by {@link ExtensionManager.createExtension} and the MCP `create_extension` tool.
 *
 * @module services/extensions/extension-scaffolder
 */
import fs from 'fs/promises';
import path from 'path';
import {
  generateManifest,
  generateTemplate,
  generateServerTemplate,
} from './extension-templates.js';
import type { ExtensionTemplate } from './extension-templates.js';
import type { CreateExtensionResult } from './extension-manager-types.js';

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

  // Resolve target directory
  let targetDir: string;
  if (scope === 'local') {
    if (!currentCwd) {
      throw new Error('Cannot create local extension: no working directory is active');
    }
    targetDir = path.join(currentCwd, '.dork', 'extensions', name);
  } else {
    targetDir = path.join(dorkHome, 'extensions', name);
  }

  // Check directory does not exist
  try {
    await fs.access(targetDir);
    throw new Error(`Extension '${name}' already exists at ${targetDir}`);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) throw err;
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

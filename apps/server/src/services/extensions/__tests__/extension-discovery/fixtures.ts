import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import { installFolderDigest } from '../../../marketplace/lib/install-digest.js';
import type { CoreExtensionInfo, ExtensionsConfig } from '../../extension-enable-resolution.js';

/** No user overrides. */
export const EMPTY_CONFIG: ExtensionsConfig = { enabled: [], disabled: [], approvedToRun: [] };
/** No core extensions (everything resolves to origin 'user'). */
export const EMPTY_CORE = new Map<string, CoreExtensionInfo>();

/** Build a core-extension tier map from a list of infos. */
export function coreMap(...infos: CoreExtensionInfo[]): Map<string, CoreExtensionInfo> {
  return new Map(infos.map((i) => [i.id, i]));
}

/** Write a valid extension manifest to the given directory. */
export async function writeManifest(dir: string, manifest: Record<string, unknown>): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'extension.json'), JSON.stringify(manifest));
}

/** The whole-folder digest the installer records, as a string. */
export async function digestOf(root: string): Promise<string> {
  const found = await installFolderDigest(root);
  if (found.kind !== 'digest') throw new Error(`no digest for ${root}: ${found.kind}`);
  return found.digest;
}

/** A fresh temp tree with an empty `{dorkHome}/extensions` and a discovery over it. */
export async function makeDiscoveryHome(): Promise<{
  tmpDir: string;
  dorkHome: string;
  discovery: ExtensionDiscovery;
}> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ext-discovery-'));
  const dorkHome = path.join(tmpDir, '.dork');
  await fs.mkdir(path.join(dorkHome, 'extensions'), { recursive: true });
  return { tmpDir, dorkHome, discovery: new ExtensionDiscovery(dorkHome) };
}

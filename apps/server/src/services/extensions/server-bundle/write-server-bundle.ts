/**
 * Write a compiled server bundle to disk before either way of starting it
 * (in-process or in its own process) reads it.
 *
 * @module services/extensions/server-bundle/write-server-bundle
 */
import fs from 'fs/promises';
import path from 'path';

/**
 * Write a compiled server bundle to `cache/extensions/server/_run/<id>.js`,
 * so stack traces and source maps name a real file.
 *
 * @param dorkHome - DorkOS's data directory.
 * @param id - The extension id.
 * @param code - The compiled bundle.
 * @returns The bundle's path.
 */
export async function writeServerBundle(
  dorkHome: string,
  id: string,
  code: string
): Promise<string> {
  const dir = path.join(dorkHome, 'cache', 'extensions', 'server', '_run');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.js`);
  await fs.writeFile(file, code, 'utf-8');
  return file;
}

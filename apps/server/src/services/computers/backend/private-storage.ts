import { mkdir, lstat, chmod, realpath, open, rename } from 'node:fs/promises';
import { resolve, parse, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Refuse symbolic-link ancestors before creating private managed storage. */
export async function privateDirectory(path: string): Promise<void> {
  if (!path.startsWith('/') || resolve(path) !== path)
    throw new Error('Computer storage must be canonical');
  let current = parse(path).root;
  for (const part of path.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe computer storage');
  }
  const rootStat = await lstat(path);
  if (rootStat.uid !== process.getuid?.()) throw new Error('Foreign computer storage owner');
  if ((await realpath(path)) !== path) throw new Error('Unsafe computer storage');
  await chmod(path, 0o700);
}
/** Publish a private file atomically without following an existing symbolic link. */
export async function writePrivate(path: string, content: string): Promise<void> {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe computer file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

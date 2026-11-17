/** Test-only source coverage for the manage-credential boundary. */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** The original serial traversal: only real test/dependency directories are excluded. */
export async function sourceFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'node_modules') {
        files.push(...(await sourceFiles(path)));
      }
    } else if (/\.tsx?$/u.test(entry.name)) files.push(path);
  }
  return files;
}

/** Read at most eight sources, in input order, draining failures before throwing. */
export async function readSourcesInOrder<T>(
  files: readonly string[],
  read: (file: string) => Promise<T>
): Promise<T[]> {
  const results: ({ ok: true; value: T } | { ok: false; error: unknown })[] = new Array(
    files.length
  );
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++;
      if (index >= files.length) return;
      try {
        results[index] = { ok: true, value: await read(files[index]) };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(8, files.length) }, () => worker()));
  return results.map((result) => {
    if (!result.ok) throw result.error;
    return result.value;
  });
}

/** Raw text deliberately includes comments, just as the original credential guard did. */
export async function credentialReach(
  root: string,
  files: readonly string[],
  read: (file: string) => Promise<string> = (file) => readFile(file, 'utf8')
): Promise<{ module: string[]; accessor: string[] }> {
  const reach = {
    module: /administer-credentials(\.js)?['"]/u,
    accessor: /\bgetRemoteAdministerCredentials\b/u,
  };
  const texts = await readSourcesInOrder(files, read);
  const found: Record<keyof typeof reach, string[]> = { module: [], accessor: [] };
  for (let index = 0; index < files.length; index++) {
    for (const key of ['module', 'accessor'] as const) {
      if (reach[key].test(texts[index])) found[key].push(relative(root, files[index]));
    }
  }
  return found;
}

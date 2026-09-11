import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Run with an isolated copied login, removing it even when setup or the child fails. */
export async function withAccountsHome<T>(
  auth: string,
  action: (root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'dorkos-codex-accounts-'));
  try {
    const home = join(root, 'private/codex');
    await mkdir(home, { recursive: true, mode: 0o700 });
    await writeFile(join(home, 'auth.json'), auth, { mode: 0o600, flag: 'wx' });
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Abort the owned turn and wait for its iterator/SDK child to drain before exit. */
export async function drainAccountsTurn(
  stop: () => Promise<void>,
  active: Promise<void> | undefined
): Promise<void> {
  await stop();
  if (!active) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      active.catch(() => undefined),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Owned Codex turn did not drain after cancellation.')),
          15_000
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

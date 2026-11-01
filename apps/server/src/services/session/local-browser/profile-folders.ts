/** Where each Agent browser profile keeps its sign-ins. */
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

const BINDING_KEY_BYTES = 32;

/**
 * Read the key browser profile bindings are signed with, making it the first
 * time. It sits in the denied profiles folder, so no agent file tool can reach it.
 * A key that is gone or the wrong size is replaced, which voids every binding:
 * a person adds them again, and nothing opens by accident.
 *
 * @param dataDirectory - The DorkOS data folder.
 */
export function loadProfileBindingKey(dataDirectory: string): Buffer {
  const root = path.join(dataDirectory, 'browser-profiles');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  chmodSync(root, 0o700);
  const file = path.join(root, '.binding-key');
  try {
    const key = readFileSync(file);
    if (key.length === BINDING_KEY_BYTES) {
      chmodSync(file, 0o600);
      return key;
    }
  } catch {
    // No key yet: make one below.
  }
  const key = randomBytes(BINDING_KEY_BYTES);
  writeFileSync(file, key, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

const exists = (target: string) =>
  stat(target).then(
    () => true,
    () => false
  );

/**
 * Make a profile's folder under the one folder agent runs are denied, and give
 * it the sign-ins an older DorkOS saved when it's the default profile.
 *
 * @param dataDirectory - The DorkOS data folder.
 * @param profileId - A server-chosen profile id, or null for the default profile.
 * @returns The folder for the browser to use.
 */
export async function prepareProfileFolder(
  dataDirectory: string,
  profileId: string | null
): Promise<string> {
  const root = path.join(dataDirectory, 'browser-profiles');
  await mkdir(root, { recursive: true, mode: 0o700 });
  // mkdir's mode doesn't change a folder that already exists.
  await chmod(root, 0o700);
  const folder = path.join(root, profileId ?? 'default');
  if (profileId === null && !(await exists(folder))) {
    const older = path.join(dataDirectory, 'local-browser', 'saved-logins');
    // Same volume, so sign-ins move whole or not at all. No browser is open here.
    if (await exists(older)) await rename(older, folder);
  }
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
  return folder;
}

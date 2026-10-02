import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Identify a directly executed module through filesystem and symlink path aliases. */
export function isEntrypoint(moduleUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}

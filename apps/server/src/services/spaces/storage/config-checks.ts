/** Startup checks on where the Community keeps files: folder overlap and S3 endpoint shape. */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * A path with every symbolic link resolved, for as much of it as exists, so `/tmp/x` and
 * `/private/tmp/x` compare equal on a host where one links to the other.
 */
function realPath(path: string): string {
  const absolute = resolve(path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest.reverse());
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.push(basename(existing));
      existing = parent;
    }
  }
}

/** Whether `child` is `parent` or sits anywhere inside it. */
function within(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/** Whether two directories are the same, or one contains the other. */
export function directoriesOverlap(a: string, b: string): boolean {
  for (const left of new Set([resolve(a), realPath(a)])) {
    for (const right of new Set([resolve(b), realPath(b)])) {
      if (within(left, right) || within(right, left)) return true;
    }
  }
  return false;
}

/** Refuse an S3 endpoint that is not HTTPS (or HTTP on localhost) or that carries credentials. */
export function checkS3Endpoint(name: string, value: string | undefined): void {
  if (!value) return;
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' &&
    !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(endpoint.hostname))
  ) {
    throw new Error(`${name} must use HTTPS, or HTTP on localhost`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`${name} must not contain credentials`);
  }
}

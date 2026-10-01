/** Confined local app manifests and bounded compilation cache. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  CANVAS_APP_MANIFEST_BYTES,
  CompiledCanvasAppManifest,
  CanvasAppManifestError,
  canonicalCanvasAppJson,
  parseCanvasAppManifest,
} from '@dorkos/shared/canvas-app-manifest';

const MAX_COMPILED_MANIFESTS = 64;
const compiled = new Map<string, CompiledCanvasAppManifest>();

/** One validated local manifest with its exact authority digest. */
export interface DocAppManifest {
  hash: string;
  compiled: CompiledCanvasAppManifest;
}
function confined(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function absent(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function loadBytes(root: string): Buffer | undefined {
  const canonicalRoot = fs.realpathSync(root);
  const requested = path.join(canonicalRoot, '.dork', 'app.json');
  let canonicalFile: string;
  try {
    canonicalFile = fs.realpathSync(requested);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  if (!confined(canonicalRoot, canonicalFile))
    throw new CanvasAppManifestError('App manifest leaves its source directory.');
  const descriptor = fs.openSync(
    canonicalFile,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
  );
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > CANVAS_APP_MANIFEST_BYTES)
      throw new CanvasAppManifestError('App manifest must be a bounded regular file.');
    // Check the open handle as well as its pathname; a symlink changed between
    // realpath and open must not turn a confined name into another file.
    const current = fs.realpathSync(requested);
    const named = fs.statSync(current);
    if (!confined(canonicalRoot, current) || named.dev !== stat.dev || named.ino !== stat.ino)
      throw new CanvasAppManifestError('App manifest source changed during reading.');
    const buffer = Buffer.alloc(CANVAS_APP_MANIFEST_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(descriptor, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > CANVAS_APP_MANIFEST_BYTES)
      throw new CanvasAppManifestError('App manifest exceeds the byte limit.');
    return buffer.subarray(0, size);
  } finally {
    fs.closeSync(descriptor);
  }
}

/**
 * Read only `.dork/app.json` beneath a server-resolved local source root. Null
 * means no local source authority (for example a remote URL), never a URL to fetch.
 */
export function readDocAppManifest(sourceRoot: string | null): DocAppManifest | undefined {
  if (sourceRoot === null) return undefined;
  if (!path.isAbsolute(sourceRoot))
    throw new CanvasAppManifestError('App source root must be server-resolved.');
  const bytes = loadBytes(sourceRoot);
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CanvasAppManifestError('App manifest must be valid UTF-8 JSON.');
  }
  const manifest = parseCanvasAppManifest(value);
  const hash = createHash('sha256').update(canonicalCanvasAppJson(manifest)).digest('hex');
  let result = compiled.get(hash);
  if (!result) {
    result = new CompiledCanvasAppManifest(manifest);
    if (compiled.size >= MAX_COMPILED_MANIFESTS) compiled.delete(compiled.keys().next().value!);
    compiled.set(hash, result);
  }
  return { hash, compiled: result };
}

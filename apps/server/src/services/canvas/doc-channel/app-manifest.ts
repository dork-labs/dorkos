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

// Capture original filesystem effects before returning any reader or compiled manifest.
const originalRealpath = fs.realpathSync,
  originalOpen = fs.openSync,
  originalFstat = fs.fstatSync,
  originalStat = fs.statSync,
  originalRead = fs.readSync,
  originalClose = fs.closeSync;
const originalIsFile = fs.Stats.prototype.isFile;
const originalReadFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
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
type ManifestReadOwner = { closeFailure?: { cause: unknown } };
function loadBytes(root: string, owner?: ManifestReadOwner): Buffer | undefined {
  const canonicalRoot = originalRealpath(root);
  const requested = path.join(canonicalRoot, '.dork', 'app.json');
  let canonicalFile: string;
  try {
    canonicalFile = originalRealpath(requested);
  } catch (error) {
    if (absent(error)) return undefined;
    throw error;
  }
  if (!confined(canonicalRoot, canonicalFile))
    throw new CanvasAppManifestError('App manifest leaves its source directory.');
  const descriptor = originalOpen(canonicalFile, originalReadFlags);
  let failed = false,
    first: unknown,
    result: Buffer | undefined;
  try {
    const stat = originalFstat(descriptor);
    if (!Reflect.apply(originalIsFile, stat, []) || stat.size > CANVAS_APP_MANIFEST_BYTES)
      throw new CanvasAppManifestError('App manifest must be a bounded regular file.');
    // Check the open handle as well as its pathname; a symlink changed between
    // realpath and open must not turn a confined name into another file.
    const current = originalRealpath(requested);
    const named = originalStat(current);
    if (!confined(canonicalRoot, current) || named.dev !== stat.dev || named.ino !== stat.ino)
      throw new CanvasAppManifestError('App manifest source changed during reading.');
    const buffer = Buffer.alloc(CANVAS_APP_MANIFEST_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = originalRead(descriptor, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > CANVAS_APP_MANIFEST_BYTES)
      throw new CanvasAppManifestError('App manifest exceeds the byte limit.');
    result = buffer.subarray(0, size);
  } catch (cause) {
    failed = true;
    first = cause;
  } finally {
    try {
      originalClose(descriptor);
    } catch (cause) {
      if (owner && !owner.closeFailure) owner.closeFailure = { cause };
      if (!failed) {
        failed = true;
        first = cause;
      }
    }
  }
  if (failed) throw first;
  return result;
}

/**
 * Read only `.dork/app.json` beneath a server-resolved local source root. Null
 * means no local source authority (for example a remote URL), never a URL to fetch.
 */
export function readDocAppManifest(sourceRoot: string | null): DocAppManifest | undefined {
  if (sourceRoot === null) return undefined;
  if (!path.isAbsolute(sourceRoot))
    throw new CanvasAppManifestError('App source root must be server-resolved.');
  return compileBytes(loadBytes(sourceRoot));
}
function compileBytes(bytes: Buffer | undefined, fresh = false): DocAppManifest | undefined {
  if (!bytes) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new CanvasAppManifestError('App manifest must be valid UTF-8 JSON.');
  }
  const manifest = parseCanvasAppManifest(value);
  const hash = createHash('sha256').update(canonicalCanvasAppJson(manifest)).digest('hex');
  let result = fresh ? undefined : compiled.get(hash);
  if (!result) {
    result = new CompiledCanvasAppManifest(manifest);
    if (!fresh) {
      if (compiled.size >= MAX_COMPILED_MANIFESTS) compiled.delete(compiled.keys().next().value!);
      compiled.set(hash, result);
    }
  }
  return { hash, compiled: result };
}

/** Actual reader owns its acquired manifest FD; callers supply root DATA, never a checker. */
export function createOriginalDocAppManifestReader() {
  const owner: ManifestReadOwner = {};
  return Object.freeze({
    read(sourceRoot: string | null): DocAppManifest | undefined {
      if (owner.closeFailure) throw owner.closeFailure.cause;
      if (sourceRoot === null) return undefined;
      if (!path.isAbsolute(sourceRoot))
        throw new CanvasAppManifestError('App source root must be server-resolved.');
      return compileBytes(loadBytes(sourceRoot, owner));
    },
    /** Private callers can retain fresh validators without exposing the ordinary compilation cache. */
    readFresh(sourceRoot: string | null): DocAppManifest | undefined {
      if (owner.closeFailure) throw owner.closeFailure.cause;
      if (sourceRoot === null) return undefined;
      if (!path.isAbsolute(sourceRoot))
        throw new CanvasAppManifestError('App source root must be server-resolved.');
      return compileBytes(loadBytes(sourceRoot, owner), true);
    },
    requireClosed(): void {
      if (owner.closeFailure) throw owner.closeFailure.cause;
    },
  });
}

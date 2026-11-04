/** Crash-safe records of paths this server actually rendered as missing. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

/** Under an existing person-only write refusal, including at Full. */
export function mountTargetLedgerFile(data: string): string {
  return path.join(data, 'permissions', 'codex-mount-targets.json');
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Reject links, foreign owners and public ledger contents, rather than trusting them. */
function assertPrivateFile(stat: fs.Stats): void {
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.mode & 0o077)
    throw new Error('Codex cleanup records are not private files owned by this user.');
}

/** Reading never creates a ledger or its parent. */
export function readMountTargets(data: string): string[] {
  const file = mountTargetLedgerFile(data);
  try {
    const parent = fs.lstatSync(path.dirname(file));
    if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022)
      throw new Error('Codex cleanup folder is not owned by this user.');
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  let fd: number;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (missing(error)) return [];
    throw error;
  }
  try {
    assertPrivateFile(fs.fstatSync(fd));
    const record: unknown = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (
      !record ||
      typeof record !== 'object' ||
      !('version' in record) ||
      record.version !== 1 ||
      !('targets' in record) ||
      !Array.isArray(record.targets) ||
      !record.targets.every(
        (target: unknown) =>
          typeof target === 'string' &&
          path.isAbsolute(target) &&
          path.normalize(target) === target &&
          target !== path.parse(target).root &&
          !target.includes('\0') &&
          !/[*?[\]{}]/.test(target) &&
          target !== file &&
          !target.startsWith(path.dirname(file) + path.sep)
      )
    )
      throw new Error('Codex cleanup records are invalid.');
    return [...new Set(record.targets as string[])];
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomic replace, with the file and directory synced before any launch can continue. */
export function writeMountTargets(data: string, targets: readonly string[]): void {
  const file = mountTargetLedgerFile(data);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
    throw new Error('Codex cleanup folder is not owned by this user.');
  const temporary = path.join(dir, `.codex-mount-targets-${process.pid}-${randomUUID()}`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600
    );
    fs.writeFileSync(
      fd,
      JSON.stringify({ version: 1, targets: [...new Set(targets)].sort() }) + '\n'
    );
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const parent = fs.openSync(dir, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(parent);
    } finally {
      fs.closeSync(parent);
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

/** Called only with the collapse's captured missing literal targets, before loading. */
export function recordMountTargets(data: string, targets: readonly string[]): void {
  if (targets.length === 0) return;
  writeMountTargets(data, [...readMountTargets(data), ...targets]);
  // Validate our own persisted form before a launch can use it.
  readMountTargets(data);
}

/** Empty regular-file shape for protection rendering; this is NOT ownership proof for deletion. */
export function emptyOwnedMountTarget(file: string): fs.Stats | undefined {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size === 0 && stat.uid === process.getuid?.() && stat.nlink === 1
      ? stat
      : undefined;
  } catch (error) {
    if (missing(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Isolated durable bindings: persistence failures refuse rather than silently re-key. */
import {
  constants,
  fstatSync,
  readSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OpenCodeSessionMapStore } from '../sessions/session-mapper.js';
import { isRecord } from './wire.js';

type Binding = { sessionId: string; ocSessionId: string };
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const refuse = () => new Error('COMPUTER_SESSION_STORE_REFUSED');

/** Shared current-file schema for hydration and strict prepared observations. */
function parseRows(value: unknown): Binding[] {
  if (!Array.isArray(value) || value.length > 10000) throw refuse();
  const ids = new Set<string>();
  const nativeIds = new Set<string>();
  const result: Binding[] = [];
  const rows: unknown[] = value;
  for (const row of rows) {
    if (
      !isRecord(row) ||
      Object.keys(row).sort().join(',') !== 'ocSessionId,sessionId' ||
      typeof row.sessionId !== 'string' ||
      typeof row.ocSessionId !== 'string' ||
      ids.has(row.sessionId) ||
      nativeIds.has(row.ocSessionId)
    )
      throw refuse();
    ids.add(row.sessionId);
    nativeIds.add(row.ocSessionId);
    result.push({ sessionId: row.sessionId, ocSessionId: row.ocSessionId });
  }
  return result;
}

/** Persists this computer's one-to-one session ids independently of host sessions. */
export class ComputerSessionMap implements OpenCodeSessionMapStore {
  private readonly parentIdentity: { dev: number; ino: number };
  private rows: Binding[];
  constructor(private readonly path: string) {
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Error('COMPUTER_SESSION_STORE_REFUSED');
    this.parentIdentity = { dev: parent.dev, ino: parent.ino };
    try {
      this.checkFile();
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      this.rows = parseRows(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.rows = [];
    }
  }
  private checkFile(): void {
    const st = lstatSync(this.path);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.nlink !== 1 ||
      st.uid !== process.getuid?.() ||
      (st.mode & 0o777) !== 0o600 ||
      st.size > MAX_STORE_BYTES
    )
      throw new Error('COMPUTER_SESSION_STORE_REFUSED');
  }
  /** Strict live-file observation only for the prepared first-settings guard. */
  readBinding(sessionId: string): { ocSessionId: string } | null {
    const checkParent = () => {
      const parent = lstatSync(dirname(this.path));
      if (
        !parent.isDirectory() ||
        parent.isSymbolicLink() ||
        parent.uid !== process.getuid?.() ||
        (parent.mode & 0o777) !== 0o700 ||
        parent.dev !== this.parentIdentity.dev ||
        parent.ino !== this.parentIdentity.ino
      )
        throw refuse();
    };
    checkParent();
    if (
      typeof constants.O_NOFOLLOW !== 'number' ||
      !Number.isInteger(constants.O_NOFOLLOW) ||
      constants.O_NOFOLLOW === 0 ||
      typeof constants.O_NONBLOCK !== 'number' ||
      !Number.isInteger(constants.O_NONBLOCK) ||
      constants.O_NONBLOCK === 0
    )
      throw refuse();
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
      // Only an actual missing path under the original private parent proves absence.
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        checkParent();
        try {
          lstatSync(this.path);
        } catch (missing) {
          if (missing instanceof Error && 'code' in missing && missing.code === 'ENOENT')
            return null;
        }
      }
      throw refuse();
    }
    let failed = false;
    let answer: { ocSessionId: string } | null = null;
    try {
      const before = fstatSync(fd);
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.uid !== process.getuid?.() ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > MAX_STORE_BYTES
      )
        throw refuse();
      const bytes = Buffer.alloc(before.size + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      const after = fstatSync(fd);
      const current = lstatSync(this.path);
      checkParent();
      if (
        size !== before.size ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        after.mode !== before.mode ||
        after.uid !== before.uid ||
        current.nlink !== after.nlink ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== after.size ||
        current.mtimeMs !== after.mtimeMs ||
        current.ctimeMs !== after.ctimeMs ||
        current.mode !== after.mode ||
        current.uid !== after.uid ||
        after.nlink !== 1
      )
        throw refuse();
      const value: unknown = JSON.parse(bytes.subarray(0, size).toString('utf8'));
      const row = parseRows(value).find((binding) => binding.sessionId === sessionId);
      answer = row ? { ocSessionId: row.ocSessionId } : null;
    } catch {
      failed = true;
    }
    try {
      closeSync(fd);
    } catch {
      failed = true;
    }
    if (failed) throw refuse();
    return answer;
  }

  listAll(): { sessionId: string; ocSessionId: string }[] {
    return this.rows.map((row) => ({ ...row }));
  }
  bind(sessionId: string, ocSessionId: string): void {
    const rows = this.rows.filter(
      (row) => row.sessionId !== sessionId && row.ocSessionId !== ocSessionId
    );
    rows.push({ sessionId, ocSessionId });
    const temp = join(dirname(this.path), `.computer-sessions-${randomBytes(16).toString('hex')}`);
    try {
      try {
        this.checkFile();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      writeFileSync(temp, JSON.stringify(rows), { mode: 0o600, flag: 'wx' });
      const fd = openSync(temp, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, this.path);
      const directory = openSync(dirname(this.path), 'r');
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
      this.rows = rows;
    } finally {
      // A failed temporary cleanup must not replace the original persistence failure.
      try {
        unlinkSync(temp);
      } catch {
        /* Retain any inaccessible private temporary file. */
      }
    }
  }
}

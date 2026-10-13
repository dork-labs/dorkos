/** Isolated durable bindings: persistence failures refuse rather than silently re-key. */
import {
  lstatSync,
  readFileSync,
  writeFileSync,
  renameSync,
  openSync,
  fsyncSync,
  closeSync,
  unlinkSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { OpenCodeSessionMapStore } from '../sessions/session-mapper.js';

/** Persists this computer's one-to-one session ids independently of host sessions. */
export class ComputerSessionMap implements OpenCodeSessionMapStore {
  private rows: { sessionId: string; ocSessionId: string }[];
  constructor(private readonly path: string) {
    const parent = lstatSync(dirname(path));
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700
    )
      throw new Error('COMPUTER_SESSION_STORE_REFUSED');
    try {
      this.checkFile();
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !Array.isArray(value) ||
        value.length > 10000 ||
        value.some(
          (row) =>
            !row ||
            Object.keys(row).sort().join(',') !== 'ocSessionId,sessionId' ||
            typeof row.sessionId !== 'string' ||
            typeof row.ocSessionId !== 'string'
        ) ||
        new Set(value.map((row) => row.sessionId)).size !== value.length ||
        new Set(value.map((row) => row.ocSessionId)).size !== value.length
      ) {
        throw new Error('COMPUTER_SESSION_STORE_REFUSED');
      }
      this.rows = value;
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
      st.size > 2 * 1024 * 1024
    )
      throw new Error('COMPUTER_SESSION_STORE_REFUSED');
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

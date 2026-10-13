import { constants } from 'node:fs';
import { appendFile, lstat, mkdir, open, realpath, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

const recordSchema = z
  .object({
    id: z.string().uuid(),
    generation: z.number().int().nonnegative(),
    phase: z.enum([
      'missing',
      'provisioning',
      'starting',
      'ready',
      'stopping',
      'stopped',
      'failed',
      'uncertain',
    ]),
  })
  .strict();
/** Private persistent identity and last observed transition. */
export type ComputerRecord = z.infer<typeof recordSchema>;

/** Owner-only, non-symlink lifecycle record and append-only intent/outcome journal. */
export class ComputerStore {
  private publications: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}

  /** Check the directory rather than following a replacement symlink. */
  async guard(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid()) ||
      (await realpath(this.root)) !== this.root
    )
      throw new Error('COMPUTER_STORAGE_OWNERSHIP');
  }

  /** Read a retained identity; a malformed record is uncertainty, never a new computer. */
  async read(): Promise<ComputerRecord | null> {
    await this.guard();
    let file;
    try {
      file = await open(
        join(this.root, 'computer.json'),
        constants.O_RDONLY | constants.O_NOFOLLOW
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.size > 4096 ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('COMPUTER_RECORD_OWNERSHIP');
      return recordSchema.parse(JSON.parse(await file.readFile('utf8')));
    } finally {
      await file.close();
    }
  }

  /** Atomically retain a transition before or after external lifecycle entry. */
  write(record: ComputerRecord, event: string): Promise<void> {
    const parsed = recordSchema.parse(record);
    const publication = this.publications.then(() => this.publish(parsed, event));
    this.publications = publication.catch(() => undefined);
    return publication;
  }

  private async publish(parsed: ComputerRecord, event: string): Promise<void> {
    await this.guard();
    const temporary = join(this.root, `.computer-${randomUUID()}.json`);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600
    );
    try {
      await file.writeFile(JSON.stringify(parsed));
      await file.sync();
    } finally {
      await file.close();
    }
    await this.guard();
    await rename(temporary, join(this.root, 'computer.json'));
    const journal = await open(
      join(this.root, 'lifecycle.jsonl'),
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
      0o600
    );
    try {
      const stat = await journal.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())
      )
        throw new Error('COMPUTER_JOURNAL_OWNERSHIP');
      await appendFile(
        journal,
        JSON.stringify({ at: new Date().toISOString(), event, ...parsed }) + '\n'
      );
      await journal.sync();
    } finally {
      await journal.close();
    }
  }
}

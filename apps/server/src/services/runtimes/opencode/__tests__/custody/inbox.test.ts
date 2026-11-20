import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOwnedInbox, openOwnedInbox } from './inbox.js';
import { MAX_METADATA_BYTES } from './metadata.js';

const id = (number: number) => number.toString(16).padStart(32, '0');
const active = () => new AbortController().signal;

async function fixture<T>(work: (parent: string) => Promise<T>): Promise<T> {
  const parent = await mkdtemp(join(tmpdir(), 'dorkos-custody-test-'));
  try {
    return await work(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform === 'win32')('owner-private custody metadata inbox', () => {
  it('publishes exactly one private reply and never overwrites it', async () => {
    await fixture(async (parent) => {
      const main = await createOwnedInbox(parent);
      const worker = await openOwnedInbox(main.path);
      expect((await stat(main.path)).mode & 0o777).toBe(0o700);
      const number = id(1);
      const input = Buffer.from('metadata only');
      expect(await main.write('reply', number, input, active())).toBe(true);
      const file = join(main.path, `reply-${number}.json`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      await expect(
        main.write('reply', number, Buffer.from('replacement'), active())
      ).rejects.toThrow(/already published/);
      expect(await worker.readReply(number)).toEqual(input);
      expect(await readdir(main.path)).toEqual([`reply-${number}.json`]);
      const cancelled = new AbortController();
      cancelled.abort();
      expect(await main.write('reply', id(2), input, cancelled.signal)).toBe(false);
      expect(await worker.readReply(id(2))).toBeUndefined();
      await main.removeReply(number);
      expect(await worker.readReply(number)).toBeUndefined();
      await main.remove();
      expect(await readdir(parent)).toEqual([]);
    });
  });

  it('replaces only the exact ready bytes and fences cancellation', async () => {
    await fixture(async (parent) => {
      const inbox = await createOwnedInbox(parent);
      const request = id(3);
      const ready = Buffer.from('owned ready');
      const terminal = Buffer.from('owned terminal');
      await inbox.write('reply', request, ready, active());
      await expect(
        inbox.replaceReadyReply(request, Buffer.from('another ready'), terminal, active())
      ).rejects.toThrow(/no longer matches/);
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(
        inbox.replaceReadyReply(request, ready, terminal, cancelled.signal)
      ).resolves.toBe(false);
      expect(await inbox.readReply(request)).toEqual(ready);
      expect(await inbox.replaceReadyReply(request, ready, terminal, active())).toBe(true);
      expect(await inbox.readReply(request)).toEqual(terminal);
      expect(await readdir(inbox.path)).toEqual([`reply-${request}.json`]);
      await inbox.remove();
    });
  });

  it('bounds each sweep and ignores symlinks, hard links and oversized records', async () => {
    await fixture(async (parent) => {
      const inbox = await createOwnedInbox(parent);
      const outside = join(parent, 'outside');
      await writeFile(outside, 'untouched', { mode: 0o600 });
      await symlink(outside, join(inbox.path, `request-${id(1)}.json`));
      await link(outside, join(inbox.path, `request-${id(2)}.json`));
      await writeFile(
        join(inbox.path, `cancel-${id(3)}.json`),
        Buffer.alloc(MAX_METADATA_BYTES + 1),
        { mode: 0o600 }
      );
      await inbox.write('request', id(4), Buffer.from('request'), active());
      await inbox.write('cancel', id(5), Buffer.from('cancel'), active());
      const receive = vi.fn();
      for (let sweep = 0; sweep < 6; sweep++) {
        const before = receive.mock.calls.length;
        await inbox.take(1, receive);
        expect(receive.mock.calls.length - before).toBeLessThanOrEqual(1);
      }
      expect(receive).toHaveBeenCalledTimes(2);
      expect(receive).toHaveBeenCalledWith('request', id(4), Buffer.from('request'));
      expect(receive).toHaveBeenCalledWith('cancel', id(5), Buffer.from('cancel'));
      expect((await stat(outside)).nlink).toBe(1);
      await inbox.remove();
    });
  });

  it('refuses unsafe names, permission drift and replacement of an opened inbox', async () => {
    await fixture(async (parent) => {
      const inbox = await createOwnedInbox(parent);
      await expect(inbox.write('request', '../escape', Buffer.from('x'), active())).rejects.toThrow(
        /filename/
      );
      await chmod(inbox.path, 0o755);
      await expect(openOwnedInbox(inbox.path)).rejects.toThrow(/owner-private/);
      await expect(inbox.readReply(id(1))).rejects.toThrow(/ownership changed/);
      const old = join(parent, 'previous');
      await rename(inbox.path, old);
      await mkdir(inbox.path, { mode: 0o700 });
      await expect(inbox.remove()).rejects.toThrow(/ownership changed/);
      expect(await readdir(parent)).toContain('previous');
    });
  });
});

it.runIf(process.platform === 'win32')(
  'fails before touching disk without a verified Windows ACL adapter',
  async () => {
    await expect(createOwnedInbox('unused')).rejects.toThrow(/verified owner-only Windows ACL/);
  }
);

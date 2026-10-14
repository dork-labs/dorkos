import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultTreeWatcher,
  nativeTreeWatcher,
  chokidarTreeWatcher,
  type TreeWatch,
} from '../session-tree-watch.js';

/**
 * The native tree watch (DOR-2907): one recursive `fs.watch` per projects root
 * on macOS and Windows, in place of chokidar's watch per transcript, which held
 * 758 file descriptors open on the affected machine.
 */
const native = process.platform === 'darwin';

describe.runIf(native)('nativeTreeWatcher', () => {
  let root: string;
  let watch: TreeWatch | undefined;
  const events: Array<{ kind: string; path?: string; urgent?: boolean }> = [];
  const on = {
    file: (p: string, urgent: boolean) => events.push({ kind: 'file', path: p, urgent }),
    dir: (p: string) => events.push({ kind: 'dir', path: p }),
    unknown: () => events.push({ kind: 'unknown' }),
    error: () => events.push({ kind: 'error' }),
  };
  const until = async (test: () => boolean) => {
    const deadline = Date.now() + 3_000;
    while (!test()) {
      if (Date.now() > deadline) throw new Error(`no event: ${JSON.stringify(events)}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  afterEach(async () => {
    await watch?.close();
    watch = undefined;
    events.length = 0;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('reports a slug folder, a new transcript and an append, and ignores deeper files', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-watch-')));
    watch = nativeTreeWatcher(root, on);
    // FSEvents can deliver events from just before the watch began; start clean.
    await new Promise((resolve) => setTimeout(resolve, 100));
    events.length = 0;

    const slug = path.join(root, '-work-alpha');
    fs.mkdirSync(slug);
    await until(() => events.some((e) => e.kind === 'dir' && e.path === slug));

    const transcript = path.join(slug, 'aaaa.jsonl');
    fs.writeFileSync(transcript, '{}\n');
    await until(() => events.some((e) => e.kind === 'file' && e.path === transcript));

    events.length = 0;
    fs.mkdirSync(path.join(slug, 'aaaa', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(slug, 'aaaa', 'subagents', 'x.jsonl'), '{}\n');
    fs.appendFileSync(transcript, '{}\n');
    await until(() => events.some((e) => e.kind === 'file' && e.path === transcript));
    expect(events.every((e) => e.path === transcript || e.path === slug)).toBe(true);
  });

  it('arms once a root that was missing appears', async () => {
    root = path.join(fs.realpathSync(os.tmpdir()), `tree-watch-late-${process.pid}-${Date.now()}`);
    watch = nativeTreeWatcher(root, on, 50);
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);

    fs.mkdirSync(root);
    await new Promise((resolve) => setTimeout(resolve, 200));
    fs.mkdirSync(path.join(root, '-work-late'));
    await until(() => events.some((e) => e.kind === 'dir'));
  });

  it('holds no descriptor per transcript', async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tree-watch-fds-')));
    for (let s = 0; s < 4; s++) {
      const slug = path.join(root, `-work-${s}`);
      fs.mkdirSync(slug);
      for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(slug, `${i}.jsonl`), '{}\n');
    }
    const open = () => fs.readdirSync('/dev/fd').length;
    const before = open();
    watch = nativeTreeWatcher(root, on);
    await new Promise((resolve) => setTimeout(resolve, 100));
    // 200 transcripts; chokidar on macOS opened one descriptor for each.
    expect(open() - before).toBeLessThan(10);
  });
});

describe('defaultTreeWatcher', () => {
  it('watches natively on macOS, and with chokidar elsewhere', () => {
    expect(defaultTreeWatcher('linux')).toBe(chokidarTreeWatcher);
    expect(defaultTreeWatcher('win32')).toBe(chokidarTreeWatcher);
    expect(defaultTreeWatcher('darwin')).not.toBe(chokidarTreeWatcher);
  });
});

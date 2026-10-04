/**
 * `record.isolation` from discovery (DOR-2686 task 1.2): one normalized view
 * of how an extension that runs separately is limited, with each `allow.run`
 * entry resolved to the program it names — by looking at the disk only, never
 * by running anything — and `null` for an extension that runs inside DorkOS.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { ExtensionDiscovery } from '../../extension-discovery.js';
import { toPublic } from '../../extension-manager-types.js';
import { resolveProgram } from '../resolve-program.js';
import type { CoreExtensionInfo, ExtensionsConfig } from '../../extension-enable-resolution.js';

const EMPTY_CONFIG: ExtensionsConfig = { enabled: [], disabled: [], approvedToRun: [] };
const EMPTY_CORE = new Map<string, CoreExtensionInfo>();

/** Write a file, creating its folder; `mode` makes it executable. */
async function writeFile(file: string, content: string, mode?: number): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content);
  if (mode !== undefined) await fs.chmod(file, mode);
}

describe('record.isolation', () => {
  let tmp: string;
  let dorkHome: string;
  let bin: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-isolation-')));
    dorkHome = path.join(tmp, '.dork');
    bin = path.join(tmp, 'bin');
    await fs.mkdir(path.join(dorkHome, 'extensions'), { recursive: true });
    await writeFile(path.join(bin, 'fake-git'), '#!/bin/sh\nexit 0\n', 0o755);
    vi.stubEnv('PATH', bin);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** Write one extension under the global extensions folder. */
  async function writeExtension(
    id: string,
    serverCapabilities: Record<string, unknown> | undefined,
    { server = true }: { server?: boolean } = {}
  ): Promise<void> {
    const dir = path.join(dorkHome, 'extensions', id);
    await writeFile(
      path.join(dir, 'extension.json'),
      JSON.stringify({ id, name: id, version: '1.0.0', serverCapabilities })
    );
    if (server) await writeFile(path.join(dir, 'server.ts'), 'export default () => {};');
  }

  // Purpose: a subprocess manifest yields the full view, defaults filled, with
  // a found program resolved to its absolute path and a missing one null.
  it('builds the view for a subprocess extension', async () => {
    await writeExtension('mail-app', {
      runtime: 'subprocess',
      allow: { net: ['imap.fastmail.com:993'], run: ['fake-git', 'no-such-program'], agents: true },
    });
    const [record] = await new ExtensionDiscovery(dorkHome).discover(
      null,
      EMPTY_CONFIG,
      EMPTY_CORE
    );
    expect(record!.status).not.toBe('invalid');
    expect(record!.isolation).toEqual({
      runtime: 'subprocess',
      net: ['imap.fastmail.com:993'],
      run: ['fake-git', 'no-such-program'],
      resolvedRun: [
        { name: 'fake-git', path: path.join(bin, 'fake-git') },
        { name: 'no-such-program', path: null },
      ],
      agents: true,
      memoryMb: 256,
    });
    // The public record the app reads carries the same view.
    expect(toPublic(record!, { approvedToRun: [] }).isolation).toEqual(record!.isolation);
  });

  // Purpose: an in-process extension has no isolation view, on the record and
  // in its public projection.
  it('is null for an in-process extension', async () => {
    await writeExtension('plain', { serverEntry: './server.ts' });
    const [record] = await new ExtensionDiscovery(dorkHome).discover(
      null,
      EMPTY_CONFIG,
      EMPTY_CORE
    );
    expect(record!.isolation).toBeNull();
    expect(toPublic(record!, { approvedToRun: [] }).isolation).toBeNull();
  });

  // Purpose: "run separately" with no server code is refused at discovery
  // with the spec's reason, since the schema cannot see the disk.
  it('marks a subprocess extension with no server code invalid', async () => {
    await writeExtension('proxy-only', { runtime: 'subprocess' }, { server: false });
    const [record] = await new ExtensionDiscovery(dorkHome).discover(
      null,
      EMPTY_CONFIG,
      EMPTY_CORE
    );
    expect(record!.status).toBe('invalid');
    expect(record!.error?.details).toBe('There is no server code to run separately');
  });
});

describe('resolveProgram', () => {
  let tmp: string;
  let dorkHome: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-resolve-')));
    dorkHome = path.join(tmp, '.dork');
    await fs.mkdir(dorkHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  // Purpose: relative PATH folders (empty, ".", "bin") never resolve a name,
  // so the answer cannot depend on the server's working directory.
  it('ignores relative PATH folders', async () => {
    await writeFile(path.join(tmp, 'tool'), '#!/bin/sh\n', 0o755);
    const cwd = process.cwd();
    process.chdir(tmp);
    try {
      expect(
        await resolveProgram('tool', {
          dorkHome,
          env: { PATH: `:.:./:${tmp}x` },
          platform: 'linux',
        })
      ).toBeNull();
    } finally {
      process.chdir(cwd);
    }
    expect(await resolveProgram('tool', { dorkHome, env: { PATH: tmp }, platform: 'linux' })).toBe(
      path.join(tmp, 'tool')
    );
  });

  // Purpose: the first absolute PATH folder holding a runnable file wins; a
  // file without an execute bit, or a folder, is passed over.
  it('takes the first runnable match in PATH order', async () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    const c = path.join(tmp, 'c');
    await writeFile(path.join(a, 'tool'), 'not runnable', 0o644);
    await fs.mkdir(path.join(b, 'tool'), { recursive: true });
    await writeFile(path.join(c, 'tool'), '#!/bin/sh\n', 0o755);
    expect(
      await resolveProgram('tool', {
        dorkHome,
        env: { PATH: [a, b, c].join(':') },
        platform: 'linux',
      })
    ).toBe(path.join(c, 'tool'));
  });

  // Purpose: an absolute entry is kept as written when runnable, else null.
  it('keeps an absolute path that exists and is runnable', async () => {
    const tool = path.join(tmp, 'opt', 'tool');
    await writeFile(tool, '#!/bin/sh\n', 0o755);
    expect(await resolveProgram(tool, { dorkHome, env: { PATH: '' }, platform: 'linux' })).toBe(
      tool
    );
    expect(
      await resolveProgram(path.join(tmp, 'opt', 'nope'), { dorkHome, env: {}, platform: 'linux' })
    ).toBeNull();
  });

  // Purpose: a program an extension could write — in DorkOS's extension data
  // folder or a project's — is refused, directly, via PATH, or via a link.
  it('refuses programs inside extension data folders', async () => {
    const owned = path.join(dorkHome, 'extension-data', 'mail-app', 'files', 'tool');
    await writeFile(owned, '#!/bin/sh\n', 0o755);
    expect(await resolveProgram(owned, { dorkHome, env: {}, platform: 'linux' })).toBeNull();
    expect(
      await resolveProgram('tool', {
        dorkHome,
        env: { PATH: path.dirname(owned) },
        platform: 'linux',
      })
    ).toBeNull();
    const project = path.join(tmp, 'proj', '.dork', 'extension-data', 'x', 'tool');
    await writeFile(project, '#!/bin/sh\n', 0o755);
    expect(await resolveProgram(project, { dorkHome, env: {}, platform: 'linux' })).toBeNull();
    const link = path.join(tmp, 'links', 'tool');
    await fs.mkdir(path.dirname(link), { recursive: true });
    await fs.symlink(owned, link);
    expect(await resolveProgram(link, { dorkHome, env: {}, platform: 'linux' })).toBeNull();
  });

  // Purpose: an entry the schema would refuse never resolves, and a POSIX
  // path means nothing under Windows rules.
  it('resolves nothing for invalid or foreign entries', async () => {
    await writeFile(path.join(tmp, 'tool'), '#!/bin/sh\n', 0o755);
    for (const entry of ['../tool', './tool', 'tool arg', `${tmp}/../${path.basename(tmp)}/tool`]) {
      expect(
        await resolveProgram(entry, { dorkHome, env: { PATH: tmp }, platform: 'linux' })
      ).toBeNull();
    }
    expect(
      await resolveProgram(path.join(tmp, 'tool'), { dorkHome, env: {}, platform: 'win32' })
    ).toBeNull();
  });
});

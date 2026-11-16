/**
 * A headless OpenCode turn can READ a globally installed package's own folder,
 * and never write it (DOR-4386). Security's ruling: each package's own folder,
 * by its exact real path, read-only; never the plugins folder, never a sibling
 * beside a package, never anything writable.
 *
 * Real folders on disk, because the grant is judged on what the filesystem
 * resolves and a mocked `realpath` would only echo the assumption.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import type { ApprovalEvent, StreamEvent } from '@dorkos/shared/types';
import { installedPackageReadGrants } from '../messaging/package-grants.js';
import { enforceApprovals, PendingApprovalStore } from '../messaging/approvals.js';
import type { OpenCodeClientProvider } from '../sessions/session-mapper.js';
import type { OpenCodeSessionRegistry } from '../sessions/session-registry.js';

let base: string;
let dorkHome: string;
let plugins: string;
let acme: string;
let backup: string;
let adapter: string;
let empty: string;

/** A global package folder with a manifest, and a skill when `skill` is given. */
async function writePackage(dir: string, type: string, skill?: string): Promise<void> {
  await mkdir(path.join(dir, '.dork'), { recursive: true });
  await writeFile(
    path.join(dir, '.dork', 'manifest.json'),
    JSON.stringify({ name: path.basename(dir), version: '1.0.0', type, description: 'x' })
  );
  if (skill !== undefined) {
    await mkdir(path.join(dir, 'skills', skill), { recursive: true });
    await writeFile(
      path.join(dir, 'skills', skill, 'SKILL.md'),
      `---\nname: ${skill}\ndescription: ${skill}\n---\nbody\n`
    );
  }
}

beforeAll(async () => {
  base = await realpath(await mkdtemp(path.join(os.tmpdir(), 'dorkos-oc-pkg-grants-')));
  dorkHome = path.join(base, 'dork');
  plugins = path.join(dorkHome, 'plugins');
  acme = path.join(plugins, 'acme');
  backup = path.join(plugins, `acme${MARKETPLACE_BACKUP_DIR_MARKER}1`);
  adapter = path.join(plugins, 'tg');
  empty = path.join(plugins, 'bare');
  await writePackage(acme, 'plugin', 'ship');
  await writePackage(backup, 'plugin', 'ship');
  await writePackage(adapter, 'adapter');
  await writePackage(empty, 'plugin');
  await mkdir(path.join(dorkHome, 'secrets'), { recursive: true });
  // A link committed inside the package, pointing out of it.
  await symlink(path.join(dorkHome, 'secrets'), path.join(acme, 'escape'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

describe('installedPackageReadGrants', () => {
  it("grants each skill-shipping global package's own real folder, read-only, and nothing else", () => {
    expect(installedPackageReadGrants(dorkHome)).toEqual([{ path: acme, access: 'read' }]);
  });

  it('grants the real folder when the data directory is reached through a link', async () => {
    const linked = path.join(base, 'linked-dork');
    await symlink(dorkHome, linked);
    expect(installedPackageReadGrants(linked)).toEqual([{ path: acme, access: 'read' }]);
  });

  it('grants nothing, and does not throw, for a data directory with no plugins', () => {
    expect(installedPackageReadGrants(path.join(base, 'nowhere'))).toEqual([]);
  });
});

describe('enforceApprovals with installed packages (DOR-4386)', () => {
  const respond = vi.fn(async () => ({ data: true }));
  const provider = {
    getClient: async () => ({ postSessionIdPermissionsPermissionId: respond }),
    peekClient: () => null,
  } as unknown as OpenCodeClientProvider;

  function externalAsk(file: string): Pick<ApprovalEvent, 'toolName' | 'input'> {
    const dir = path.dirname(file);
    return {
      toolName: 'external_directory',
      input: JSON.stringify({ patterns: [path.join(dir, '*')], filepath: file, parentDir: dir }),
    };
  }

  function editAsk(file: string): Pick<ApprovalEvent, 'toolName' | 'input'> {
    return {
      toolName: 'edit',
      input: JSON.stringify({ patterns: [path.relative('/', file)], filepath: file, diff: '' }),
    };
  }

  async function run(
    permissionMode: string,
    ask: Pick<ApprovalEvent, 'toolName' | 'input'>,
    full = false
  ): Promise<StreamEvent[]> {
    const approvals = new PendingApprovalStore();
    const cwd = path.join(base, 'project');
    const out: StreamEvent[] = [];
    for await (const event of enforceApprovals(
      {
        provider,
        approvals,
        registry: { get: () => ({ permissionMode }) } as unknown as OpenCodeSessionRegistry,
      },
      {
        sessionId: 's1',
        ocSessionId: 'oc-1',
        cwd,
        permissions: { pendingPermissionSessions: new Map() } as never,
        protectedRoots: {
          cwd,
          data: dorkHome,
          home: path.join(base, 'home'),
          accounts: [],
          agentFolders: [],
          agentHomes: [],
          ...(full ? { full: true } : {}),
        },
      },
      {
        type: 'approval_required',
        data: { toolCallId: 'per_1', timeoutMs: 1000, startedAt: 0, ...ask },
      } as StreamEvent
    )) {
      out.push(event);
    }
    approvals.clearSession('s1');
    return out;
  }

  afterEach(() => {
    respond.mockClear();
  });

  it("lets a headless turn read the package's own skill with no card, in default mode", async () => {
    const out = await run('default', externalAsk(path.join(acme, 'skills', 'ship', 'SKILL.md')));

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'once' } }));
    expect(out).toEqual([]);
  });

  it.each(['default', 'acceptEdits', 'bypassPermissions'])(
    'refuses a write into the package folder in %s mode',
    async (mode) => {
      const out = await run(mode, editAsk(path.join(acme, 'skills', 'ship', 'SKILL.md')));

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ body: { response: 'reject' } })
      );
      expect(out).toEqual([]);
    }
  );

  it('refuses a write into the package folder at Full too', async () => {
    // Two rules refuse it: `<dorkHome>/plugins` is a protected folder at every
    // level (`protected-paths.ts`), and the grant itself is read-only. The read
    // grant never widens what may be written.
    const out = await run(
      'bypassPermissions',
      editAsk(path.join(acme, 'skills', 'ship', 'SKILL.md')),
      true
    );

    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ body: { response: 'reject' } }));
    expect(out).toEqual([]);
  });

  it.each([
    ['the plugins folder itself', () => path.join(plugins, 'index.json')],
    ['a backup an install left beside it', () => path.join(backup, 'skills', 'ship', 'SKILL.md')],
    ['a package type DorkOS does not point OpenCode at', () => path.join(adapter, 'x.json')],
    ['a package with no skills or commands', () => path.join(empty, 'notes.md')],
    ['a link inside the package that points out of it', () => path.join(acme, 'escape', 'key')],
  ])('grants no read of %s, so the ask still reaches the person', async (_label, file) => {
    const out = await run('default', externalAsk(file()));

    expect(respond).not.toHaveBeenCalled();
    expect(out.map((event) => event.type)).toEqual(['approval_required']);
  });
});

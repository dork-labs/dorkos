/**
 * The pending approval payload carries what an extension can reach and what
 * is new since its last approval (DOR-2686 task 1.4), so a card can state the
 * access level and a re-ask card can lead with what changed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';

const state = vi.hoisted(() => ({ extensions: {} as Record<string, unknown> }));
vi.mock('../../../core/config-manager.js', () => ({
  configManager: { get: () => state.extensions, set: () => undefined },
}));

import { listPendingExtensionApprovals } from '../../extension-approval-queue.js';
import { PROGRAM_INSIDE_EXTENSION, PROGRAM_NOT_FOUND } from '../resolve-program.js';

describe('PendingExtensionApproval.permissions and .added', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ext-payload-')));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  /** A user extension at `<tmp>/<id>` with these server capabilities. */
  async function record(
    id: string,
    serverCapabilities: Record<string, unknown> | undefined,
    {
      page = false,
      isolation = null,
    }: { page?: boolean; isolation?: ExtensionRecord['isolation'] } = {}
  ): Promise<ExtensionRecord> {
    const dir = path.join(tmp, id);
    await fs.mkdir(dir, { recursive: true });
    if (page) await fs.writeFile(path.join(dir, 'index.ts'), 'export function activate() {}');
    return {
      id,
      manifest: { id, name: id, version: '1.0.0', serverCapabilities } as ExtensionManifest,
      status: 'enabled',
      scope: 'global',
      origin: 'user',
      path: dir,
      bundleReady: false,
      hasServerEntry: true,
      hasDataProxy: false,
      isolation,
    };
  }

  /** The pending list for these records. */
  function list(records: ExtensionRecord[]) {
    return listPendingExtensionApprovals({
      listRecords: () => records,
      onChange: () => () => undefined,
      dorkHome: tmp,
    } as never);
  }

  // Purpose: an extension approved for one host that now declares two waits,
  // and its payload lists only the new host as added, plus what it can reach.
  it('lists only what is new for a widened extension', async () => {
    const mail = await record(
      'mail',
      {
        serverEntry: './server.ts',
        runtime: 'subprocess',
        allow: { net: ['a.example.com', 'b.example.com'], run: ['git', 'nope'] },
      },
      {
        page: true,
        isolation: {
          runtime: 'subprocess',
          net: ['a.example.com', 'b.example.com'],
          run: ['git', 'nope'],
          resolvedRun: [
            { name: 'git', path: '/usr/bin/git' },
            { name: 'nope', path: null },
          ],
          agents: false,
          memoryMb: 256,
        },
      }
    );
    // The approval names these very files (DOR-3068); only the set widened.
    mail.currentDigest = `sha256:${'d'.repeat(64)}`;
    state.extensions = {
      approvedToRun: ['mail'],
      approvedSources: { mail: { path: mail.path, digest: mail.currentDigest } },
      approvedPermissions: {
        mail: {
          runtime: 'subprocess',
          net: ['a.example.com'],
          run: ['git', 'nope'],
          agents: false,
        },
      },
    };
    const [pending] = await list([mail]);
    expect(pending!.added).toEqual({
      net: ['b.example.com'],
      run: [],
      agents: false,
      runtime: false,
    });
    expect(pending!.permissions).toEqual({
      runtime: 'subprocess',
      net: ['a.example.com', 'b.example.com'],
      run: [
        { name: 'git', found: true },
        { name: 'nope', found: false },
      ],
      agents: false,
      hasPage: true,
    });
  });

  // Purpose: an in-process extension on its first ask says it runs inside
  // DorkOS (empty lists), whether it has screens, and that nothing is "added".
  it('describes an in-process extension on its first ask', async () => {
    state.extensions = { approvedToRun: [], approvedSources: {} };
    const [pending] = await list([await record('plain', { serverEntry: './server.ts' })]);
    expect(pending!.permissions).toEqual({
      runtime: 'in-process',
      net: [],
      run: [],
      agents: false,
      hasPage: false,
    });
    expect(pending!.added).toBeNull();
  });

  // Purpose: a copy nobody approved has nothing to compare against, even if
  // another copy's set is stored under its id.
  it('reports nothing added for a copy that was never approved', async () => {
    const other = await record(
      'mail',
      { serverEntry: './server.ts', runtime: 'subprocess', allow: { agents: true } },
      {
        isolation: {
          runtime: 'subprocess',
          net: [],
          run: [],
          resolvedRun: [],
          agents: true,
          memoryMb: 256,
        },
      }
    );
    state.extensions = {
      approvedToRun: ['mail'],
      approvedSources: { mail: { path: '/somewhere/else' } },
      approvedPermissions: { mail: { runtime: 'subprocess', net: [], run: [], agents: false } },
    };
    const [pending] = await list([other]);
    expect(pending!.added).toBeNull();
    expect(pending!.permissions?.agents).toBe(true);
  });
  // Purpose: a program DorkOS found but refuses (inside extension files, a
  // Windows script) carries the refusal sentence so the card never lists it as
  // runnable; one merely missing carries only `found: false`.
  it('carries the refusal reason for a refused program, not for a missing one', async () => {
    const tool = await record(
      'tool',
      { serverEntry: './server.ts', runtime: 'subprocess', allow: { run: ['helper', 'gone'] } },
      {
        isolation: {
          runtime: 'subprocess',
          net: [],
          run: ['helper', 'gone'],
          resolvedRun: [
            { name: 'helper', path: null, reason: PROGRAM_INSIDE_EXTENSION },
            { name: 'gone', path: null, reason: PROGRAM_NOT_FOUND },
          ],
          agents: false,
          memoryMb: 256,
        },
      }
    );
    state.extensions = { approvedToRun: [], approvedSources: {} };
    const [pending] = await list([tool]);
    expect(pending!.permissions?.run).toEqual([
      { name: 'helper', found: false, refusedReason: PROGRAM_INSIDE_EXTENSION },
      { name: 'gone', found: false },
    ]);
  });

  describe('an update whose files changed since the yes (DOR-4504)', () => {
    const APPROVED_DIGEST = `sha256:${'a'.repeat(64)}`;
    const UPDATED_DIGEST = `sha256:${'b'.repeat(64)}`;
    const BEFORE = { runtime: 'subprocess', net: ['a.example.com'], run: ['git'], agents: false };

    /** The approved copy, updated: new files, and `allow` as the update declares it. */
    async function updated(
      allow: { net: string[]; run: string[]; agents: boolean },
      serverRuntime: 'subprocess' | 'in-process' = 'subprocess'
    ) {
      const app = await record(
        'notes',
        serverRuntime === 'subprocess'
          ? { serverEntry: './server.ts', runtime: 'subprocess', allow }
          : { serverEntry: './server.ts' },
        {
          isolation:
            serverRuntime === 'subprocess'
              ? {
                  runtime: 'subprocess',
                  net: allow.net,
                  run: allow.run,
                  resolvedRun: allow.run.map((name) => ({ name, path: `/usr/bin/${name}` })),
                  agents: allow.agents,
                  memoryMb: 256,
                }
              : null,
        }
      );
      // The update rewrote extension.json, so its files no longer match the yes.
      app.currentDigest = UPDATED_DIGEST;
      state.extensions = {
        approvedToRun: ['notes'],
        approvedSources: { notes: { path: app.path, digest: APPROVED_DIGEST } },
        approvedPermissions: { notes: BEFORE },
      };
      return app;
    }

    // Purpose: each power an update adds is named on the card, even though its
    // files changed and the approval no longer matches them.
    it.each([
      {
        power: 'a new host',
        allow: { net: ['a.example.com', 'b.example.com'], run: ['git'], agents: false },
        added: { net: ['b.example.com'], run: [], agents: false, runtime: false },
      },
      {
        power: 'a new program',
        allow: { net: ['a.example.com'], run: ['git', 'rg'], agents: false },
        added: { net: [], run: ['rg'], agents: false, runtime: false },
      },
      {
        power: 'messaging agents',
        allow: { net: ['a.example.com'], run: ['git'], agents: true },
        added: { net: [], run: [], agents: true, runtime: false },
      },
    ])('names $power as added', async ({ allow, added }) => {
      const [pending] = await list([await updated(allow)]);
      expect(pending!.added).toEqual(added);
    });

    // Purpose: an update that moves its server part inside DorkOS is named as
    // asking for full access, whatever its files.
    it('names running inside DorkOS as added', async () => {
      const [pending] = await list([
        await updated({ net: [], run: [], agents: false }, 'in-process'),
      ]);
      expect(pending!.added).toEqual({ net: [], run: [], agents: false, runtime: true });
    });

    // Purpose: an update that changes files but asks for nothing new marks
    // nothing new.
    it('names nothing for a file change that adds no power', async () => {
      const [pending] = await list([
        await updated({ net: ['a.example.com'], run: ['git'], agents: false }),
      ]);
      expect(pending!.added).toBeNull();
    });

    // Purpose: what counts as approved comes only from DorkOS's own record. An
    // approval with no stored set is the full in-process set, which covers
    // anything, so nothing is new.
    it('takes the approved set only from the stored approval', async () => {
      const app = await updated({ net: ['b.example.com'], run: [], agents: true });
      state.extensions = {
        approvedToRun: ['notes'],
        approvedSources: { notes: { path: app.path, digest: APPROVED_DIGEST } },
      };
      const [pending] = await list([app]);
      expect(pending!.added).toBeNull();
    });
  });
});

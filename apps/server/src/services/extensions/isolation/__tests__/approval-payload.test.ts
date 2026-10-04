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
    state.extensions = {
      approvedToRun: ['mail'],
      approvedSources: { mail: { path: mail.path } },
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
});

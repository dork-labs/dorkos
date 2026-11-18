/**
 * `list_extensions` says which extensions wait for a person and what an update adds since the
 * last approval (DOR-4504's list, DOR-4678), read through the real waiting list over a real
 * config in a temp DorkOS home, and says so when that list cannot be read.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { ExtensionManifest, ExtensionRecord } from '@dorkos/extension-api';
import { configManager, initConfigManager } from '../../core/config-manager.js';
import { createListExtensionsHandler } from '../../runtimes/claude-code/mcp-tools/extension-tools.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { ExtensionManager } from '../extension-manager.js';

let tmp: string;

beforeEach(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'list-ext-waiting-')));
  initConfigManager(tmp);
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

/** A user extension approved for one host, whose update now declares a second. */
async function widenedMail(): Promise<ExtensionRecord> {
  const dir = path.join(tmp, 'mail');
  await fs.mkdir(dir, { recursive: true });
  const net = ['a.example.com', 'b.example.com'];
  const record: ExtensionRecord = {
    id: 'mail',
    manifest: {
      id: 'mail',
      name: 'Mail',
      version: '1.1.0',
      serverCapabilities: { serverEntry: './server.ts', runtime: 'subprocess', allow: { net } },
    } as ExtensionManifest,
    status: 'enabled',
    scope: 'global',
    origin: 'user',
    path: dir,
    bundleReady: false,
    hasServerEntry: true,
    hasDataProxy: false,
    isolation: {
      runtime: 'subprocess',
      net,
      run: [],
      resolvedRun: [],
      agents: false,
      memoryMb: 256,
    },
  };
  record.currentDigest = `sha256:${'d'.repeat(64)}`;
  configManager.set('extensions', {
    ...configManager.get('extensions'),
    approvedToRun: ['mail'],
    approvedSources: { mail: { path: dir, digest: record.currentDigest } },
    approvedPermissions: {
      mail: { runtime: 'subprocess', net: ['a.example.com'], run: [], agents: false },
    },
  } as never);
  return record;
}

/** A manager over these records; `listRecords` is what the waiting list reads. */
function depsFor(records: ExtensionRecord[], listRecords = () => records): McpToolDeps {
  const manager = {
    listPublic: () => records,
    listRecords,
    onChange: () => () => undefined,
    dorkHome: tmp,
    getServerHandler: () => null,
  } as unknown as ExtensionManager;
  return { extensionManager: manager } as McpToolDeps;
}

async function listed(deps: McpToolDeps) {
  const result = await createListExtensionsHandler(deps)();
  return JSON.parse((result.content[0] as { text: string }).text);
}

describe('list_extensions and the waiting list', () => {
  it('says an updated extension waits, and names the host it adds', async () => {
    const mail = await widenedMail();
    const data = await listed(depsFor([mail]));
    expect(data.extensions[0]).toMatchObject({
      id: 'mail',
      waitsForPerson: true,
      addsSinceApproval: { net: ['b.example.com'], run: [], agents: false, runtime: false },
    });
    expect(data.extensions[0]).not.toHaveProperty('waitingUnknown');
  });

  it('says it could not tell, rather than that nothing waits, when the list is unreadable', async () => {
    const mail = await widenedMail();
    const data = await listed(
      depsFor([mail], () => {
        throw new Error('made-up unreadable records');
      })
    );
    expect(data.extensions[0]).toMatchObject({ id: 'mail', waitingUnknown: true });
    expect(data.extensions[0]).not.toHaveProperty('waitsForPerson');
  });
});

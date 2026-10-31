/** Each scan hands what it found to the path-trust rule (DOR-3440). */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExtensionDiscovery } from '../extension-discovery.js';
import { notePathTrustEdits } from '../pin/path-trust-edits.js';

vi.mock('../pin/path-trust-edits.js', () => ({ notePathTrustEdits: vi.fn() }));

describe('a discovery scan', () => {
  let dorkHome: string;

  afterEach(async () => {
    await fs.rm(dorkHome, { recursive: true, force: true });
  });

  it('checks the copies it found, with the approvals it was given', async () => {
    dorkHome = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-'));
    const dir = path.join(dorkHome, 'extensions', 'desk');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, 'extension.json'),
      JSON.stringify({ id: 'desk', name: 'Desk', version: '1.0.0' })
    );
    const config = { enabled: [], disabled: [], approvedToRun: [], approvedSources: {} };

    await new ExtensionDiscovery(dorkHome).discover(null, config as never, new Map());

    const [records, approvals, home] = vi.mocked(notePathTrustEdits).mock.calls[0]!;
    expect(records.map((r) => r.id)).toEqual(['desk']);
    expect(approvals).toBe(config);
    expect(home).toBe(dorkHome);
  });
});

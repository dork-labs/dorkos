/**
 * A PATCH never rebuilds a manifest it could not read (DOR-486 review).
 *
 * `update` reads `.dork/agent.json`, merges, and writes back. When the read
 * failed it fell back to `toManifest(entry)` — the DB row — which is a LOSSY
 * cache: it carries no `enabledToolGroups`, no `mcpServers`, no `workspace` and
 * no `tierCeiling`. So any PATCH landing while the file was malformed silently
 * erased all four, and for a tier ceiling the erase WIDENS a security control:
 * an agent capped at `observe` came back uncapped because somebody changed its
 * display name at the wrong moment.
 *
 * Driven over a real temp directory against the real `MeshCore`, because the
 * whole mechanism is a decision about bytes on disk — the route-level tests one
 * layer up mock `meshCore.update` and cannot see this at all, which is why the
 * guard shipped with no execution coverage until now.
 *
 * Seeded defect: change the `probe.state === 'unreadable'` test in
 * `mesh-agent-management.ts` to `'absent'` (or delete the guard) -> the first
 * case goes red, and only it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createTestDb } from '@dorkos/test-utils/db';
import type { Db } from '@dorkos/db';
import { MeshCore } from '../mesh-core.js';
import { ManifestUnreadableError } from '../mesh-agent-management.js';
import { MANIFEST_DIR, MANIFEST_FILE } from '../manifest.js';

const tempDirs: string[] = [];
let db: Db;

beforeEach(() => {
  tempDirs.length = 0;
  db = createTestDb();
});

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

/** A temp root that is cleaned up after the case. */
async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'manifest-write-guard-'));
  tempDirs.push(dir);
  return dir;
}

/** Where the manifest for an agent directory lives. */
function manifestPath(agentDir: string): string {
  return path.join(agentDir, MANIFEST_DIR, MANIFEST_FILE);
}

/** A registered agent in its own directory, plus the mesh it lives in. */
async function registerAgent(): Promise<{ mesh: MeshCore; agentId: string; agentDir: string }> {
  const base = await makeTempDir();
  const agentDir = path.join(base, 'ana');
  await fs.mkdir(agentDir, { recursive: true });

  const mesh = new MeshCore({ db, defaultScanRoot: base });
  const agent = await mesh.registerByPath(agentDir, { name: 'ana', runtime: 'claude-code' });

  return { mesh, agentId: agent.id, agentDir };
}

describe('update() refuses a manifest it cannot read', () => {
  it('rejects, and leaves the file exactly as it found it', async () => {
    const { mesh, agentId, agentDir } = await registerAgent();
    // A ceiling only the FILE can carry — the DB row has no column for it, so a
    // rebuild from the cache is precisely how it would disappear.
    await mesh.update(agentId, { tierCeiling: 'observe' });
    const capped = await fs.readFile(manifestPath(agentDir), 'utf-8');
    expect(JSON.parse(capped).tierCeiling).toBe('observe');

    // Now the file is present and unreadable — a half-written edit, a bad merge.
    const corrupt = capped.slice(0, capped.length / 2);
    await fs.writeFile(manifestPath(agentDir), corrupt, 'utf-8');

    await expect(mesh.update(agentId, { displayName: 'Ana the Bold' })).rejects.toBeInstanceOf(
      ManifestUnreadableError
    );

    // Untouched: the refusal is worth nothing if it writes on the way out.
    expect(await fs.readFile(manifestPath(agentDir), 'utf-8')).toBe(corrupt);
  });

  it('names the file and what to do about it', async () => {
    const { mesh, agentId, agentDir } = await registerAgent();
    await fs.writeFile(manifestPath(agentDir), '{ this is not json', 'utf-8');

    const refusal = (await mesh
      .update(agentId, { displayName: 'Ana the Bold' })
      .catch((err: unknown) => err)) as ManifestUnreadableError;

    expect(refusal.projectPath).toBe(agentDir);
    // A person has to be able to act on this without reading the source.
    expect(refusal.message).toContain(agentDir);
    expect(refusal.message).toContain('Fix or remove the file');
  });

  it('still reconstructs when the manifest is ABSENT, which is the recovery path', async () => {
    // The sibling half, and the reason the guard reads `probeManifest` rather
    // than `readManifest`'s single `null`: a manifest that is demonstrably GONE
    // has nothing to lose, and rebuilding it from the row is how an agent whose
    // file was deleted comes back. Collapsing the two states would break that.
    const { mesh, agentId, agentDir } = await registerAgent();
    await fs.rm(manifestPath(agentDir));

    const updated = await mesh.update(agentId, { displayName: 'Ana the Bold' });

    expect(updated?.displayName).toBe('Ana the Bold');
    const rewritten = JSON.parse(await fs.readFile(manifestPath(agentDir), 'utf-8'));
    expect(rewritten.displayName).toBe('Ana the Bold');
  });
});

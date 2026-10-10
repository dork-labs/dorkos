/**
 * Every surface that writes `reportsTo` refuses a loop and records a change
 * (spec `heartbeats` §4.1, §4.2), and none of them can write `createdBy`.
 *
 * The agent's own edit path is exercised for real — manifests on disk, a real
 * audit log — through both doors that reach it: the shared updater the
 * profile's `PATCH /api/agents/current` calls, and the `update_agent` tool.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundaryOrDorkHome: async (p: string) => p,
}));

import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { AgentUpdateError, updateAgentManifest } from '../../core/operator/agent-updater.js';
import { createUpdateAgentHandler } from '../../core/operator/operator-tool-handlers.js';
import { NotifyBudget } from '../../relay/notify-budget.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import type { MeshCore } from '@dorkos/mesh';

const OWNER = 'acct-owner';

/** A minimal manifest for one agent. */
function manifest(id: string, extra: Partial<AgentManifest> = {}): AgentManifest {
  return {
    id,
    name: id.toLowerCase(),
    description: '',
    runtime: 'claude-code',
    capabilities: [],
    behavior: { responseMode: 'always' },
    registeredAt: '2026-10-01T00:00:00.000Z',
    registeredBy: 'test',
    personaEnabled: true,
    isSystem: false,
    mcpServers: [],
    workspace: { mode: 'home' },
    ...extra,
  };
}

let db: Db;
let root: string;
const paths: Record<string, string> = {};

/** A mesh over the manifests on disk: `get` reads what was last written. */
function meshOverDisk(): Pick<MeshCore, 'get' | 'syncFromDisk' | 'getProjectPath'> {
  const cache = new Map<string, AgentManifest>();
  const mesh = {
    get: (id: string) => cache.get(id),
    getProjectPath: (id: string) => paths[id],
    syncFromDisk: async (projectPath: string) => {
      const m = await readManifest(projectPath);
      if (m) cache.set(m.id, m);
      return { status: 'synced' } as never;
    },
  };
  return mesh as unknown as Pick<MeshCore, 'get' | 'syncFromDisk' | 'getProjectPath'>;
}

/** Write an agent to disk and into the mesh. */
async function seed(mesh: ReturnType<typeof meshOverDisk>, m: AgentManifest): Promise<void> {
  const dir = join(root, m.id);
  await mkdir(join(dir, '.dork'), { recursive: true });
  await writeManifest(dir, m);
  paths[m.id] = dir;
  await mesh.syncFromDisk(dir);
}

beforeEach(async () => {
  db = createTestDb();
  root = await mkdtemp(join(tmpdir(), 'reports-to-writes-'));
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({
      db,
      installId: '1',
      readOwnerAccount: () => ({ id: OWNER, name: 'Dorian' }),
    }),
  });
});

afterEach(async () => {
  resetAuditTrail();
  await rm(root, { recursive: true, force: true });
});

/** The `agent.reports_to_changed` rows written so far. */
function changeRows() {
  return db
    .select()
    .from(auditEvents)
    .all()
    .filter((row) => row.action === 'agent.reports_to_changed');
}

describe('the agent edit path (profile picker route and update_agent)', () => {
  it('refuses a loop with REPORTS_TO_CYCLE and writes nothing', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A'));
    await seed(mesh, manifest('B', { reportsTo: 'A' }));

    const attempt = updateAgentManifest({
      agentPath: paths.A!,
      body: { reportsTo: 'B' },
      meshCore: mesh,
    });
    await expect(attempt).rejects.toBeInstanceOf(AgentUpdateError);
    await expect(attempt).rejects.toMatchObject({ code: 'REPORTS_TO_CYCLE' });
    expect((await readManifest(paths.A!))?.reportsTo).toBeUndefined();
    expect(changeRows()).toHaveLength(0);
  });

  it('refuses an agent reporting to itself even with no mesh to ask', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A'));
    await expect(
      updateAgentManifest({ agentPath: paths.A!, body: { reportsTo: 'A' } })
    ).rejects.toMatchObject({ code: 'REPORTS_TO_CYCLE' });
  });

  it('stores a valid manager and records the change with before and after', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A'));
    await seed(mesh, manifest('C'));

    const updated = await updateAgentManifest({
      agentPath: paths.A!,
      body: { reportsTo: 'C' },
      meshCore: mesh,
    });
    expect(updated.reportsTo).toBe('C');
    expect((await readManifest(paths.A!))?.reportsTo).toBe('C');

    const rows = changeRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation).toBe('modify');
    expect(rows[0]?.visibility).toBe('space');
    expect(rows[0]?.targetId).toBe('A');
    expect(JSON.parse(rows[0]!.change!)).toEqual([
      { field: 'reportsTo', before: null, after: 'C' },
    ]);

    // Clearing it goes back to the default chain, and is recorded too.
    await updateAgentManifest({ agentPath: paths.A!, body: { reportsTo: null }, meshCore: mesh });
    expect((await readManifest(paths.A!))?.reportsTo).toBeUndefined();
    expect(changeRows()).toHaveLength(2);
  });

  it('accepts the owner as a manager', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A'));
    const updated = await updateAgentManifest({
      agentPath: paths.A!,
      body: { reportsTo: OWNER },
      meshCore: mesh,
    });
    expect(updated.reportsTo).toBe(OWNER);
  });

  it('stores the owner’s canonical id when a write names an owner alias', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A'));
    for (const alias of ['install:1', 'owner']) {
      const updated = await updateAgentManifest({
        agentPath: paths.A!,
        body: { reportsTo: alias },
        meshCore: mesh,
      });
      expect(updated.reportsTo).toBe(OWNER);
      expect((await readManifest(paths.A!))?.reportsTo).toBe(OWNER);
    }
  });

  it('never writes createdBy', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A', { createdBy: OWNER }));
    await updateAgentManifest({
      agentPath: paths.A!,
      body: { displayName: 'Atlas', createdBy: 'forged' },
      meshCore: mesh,
    });
    expect((await readManifest(paths.A!))?.createdBy).toBe(OWNER);
  });

  it('update_agent refuses a loop with the same code', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A'));
    // B reports to A by default: A created it.
    await seed(mesh, manifest('B', { createdBy: 'A' }));

    const deps = {
      notifyBudget: new NotifyBudget(),
      transcriptReader: {} as McpToolDeps['transcriptReader'],
      defaultCwd: root,
      dorkHome: root,
      meshCore: mesh as unknown as MeshCore,
    } satisfies McpToolDeps;
    const result = await createUpdateAgentHandler(deps)({ agent_id: 'A', reportsTo: 'B' });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ code: 'REPORTS_TO_CYCLE' });
    expect((await readManifest(paths.A!))?.reportsTo).toBeUndefined();
  });

  it('update_agent never writes createdBy', async () => {
    const mesh = meshOverDisk();
    await seed(mesh, manifest('A', { createdBy: OWNER }));
    const deps = {
      notifyBudget: new NotifyBudget(),
      transcriptReader: {} as McpToolDeps['transcriptReader'],
      defaultCwd: root,
      dorkHome: root,
      meshCore: mesh as unknown as MeshCore,
    } satisfies McpToolDeps;
    await createUpdateAgentHandler(deps)({
      agent_id: 'A',
      description: 'x',
      ...({ createdBy: 'forged' } as object),
    });
    expect((await readManifest(paths.A!))?.createdBy).toBe(OWNER);
  });
});

/**
 * `HEARTBEAT.md`: its frontmatter, the three templates, which template a new
 * agent gets, and the record an edit leaves (spec `heartbeats` §2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { auditEvents, type Db } from '@dorkos/db';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { HEARTBEAT_TEMPLATE_IDS, resolveHeartbeatSettings } from '@dorkos/shared/heartbeat-schemas';
import { UpdateAgentConventionsSchema } from '@dorkos/shared/mesh-schemas';
import { HEARTBEAT_TEMPLATE_NAMES, renderHeartbeatTemplate } from '@dorkos/operating-skills';
import { HEARTBEAT_MAX_CHARS } from '@dorkos/shared/convention-files';

vi.mock('../../../lib/boundary.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/boundary.js')>()),
  validateBoundaryOrDorkHome: async (p: string) => p,
}));

import { AuditLog } from '../../audit/audit-log.js';
import { AccountIds } from '../../audit/account-ids.js';
import { initAuditTrail, resetAuditTrail } from '../../audit/audit-trail.js';
import { AgentUpdateError, updateAgentManifest } from '../../core/operator/agent-updater.js';
import {
  chooseHeartbeatTemplate,
  diffHeartbeatFrontmatter,
  parseHeartbeatText,
  readHeartbeatFile,
  seedHeartbeatFile,
} from '../heartbeat-file.js';

let db: Db;
let root: string;

beforeEach(async () => {
  db = createTestDb();
  root = await mkdtemp(join(tmpdir(), 'heartbeat-file-'));
  initAuditTrail({
    log: new AuditLog(db),
    accounts: new AccountIds({
      db,
      installId: '1',
      readOwnerAccount: () => ({ id: 'acct-owner', name: 'Dorian' }),
    }),
  });
});

afterEach(async () => {
  resetAuditTrail();
  await rm(root, { recursive: true, force: true });
});

describe('parseHeartbeatText', () => {
  it('reads the frontmatter and keeps the body free', () => {
    const parsed = parseHeartbeatText(
      '---\nwake: timed\nwatch: [addressed, workspace]\nreport: weekly\nsweep: 4h\n---\n\n- Invoices first.\n'
    );
    expect(parsed).toMatchObject({
      ok: true,
      frontmatter: {
        wake: 'timed',
        watch: ['addressed', 'workspace'],
        report: 'weekly',
        sweep: '4h',
      },
      body: '- Invoices first.',
    });
  });

  it('refuses a bad value with the field it names', () => {
    const parsed = parseHeartbeatText('---\nwake: hourly\n---\nbody');
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^wake:/);
  });

  it('refuses a sweep shorter than thirty minutes', () => {
    expect(parseHeartbeatText('---\nsweep: 10m\n---\n').ok).toBe(false);
    expect(parseHeartbeatText('---\nsweep: 30m\n---\n').ok).toBe(true);
  });

  it('refuses a code-running frontmatter language rather than throwing', () => {
    const parsed = parseHeartbeatText('---js\n{ wake: "timed" }\n---\n');
    expect(parsed.ok).toBe(false);
  });
});

describe('the shipped templates', () => {
  it('ships exactly the template ids the shared schema names', () => {
    expect([...HEARTBEAT_TEMPLATE_NAMES]).toEqual([...HEARTBEAT_TEMPLATE_IDS]);
  });

  it.each([
    ['lead', 'timed'],
    ['doer', 'timed'],
    ['coder', 'events'],
  ] as const)('%s parses and wakes %s with a daily report', (name, wake) => {
    const text = renderHeartbeatTemplate(name);
    const parsed = parseHeartbeatText(text);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(resolveHeartbeatSettings(parsed.frontmatter)).toMatchObject({ wake, report: 'daily' });
    expect(parsed.body.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(HEARTBEAT_MAX_CHARS);
  });

  it('keeps the coder template to tech debt, tests, CI, dependencies and security', () => {
    expect(renderHeartbeatTemplate('coder')).toMatch(
      /tech debt, tests, CI, dependencies and security/
    );
  });

  it("renders DorkBot's starter with the report off", () => {
    const parsed = parseHeartbeatText(renderHeartbeatTemplate('lead', { report: 'off' }));
    expect(parsed.ok && parsed.frontmatter.report).toBe('off');
  });
});

describe('which template a new agent gets', () => {
  it('takes the template its type names', () => {
    expect(chooseHeartbeatTemplate({ template: 'coder', runtime: 'doe' })).toBe('coder');
  });

  it('falls back to lead on Doe and to no file on every other runtime', () => {
    expect(chooseHeartbeatTemplate({ runtime: 'doe' })).toBe('lead');
    expect(chooseHeartbeatTemplate({ runtime: 'claude-code' })).toBeNull();
    expect(chooseHeartbeatTemplate({ runtime: 'codex' })).toBeNull();
    expect(chooseHeartbeatTemplate({})).toBeNull();
  });

  it('never writes over a file the agent already has', async () => {
    await mkdir(join(root, '.dork'), { recursive: true });
    await writeFile(join(root, '.dork', 'HEARTBEAT.md'), 'mine');
    expect(await seedHeartbeatFile(root, { runtime: 'doe' })).toBeNull();
    expect(await readFile(join(root, '.dork', 'HEARTBEAT.md'), 'utf-8')).toBe('mine');
  });

  it('writes the template where none exists, and nothing for a non-Doe runtime', async () => {
    await mkdir(join(root, '.dork'), { recursive: true });
    expect(await seedHeartbeatFile(root, { runtime: 'claude-code' })).toBeNull();
    expect((await readHeartbeatFile(root)).kind).toBe('absent');
    expect(await seedHeartbeatFile(root, { runtime: 'doe' })).toBe('lead');
    const read = await readHeartbeatFile(root);
    expect(read.kind).toBe('valid');
  });
});

describe('diffHeartbeatFrontmatter', () => {
  it('lists only the fields that changed', () => {
    expect(
      diffHeartbeatFrontmatter(
        { wake: 'events', report: 'daily' },
        { wake: 'timed', report: 'daily' }
      )
    ).toEqual([{ field: 'wake', before: 'events', after: 'timed' }]);
  });
});

describe('editing HEARTBEAT.md through DorkOS', () => {
  /** A minimal agent on disk. */
  async function agentOnDisk(): Promise<string> {
    const dir = join(root, 'agent');
    await mkdir(join(dir, '.dork'), { recursive: true });
    const manifest: AgentManifest = {
      id: 'AGENT1',
      name: 'juno',
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
    };
    await writeManifest(dir, manifest);
    return dir;
  }

  it('writes the file and records the frontmatter diff once', async () => {
    const dir = await agentOnDisk();
    await writeFile(join(dir, '.dork', 'HEARTBEAT.md'), '---\nwake: events\n---\nold');

    await updateAgentManifest({
      agentPath: dir,
      body: { heartbeatContent: '---\nwake: timed\n---\nnew body' },
    });

    expect(await readFile(join(dir, '.dork', 'HEARTBEAT.md'), 'utf-8')).toContain('new body');
    const rows = db
      .select()
      .from(auditEvents)
      .all()
      .filter((row) => row.action === 'heartbeat.config_changed');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.change ?? '[]')).toEqual([
      { field: 'wake', before: 'events', after: 'timed' },
    ]);
    expect(rows[0]!.summary).not.toContain('new body');
  });

  it('refuses a file over the cap, naming the file', async () => {
    const dir = await agentOnDisk();
    const attempt = updateAgentManifest({
      agentPath: dir,
      body: { heartbeatContent: 'x'.repeat(HEARTBEAT_MAX_CHARS + 1) },
    });
    await expect(attempt).rejects.toBeInstanceOf(AgentUpdateError);
    await expect(attempt).rejects.toThrow(/HEARTBEAT\.md is too long/);
    expect(
      UpdateAgentConventionsSchema.safeParse({ heartbeatContent: 'x'.repeat(HEARTBEAT_MAX_CHARS) })
        .success
    ).toBe(true);
  });
});

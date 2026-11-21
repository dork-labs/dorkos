/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb } from '@dorkos/test-utils/db';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';
import { initBoundary } from '../../../lib/boundary.js';
import { ApprovalService } from '../../core/approvals/index.js';
import { buildInstallerForTests } from '../../marketplace/__tests__/installer-harness.js';
import { TokenConfirmationProvider } from '../confirmation-provider.js';
import { createInstallHandler } from '../tool-install.js';
import type { MarketplaceMcpDeps } from '../marketplace-mcp-tools.js';

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

/** A real approval, installer and schedule writer, rooted entirely in made-up temporary data. */
describe('package approval effects', () => {
  it('installs only declared secrets and schedules, without supplying secrets or arming jobs', async () => {
    root = await mkdtemp(path.join(tmpdir(), 'dorkos-package-card-'));
    const dorkHome = path.join(root, 'dork');
    const sources = path.join(root, 'sources');
    const source = path.join(sources, 'sample-pack');
    const ext = path.join(source, '.dork', 'extensions', 'sample-board');
    await mkdir(ext, { recursive: true });
    await mkdir(dorkHome, { recursive: true });
    await initBoundary(sources);
    await mkdir(path.join(source, '.claude-plugin'));
    await writeFile(
      path.join(source, '.claude-plugin', 'plugin.json'),
      JSON.stringify({
        name: 'sample-pack',
        version: '1.0.0',
        description: 'A sample package.',
      })
    );
    const schedules = [
      {
        name: 'Sample check',
        description: 'A sample check.',
        prompt: 'Check samples.',
        cron: '0 9 * * *',
        permissionMode: 'plan',
        startEnabled: false,
      },
    ];
    const secrets = [{ key: 'sample_key', label: 'Sample key', required: true }];
    await writeFile(
      path.join(source, '.dork', 'manifest.json'),
      JSON.stringify({
        schemaVersion: 1,
        name: 'sample-pack',
        version: '1.0.0',
        type: 'plugin',
        description: 'A sample package.',
        layers: ['extensions'],
        extensions: ['sample-board'],
        schedules,
      })
    );
    await writeFile(
      path.join(ext, 'extension.json'),
      JSON.stringify({
        id: 'sample-board',
        name: 'Sample board',
        version: '1.0.0',
        entry: './index.ts',
        contributions: { pages: true },
        serverCapabilities: { secrets },
      })
    );
    await writeFile(path.join(ext, 'index.ts'), 'export {};\n');
    const harness = buildInstallerForTests(dorkHome);
    const approvals = new ApprovalService(createTestDb());
    const handler = createInstallHandler({
      installer: harness.installer,
      confirmationProvider: new TokenConfirmationProvider(approvals),
      consent: { settle: async () => {}, removed: () => {} },
      onPluginsChanged: () => {},
      logger: harness.logger,
    } as unknown as MarketplaceMcpDeps);
    const asked = JSON.parse((await handler({ name: source })).content[0]!.text);
    expect(asked).toMatchObject({ status: 'requires_confirmation' });
    expect(asked.preview.secrets.map((secret: { key: string }) => secret.key)).toEqual([
      'sample_key',
    ]);
    expect(asked.preview.schedules.map((schedule: { name: string }) => schedule.name)).toEqual([
      'Sample check',
    ]);
    approvals.grant(approvals.listPending()[0]!.approvalId);
    const applied = JSON.parse(
      (await handler({ name: source, confirmationToken: asked.confirmationToken })).content[0]!.text
    );
    expect(applied.status).toBe('installed');
    const landed = path.join(dorkHome, 'plugins', 'sample-pack');
    const app = JSON.parse(
      await readFile(
        path.join(landed, '.dork', 'extensions', 'sample-board', 'extension.json'),
        'utf8'
      )
    );
    expect(app.serverCapabilities.secrets).toEqual(secrets);
    expect(
      JSON.parse(await readFile(path.join(landed, '.dork', 'manifest.json'), 'utf8')).schedules
    ).toEqual(schedules);
    expect(await readdir(path.join(dorkHome, 'skills'))).toEqual(['sample-check']);
    const skill = parseFrontmatter(
      await readFile(path.join(dorkHome, 'skills', 'sample-check', 'SKILL.md'), 'utf8')
    );
    expect(skill.data.schedule).toMatchObject({ enabled: false, cron: '0 9 * * *' });
    // A yes discloses secret names; it does not create a secret store or an extra job.
    await expect(access(path.join(dorkHome, 'extension-secrets'))).rejects.toThrow();
    await expect(access(path.join(landed, '.dork', 'secrets.json'))).rejects.toThrow();
  });
});

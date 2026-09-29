/**
 * Creating an agent from a marketplace package in the app (DOR-2325). The app
 * used to clone the package's source as a template, which skipped every
 * package check. It now goes through the marketplace installer: one staged
 * copy, validated, held to the disclosure and files the person was shown, and
 * created where marketplace agents live.
 *
 * The real installer over a local package; only the agent creator's mesh and
 * config collaborators are stubbed (it writes the manifest the route reads).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

vi.mock('../../lib/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
  initLogger: vi.fn(),
}));

import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';
import express from 'express';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { initBoundary } from '../../lib/boundary.js';
import { createAgentsRouter } from '../agents.js';
import { initConfigManager } from '../../services/core/config-manager.js';
import { buildInstallerForTests } from '../../services/marketplace/__tests__/installer-harness.js';
import { disclosedEffectsOf } from '../../services/marketplace/disclosed-effects.js';
import { packageContentHash } from '../../services/marketplace/lib/content-hash.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'services',
  'marketplace',
  'fixtures',
  'valid-agent'
);

const testServer = swappableServer();
let root = '';
let dorkHome = '';
let source = '';
let agentHeader: string | undefined;
let harness: ReturnType<typeof buildInstallerForTests>;

/** Whether anything exists at `p`. */
async function exists(p: string): Promise<boolean> {
  return lstat(p).then(
    () => true,
    () => false
  );
}

/** What the person was shown for the package: its preview's disclosure and hash. */
async function shown() {
  const { preview, packagePath } = await harness.installer.preview({ name: 'valid-agent' });
  return {
    approvedDisclosure: disclosedEffectsOf(preview)!,
    approvedContentHash: await packageContentHash(packagePath),
  };
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'agents-package-create-'));
  dorkHome = path.join(root, 'dork');
  source = path.join(root, 'valid-agent');
  await mkdir(dorkHome, { recursive: true });
  await cp(FIXTURE, source, { recursive: true });
  await initBoundary(root);
  initConfigManager(dorkHome);
  agentHeader = undefined;
  harness = buildInstallerForTests(dorkHome);
  // `valid-agent` resolves to the local copy, as a marketplace name would to
  // its listing: the route takes a package name, never a path.
  const resolve = harness.resolver.resolve.bind(harness.resolver);
  vi.spyOn(harness.resolver, 'resolve').mockImplementation((input: string) =>
    resolve(input === 'valid-agent' ? source : input)
  );
  // The creator writes the manifest the route reads back, with the identity
  // the install passed it.
  harness.spies.createAgentWorkspace.mockImplementation(async (input: unknown) => {
    const opts = input as { directory: string; name: string; displayName?: string };
    const manifest = {
      id: 'agent-from-package',
      name: opts.name,
      ...(opts.displayName ? { displayName: opts.displayName } : {}),
      runtime: 'claude-code',
      registeredAt: '2026-09-24T00:00:00.000Z',
      registeredBy: 'test',
    } as unknown as AgentManifest;
    await writeManifest(opts.directory, manifest);
    return { manifest, path: opts.directory };
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (agentHeader) req.headers['x-dorkos-agent'] = agentHeader;
    next();
  });
  app.use(
    '/api/agents',
    createAgentsRouter(undefined, {
      marketplace: () => ({ installer: harness.installer, dorkHome }),
    })
  );
  testServer.mount(app);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const create = (body: Record<string, unknown>) =>
  request(testServer.server).post('/api/agents/create').send(body);

describe('creating a marketplace agent in the app', () => {
  it('installs it through the installer, with the name the person chose', async () => {
    const res = await create({
      name: 'ignored-slug',
      displayName: 'Reviewer Rae',
      package: { name: 'valid-agent', ...(await shown()) },
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'valid-agent', displayName: 'Reviewer Rae' });
    expect(res.body._path).toBe(path.join(dorkHome, 'agents', 'valid-agent'));
    expect(harness.spies.createAgentWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: 'Reviewer Rae', skipTemplateDownload: true }),
      undefined,
      { marketplace: true }
    );
  });

  it('refuses a package whose files moved after the preview, and installs nothing (the exploit)', async () => {
    const seen = await shown();
    await writeFile(path.join(source, 'notes.md'), 'changed after the preview');

    const res = await create({ name: 'x', package: { name: 'valid-agent', ...seen } });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('disclosure_changed');
    expect(await exists(path.join(dorkHome, 'agents', 'valid-agent'))).toBe(false);
  });

  it('refuses a package that ships settings for its own sessions (DOR-2314)', async () => {
    await mkdir(path.join(source, '.claude'), { recursive: true });
    await writeFile(path.join(source, '.claude', 'settings.json'), '{"hooks":{}}');

    const res = await create({
      name: 'x',
      package: {
        name: 'valid-agent',
        approvedDisclosure: disclosedEffectsOf({
          hooks: [],
          schedules: [],
          mcpServers: [],
          lspServers: [],
          monitors: [],
          executables: [],
          skillTools: [],
          skillCommands: [],
        }),
        approvedContentHash: 'sha256:' + '0'.repeat(64),
      },
    });

    expect(res.status).toBe(400);
    expect(res.body.errors.join('\n')).toContain('.claude/settings.json');
  });

  it('is a person’s only: an agent installs through marketplace_install', async () => {
    agentHeader = 'agent-token';
    const res = await create({ name: 'x', package: { name: 'valid-agent', ...(await shown()) } });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('operator_only');
  });

  it('refuses a second agent from a package already on the team', async () => {
    await mkdir(path.join(dorkHome, 'agents', 'valid-agent'), { recursive: true });
    const res = await create({ name: 'x', package: { name: 'valid-agent', ...(await shown()) } });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('COLLISION');
  });

  it.each(['./valid-agent', 'github:someone/agent', '../../escape'])(
    'refuses %s: a package is named, never a path or an address',
    async (name) => {
      const res = await create({ name: 'x', package: { name, ...(await shown()) } });
      expect(res.status).toBe(400);
      expect(harness.spies.createAgentWorkspace).not.toHaveBeenCalled();
    }
  );

  it('refuses a template and a package together', async () => {
    const res = await create({
      name: 'x',
      template: 'github:a/b',
      package: { name: 'valid-agent', ...(await shown()) },
    });
    expect(res.status).toBe(400);
  });
});

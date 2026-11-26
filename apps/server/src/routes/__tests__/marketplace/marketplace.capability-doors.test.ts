/**
 * @vitest-environment node
 *
 * The marketplace's reads on the capability mount (DOR-4978): an agent reads
 * what it read before, only a person reads the dev links, and every refusal
 * keeps the hand route's code, status and sentence.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import request from '@dorkos/test-utils/supertest';

import { GitRemoteUnreachableError } from '../../../services/marketplace/lib/git/git-tree.js';
import { InvalidPackageError } from '../../../services/marketplace/installer/errors.js';
import { PackageNotFoundError } from '../../../services/marketplace/package-resolver.js';
import { marketplaceFailure } from '../../../services/marketplace/doors/marketplace-refusals.js';
import { toolRefusalProblem } from '../../capability-refusals.js';
import { mapErrorToProblem } from '../../marketplace/shared.js';
import {
  buildSamplePluginManifest,
  tempDir,
  useMarketplaceRoutes,
  writePackageManifest,
} from './marketplace.fixtures.js';

const h = useMarketplaceRoutes();

describe('who reads', () => {
  it('lets an agent read the sources, cache, installs, updates and held-back packages', async () => {
    // Purpose: moving onto the mount must not take a read away from the CLI an agent runs.
    h.updateFlow.planInstallations.mockResolvedValue({ checks: [], steps: [] });
    h.agentHeader = 'agent-token';
    for (const path of ['/sources', '/cache', '/installed', '/updates', '/held-back']) {
      expect((await h.get(path)).status, path).toBe(200);
    }
  });

  it('refuses the dev links to an agent and to a program, before anything is read', async () => {
    // Purpose: the dev links name a person's working folders; no agent or key reads them.
    h.agentHeader = 'agent-token';
    const agent = await h.get('/dev-links');
    expect(agent.status).toBe(403);
    expect(agent.body.code).toBe('person_only');

    h.agentHeader = undefined;
    const program = await request(h.server)
      .get('/api/marketplace/dev-links')
      .set('Authorization', 'Bearer some-key');
    expect(program.status).toBe(403);
    expect(program.body.code).toBe('person_only');
  });

  it('answers the person 503 in the hand route’s words when dev links are not running', async () => {
    const res = await h.get('/dev-links');
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      code: 'temporarily_unavailable',
      detail: "Dev links aren't available on this server right now.",
    });
  });
});

describe('a dev-linked package’s folder', () => {
  /** A global plugin that runs a hook, linked to a working folder, as a dev link records it. */
  function linkFlow(): string {
    const work = tempDir('marketplace-doors-work-');
    writePackageManifest(work, { ...buildSamplePluginManifest(), name: 'flow' });
    mkdirSync(join(work, 'hooks'), { recursive: true });
    writeFileSync(
      join(work, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } })
    );
    mkdirSync(join(h.dorkHome, 'plugins'), { recursive: true });
    const slot = join(h.dorkHome, 'plugins', 'flow');
    symlinkSync(work, slot);
    mkdirSync(join(h.dorkHome, 'marketplace'), { recursive: true });
    writeFileSync(
      join(h.dorkHome, 'marketplace', 'dev-links.json'),
      JSON.stringify({
        version: 1,
        links: [
          {
            name: 'flow',
            type: 'plugin',
            scope: 'global',
            slot,
            target: work,
            linkedAt: '2026-11-25T00:00:00.000Z',
            linkedVia: 'terminal',
          },
        ],
      })
    );
    return work;
  }

  it('reaches a person in the installed and held-back lists, and never an agent', async () => {
    // Purpose: the working folder is a person's; an agent reads the rows without it.
    const work = linkFlow();
    const person = [await h.get('/installed'), await h.get('/held-back')];
    expect(person.map((res) => res.status)).toEqual([200, 200]);
    expect(person.map((res) => JSON.stringify(res.body).includes(work))).toEqual([true, true]);

    h.agentHeader = 'agent-token';
    const agent = [await h.get('/installed'), await h.get('/held-back')];
    expect(agent.map((res) => res.status)).toEqual([200, 200]);
    for (const res of agent) expect(JSON.stringify(res.body)).not.toContain(work);
    expect(agent[0]!.body.packages).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'flow' })])
    );
  });
});

describe('refusals keep their words', () => {
  it('refuses a repeated or outside projectPath on both reads that take one', async () => {
    for (const path of ['/installed', '/updates']) {
      const twice = await h.get(`${path}?projectPath=/a&projectPath=/b`);
      expect(twice.status, path).toBe(400);
      expect(twice.body.detail).toBe('Send `projectPath` only once.');
      const outside = await h.get(`${path}?projectPath=/etc/evil`);
      expect(outside.status, path).toBe(403);
      expect(outside.body).toMatchObject({
        code: 'outside_boundary',
        detail: '`projectPath` is outside the folders DorkOS may use.',
      });
    }
  });

  it('answers 404 for a package that is not installed', async () => {
    const res = await h.get('/installed/not-here');
    expect(res.status).toBe(404);
    expect(res.body.detail).toBe("That package isn't installed here.");
  });

  it('answers an error the marketplace maps with the same code, status and sentence', () => {
    // Purpose: `GET /updates` and `GET /packages` answered through `mapErrorToProblem`.
    for (const err of [
      new GitRemoteUnreachableError('https://example.test/p.git', 'timed out'),
      new PackageNotFoundError('missing'),
      new Error('a fault of its own'),
    ]) {
      const { code, status, detail } = mapErrorToProblem(err);
      expect(toolRefusalProblem(marketplaceFailure(err).payload)).toMatchObject({
        code,
        status,
        detail,
      });
    }
  });

  it('never points at a field the mount does not send', () => {
    // Purpose: the hand route's sentence says "`errors` lists what failed"; the mount sends no `errors`.
    const invalid = new InvalidPackageError(['bad'], []);
    const answer = toolRefusalProblem(marketplaceFailure(invalid).payload);
    expect(answer).toMatchObject({ code: 'invalid_request', detail: "That package isn't valid." });
    expect(answer).not.toHaveProperty('errors');
  });
});

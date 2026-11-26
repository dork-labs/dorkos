/**
 * The file browser's doors on the capability mount (DOR-4978): the writes are a
 * person's, the reads answer an agent as the hand routes did, and no refusal
 * carries a path or a file's text in its sentence.
 */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { listeningServer } from '@dorkos/test-utils/listening-server';
import { noopLogger } from '@dorkos/shared/logger';
import type { CapabilityHandlerContext, CapabilityRequestFacts } from '../../capabilities/index.js';
import { capabilityGroup } from '../../../../http/__tests__/capability-group.js';
import { honoGroupListener } from '../../../../http/__tests__/hono-group-listener.js';
import { testFileDeps } from '../../../../http/__tests__/file-deps.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { logger } from '../../../../lib/logger.js';
import { codesThatCarry } from '../../../../routes/capability-refusals.js';
import { initConfigManager } from '../../config-manager.js';
import { filesDomain } from '../file-capabilities.js';
import { filesSaveCapability } from '../file-save-capability.js';

const server = listeningServer(honoGroupListener(capabilityGroup(filesDomain, testFileDeps())));

let root: string;
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dork-file-doors-')));
  // The `/api` chain reads config (login, the host allowlist): a fresh one, in a throwaway home.
  initConfigManager(root);
  await initBoundary(root);
  writeFileSync(join(root, 'note.md'), 'private words\n');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Every write, with a body or query that would otherwise succeed. */
function writes() {
  return [
    {
      method: 'put',
      path: '/api/files/content',
      body: { cwd: root, path: 'note.md', content: 'x' },
    },
    { method: 'post', path: '/api/files', body: { cwd: root, path: 'new.md', type: 'file' } },
    { method: 'delete', path: `/api/files?cwd=${encodeURIComponent(root)}&path=note.md` },
    { method: 'post', path: '/api/files/rename', body: { cwd: root, from: 'note.md', to: 'b.md' } },
    { method: 'post', path: '/api/files/reveal', body: { cwd: root, path: 'note.md' } },
  ] as const;
}

describe('the file doors', () => {
  it('refuse an agent and a bearer every write, before anything changes', async () => {
    for (const write of writes()) {
      for (const [header, value] of [
        ['X-DorkOS-Agent', 'agent-1'],
        ['Authorization', 'Bearer fixture-token'],
      ] as const) {
        const req = request(server)[write.method](write.path).set(header, value);
        const res = 'body' in write ? await req.send(write.body) : await req;
        expect([write.path, header, res.status, res.body.code]).toEqual([
          write.path,
          header,
          403,
          'person_only',
        ]);
      }
    }
    expect(realpathSync(join(root, 'note.md'))).toBe(join(root, 'note.md'));
  });

  it('refuse a stale save with the file as it is now, and no path or text in the sentence', async () => {
    const res = await request(server)
      .put('/api/files/content')
      .send({ cwd: root, path: 'note.md', content: 'mine', expectedHash: 'stale' });
    expect(res.status).toBe(412);
    expect(res.body.code).toBe('precondition_failed');
    expect(res.body.detail).toBe('This file changed since you opened it.');
    expect(res.body.currentContent).toBe('private words\n');
    expect(res.body.detail).not.toContain(root);
  });

  it('keep a stale save’s file text out of the log', async () => {
    const debug = vi.spyOn(logger, 'debug');
    try {
      const res = await request(server)
        .put('/api/files/content')
        .send({ cwd: root, path: 'note.md', content: 'mine', expectedHash: 'stale' });
      expect(res.body.currentContent).toBe('private words\n');
      const logged = JSON.stringify(debug.mock.calls);
      expect(logged).toContain('FILE_CHANGED_SINCE_OPENED');
      expect(logged).not.toContain('private words');
    } finally {
      debug.mockRestore();
    }
  });

  it('are the only refusal that carries fields to the caller', () => {
    expect(codesThatCarry()).toEqual(['FILE_CHANGED_SINCE_OPENED']);
  });

  it('refuse a path out of the folder with the boundary’s code, never naming it', async () => {
    const res = await request(server)
      .get('/api/files/content')
      .query({ cwd: root, path: '../../etc/hosts' });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('outside_boundary');
    expect(res.text).not.toContain('/etc/hosts');
  });

  it('save a chat canvas document only for the owner', async () => {
    const notOwner = {
      request: { ownerOrNoAccount: false } as CapabilityRequestFacts,
    } as CapabilityHandlerContext;
    const input = {
      cwd: root,
      path: 'note.md',
      content: 'x',
      expectedHash: 'h',
      documentSave: {} as never,
    };
    await expect(
      Promise.resolve().then(() =>
        filesSaveCapability.invoke({ logger: noopLogger, ...testFileDeps() }, input, notOwner)
      )
    ).rejects.toMatchObject({
      payload: { code: 'FILE_DOCUMENT_UNAVAILABLE', error: 'The document is not available.' },
    });
  });
});

/**
 * @vitest-environment node
 *
 * A hub's app page may not frame a plain-`http:` page (DOR-2937): over HTTPS
 * the only one a browser would still frame is its own `localhost`, the
 * computer the person is sitting at, whose previews never render inside a
 * hub. Everything else in the policy is the same as on a person's own
 * computer, which keeps it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from '@dorkos/test-utils/supertest';
import { swappableServer } from '@dorkos/test-utils/listening-server';

const role = vi.hoisted(() => ({ value: 'computer' as 'computer' | 'hub' }));
vi.mock('../../lib/server-role.js', () => ({ currentServerRole: () => role.value }));

import { createClientFiles } from '../client-files.js';

const target = swappableServer();
const server = target.server;
let dist: string;

beforeAll(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-hub-shell-'));
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
  const files = createClientFiles(dist);
  target.mount((req, res) =>
    files(req, res, () => {
      res.statusCode = 404;
      res.end();
    })
  );
});

afterAll(() => {
  fs.rmSync(dist, { recursive: true, force: true });
});

/** The shell's policy at `url`, as a directive -> value lookup. */
async function policyAt(url: string): Promise<Record<string, string>> {
  const header: string = (await request(server).get(url)).headers['content-security-policy'];
  return Object.fromEntries(
    header.split(';').map((directive) => {
      const [name, ...values] = directive.trim().split(/\s+/);
      return [name, values.join(' ')];
    })
  );
}

describe("a hub's app page", () => {
  it.each(['/', '/session'])('frames and embeds no plain-http page at %s', async (url) => {
    role.value = 'hub';
    const policy = await policyAt(url);
    expect(policy['frame-src']).toBe("'self' https:");
    expect(policy['object-src']).toBe("'self' data: https:");
    expect(policy['frame-ancestors']).toBe("'none'");
  });

  it('is otherwise the policy a computer serves', async () => {
    role.value = 'computer';
    const computer = await policyAt('/');
    expect(computer['frame-src']).toBe("'self' https: http:");
    role.value = 'hub';
    const hub = await policyAt('/');
    const differs = Object.keys(computer).filter((name) => computer[name] !== hub[name]);
    expect(differs.sort()).toEqual(['frame-src', 'object-src']);
  });
});

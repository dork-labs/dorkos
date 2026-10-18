import { readFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexWithoutComments } from '../../../../scripts/lib/code-only.mjs';
import { parseConfig } from '../config.js';
import { MIGRATIONS_DIR } from '../startup/space-root.js';
import { createSpaceServer } from '../startup/space-server.js';

const SRC = new URL('../', import.meta.url);
const ENV = {
  COMMUNITY_DATABASE_URL: 'postgres://postgres:pass@localhost:5432/community',
  COMMUNITY_AUTH_SECRET: 'a'.repeat(32),
  COMMUNITY_INVITE_SECRET: 'b'.repeat(32),
  COMMUNITY_BOOTSTRAP_SECRET: 'c'.repeat(32),
  COMMUNITY_PUBLIC_URL: 'http://localhost:6481',
  COMMUNITY_STORAGE_PATH: '/tmp/community-blobs',
};

describe('createSpaceServer', () => {
  it('leaves the paid post checks to the entry', () => {
    // Purpose: fails if the library reads the paid flag or the environment itself, so that
    // importing it could arm a paid model call; only main.ts arms them (AGENTS.md money paths).
    const library = lexWithoutComments(
      readFileSync(new URL('startup/space-server.ts', SRC), 'utf8')
    ).code;
    expect(library).not.toMatch(/\bPAID_DECISIONS_ARMED\b|\bDECISIONS_PAID_FLAG\b|process\.env/u);
    const entry = readFileSync(new URL('main.ts', SRC), 'utf8');
    expect(entry).toMatch(/paidDecisionsArmed: PAID_DECISIONS_ARMED/u);
  });

  it('refuses an evidence folder inside the web folder it is given', () => {
    // Purpose: the settings check evidence against the default web folder only; fails if a
    // caller's own web folder could publish takedown evidence.
    // Outside the temporary folder, which the settings refuse on their own; it need not exist.
    const webDir = '/srv/space-web';
    const config = parseConfig({
      ...ENV,
      COMMUNITY_EVIDENCE_DRIVER: 'filesystem',
      COMMUNITY_EVIDENCE_PATH: join(webDir, 'evidence'),
    });
    expect(() =>
      createSpaceServer({
        config,
        env: {},
        migrationsDir: MIGRATIONS_DIR,
        webDir,
        paidDecisionsArmed: false,
      })
    ).toThrow('COMMUNITY_EVIDENCE_PATH must not be, contain, or sit inside the web app folder');
  });

  it('stops cleanly before it was started', async () => {
    // Purpose: fails if stopping a server that never started throws or touches the database.
    const space = createSpaceServer({
      config: parseConfig(ENV),
      env: {},
      migrationsDir: MIGRATIONS_DIR,
      webDir: mkdtempSync(join(tmpdir(), 'space-web-')),
      paidDecisionsArmed: false,
    });
    await expect(space.stop()).resolves.toBeUndefined();
  });
});

/**
 * @vitest-environment node
 *
 * DOR-4358 on the real macOS sandbox: DorkOS's rendered profile, run through
 * the pinned Codex binary's own `codex sandbox` (no model, no network, a
 * throwaway home and project under it, made-up files only).
 *
 * Before the fix, a deep deny glob made Seatbelt refuse removing or renaming
 * any folder under its base, so the client tests' fixture teardown failed with
 * EPERM. Rendered as Linux renders it (the old globs), that still happens;
 * rendered for macOS, it doesn't. And Security's Must holds: an exact deny
 * can't be uncovered by renaming its parent or grandparent or by a hard link.
 *
 * macOS only, and only where the vendored binary is installed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexVendoredBinary } from '../check-dependencies.js';
import { resetBackgroundScans, settleBackgroundScans } from '../policy/expand-deep-globs.js';
import { codexVendoredRg } from '../policy/hidden-folder-scans.js';
import { codexPermissionProfile, codexProtectedConfig } from '../policy/protected-profile.js';

const BINARY = resolveCodexVendoredBinary();
const FIXTURE = 'apps/client/src/layers/entities/__dag-fixture-x__';
const realPlatform = process.platform;

let root: string;
let home: string;
let project: string;
let codexHome: string;

// Find Codex's `rg` on the real platform once, before any render pretends to be
// Linux: the lookup is per platform and remembered for the process.
beforeAll(() => {
  codexVendoredRg();
});

beforeEach(() => {
  resetBackgroundScans();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codex-seatbelt-')));
  home = path.join(root, 'home');
  // Under the home, as a real repo is: a home-based glob locked it too.
  project = path.join(home, 'code', 'repo');
  codexHome = path.join(root, 'codex-home');
  for (const dir of [
    path.join(home, '.dork'),
    path.join(home, '.claude'),
    path.join(home, '.ssh'),
    path.join(project, 'apps/client/src/layers/entities'),
    path.join(project, 'deep/parent'),
    path.join(project, 'a/b/c'),
    codexHome,
  ])
    fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, 'deep/parent/site.pem'), 'made-up key');
  fs.writeFileSync(path.join(project, 'a/b/c/key.pem'), 'made-up key');
  fs.writeFileSync(path.join(home, '.ssh/known_hosts'), 'example.com ssh-ed25519 AAAAmadeup\n');
  fs.writeFileSync(path.join(home, '.ssh/id_made_up'), 'made-up private key');
});
afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: realPlatform });
  await settleBackgroundScans();
  resetBackgroundScans();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A TOML value: JSON's string escapes are valid TOML basic strings. */
function tomlValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/** The profile's config as TOML: plain values first, then each nested table. */
function toToml(table: Record<string, unknown>, prefix: string[] = []): string {
  const plain: string[] = [];
  const nested: string[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (value !== null && typeof value === 'object') {
      const name = [...prefix, key];
      const inner = value as Record<string, unknown>;
      const leaves = Object.entries(inner).filter(([, v]) => v === null || typeof v !== 'object');
      nested.push(`[${name.map((part) => JSON.stringify(part)).join('.')}]`);
      for (const [k, v] of leaves) nested.push(`${JSON.stringify(k)} = ${tomlValue(v)}`);
      const deeper = Object.fromEntries(
        Object.entries(inner).filter(([, v]) => v !== null && typeof v === 'object')
      );
      if (Object.keys(deeper).length > 0) nested.push(toToml(deeper, name));
    } else {
      plain.push(`${JSON.stringify(key)} = ${tomlValue(value)}`);
    }
  }
  return [...plain, ...nested].join('\n');
}

/** Render the profile for `platform`, letting the background scan land, and save it. */
async function writeProfile(platform: NodeJS.Platform, permissionMode: string): Promise<string> {
  Object.defineProperty(process, 'platform', { value: platform });
  const roots = {
    cwd: project,
    data: path.join(home, '.dork'),
    home,
    accounts: [path.join(home, '.claude')],
    agentFolders: [project],
    agentHomes: [],
  };
  const settings = { permissionMode };
  codexProtectedConfig(project, { roots, writable: [] }, settings);
  await settleBackgroundScans();
  const config = codexProtectedConfig(project, { roots, writable: [] }, settings);
  Object.defineProperty(process, 'platform', { value: realPlatform });
  fs.writeFileSync(path.join(codexHome, 'config.toml'), `${toToml(config)}\n`);
  return codexPermissionProfile(settings);
}

/** Run a shell script inside the sandbox from the project, and return what it printed. */
function inSandbox(profile: string, script: string): string {
  return execFileSync(
    BINARY!,
    ['sandbox', '-P', profile, '-C', project, '--', 'sh', '-c', script],
    {
      env: { PATH: '/usr/bin:/bin', HOME: home, CODEX_HOME: codexHome },
      encoding: 'utf8',
      timeout: 60_000,
    }
  );
}

/** The client fixture's setup and teardown, as `lint-fixtures.ts` does them. */
const FIXTURE_CYCLE = [
  `mkdir -p ${FIXTURE}/model && echo 'export const x = 1;' > ${FIXTURE}/model/x.ts`,
  `rm -rf ${FIXTURE} 2>/dev/null && [ ! -e ${FIXTURE} ] && echo TEARDOWN-OK || echo TEARDOWN-FAIL`,
  'mkdir -p m1/m2 && mv m1 m3 2>/dev/null && echo RENAME-OK || echo RENAME-FAIL',
].join('; ');

describe.skipIf(realPlatform !== 'darwin' || !BINARY)('the macOS sandbox (DOR-4358)', () => {
  it.each(['acceptEdits', 'bypassPermissions'])(
    'at %s, the old globs lock every folder; the macOS profile frees them',
    async (permissionMode) => {
      const old = await writeProfile('linux', permissionMode);
      const before = inSandbox(old, FIXTURE_CYCLE);
      expect(before).toContain('TEARDOWN-FAIL');
      expect(before).toContain('RENAME-FAIL');
      fs.rmSync(path.join(project, FIXTURE), { recursive: true, force: true });
      fs.rmSync(path.join(project, 'm1'), { recursive: true, force: true });

      const mac = await writeProfile('darwin', permissionMode);
      const after = inSandbox(mac, FIXTURE_CYCLE);
      expect(after).toContain('TEARDOWN-OK');
      expect(after).toContain('RENAME-OK');
    }
  );

  it.each(['acceptEdits', 'bypassPermissions'])(
    'at %s, an exact deny stays shut through a parent or grandparent rename and a hard link',
    async (permissionMode) => {
      const profile = await writeProfile('darwin', permissionMode);
      const out = inSandbox(
        profile,
        [
          'cat deep/parent/site.pem >/dev/null 2>&1 && echo READ-OPEN || echo READ-SHUT',
          'mv deep/parent deep/moved 2>/dev/null && echo PARENT-MOVED || echo PARENT-REFUSED',
          'mv deep deep2 2>/dev/null && echo GRANDPARENT-MOVED || echo GRANDPARENT-REFUSED',
          'mv a a2 2>/dev/null && echo THIRD-MOVED || echo THIRD-REFUSED',
          'mv deep/parent/site.pem deep/parent/x.pem 2>/dev/null && echo FILE-MOVED || echo FILE-REFUSED',
          'ln deep/parent/site.pem hard-link 2>/dev/null && echo LINK-MADE || echo LINK-REFUSED',
          'cat hard-link >/dev/null 2>&1 && echo LINK-READ-OPEN || echo LINK-READ-SHUT',
        ].join('; ')
      );
      expect(out).toContain('READ-SHUT');
      expect(out).toContain('PARENT-REFUSED');
      expect(out).toContain('GRANDPARENT-REFUSED');
      // Three levels up (`a/b/c/key.pem`), and the denied file itself (Security S5).
      expect(out).toContain('THIRD-REFUSED');
      expect(out).toContain('FILE-REFUSED');
      // Refused outright today; if Codex ever allowed the link, the key must still not read.
      expect(out).toMatch(/LINK-REFUSED|LINK-READ-SHUT/);
      expect(out).not.toContain('LINK-READ-OPEN');
    }
  );

  it.each(['acceptEdits', 'bypassPermissions'])(
    'at %s, a secret in a folder the person shut with chmod 000 stays shut after the agent reopens it',
    async (permissionMode) => {
      // Security's Must 2: the scan can't read the folder, but the agent runs as
      // its owner and can `chmod` it open, so the base keeps its glob.
      const locked = path.join(project, 'locked');
      fs.mkdirSync(locked);
      fs.writeFileSync(path.join(locked, '.env'), 'made-up secret');
      fs.chmodSync(locked, 0o000);
      try {
        const profile = await writeProfile('darwin', permissionMode);
        const out = inSandbox(
          profile,
          'chmod 700 locked 2>/dev/null; cat locked/.env >/dev/null 2>&1 && echo LOCKED-READ-OPEN || echo LOCKED-READ-SHUT'
        );
        expect(out).toContain('LOCKED-READ-SHUT');
      } finally {
        fs.chmodSync(locked, 0o700);
      }
    }
  );

  it.each(['acceptEdits', 'bypassPermissions'])(
    'at %s, known_hosts reads but never writes, and the key beside it stays shut',
    async (permissionMode) => {
      const profile = await writeProfile('darwin', permissionMode);
      const out = inSandbox(
        profile,
        [
          'cat "$HOME/.ssh/known_hosts" >/dev/null 2>&1 && echo HOSTS-READ || echo HOSTS-SHUT',
          'echo x >> "$HOME/.ssh/known_hosts" 2>/dev/null && echo HOSTS-WRITTEN || echo HOSTS-NO-WRITE',
          'cat "$HOME/.ssh/id_made_up" >/dev/null 2>&1 && echo KEY-OPEN || echo KEY-SHUT',
        ].join('; ')
      );
      expect(out).toContain('HOSTS-READ');
      expect(out).toContain('HOSTS-NO-WRITE');
      expect(out).toContain('KEY-SHUT');
    }
  );
});

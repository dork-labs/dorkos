import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '@dorkos/skills/frontmatter';
import { OPERATING_SKILLS_PACK } from '../pack.js';
import { seedOperatingSkills } from '../seed.js';
import { APP_BUILDER_PACK_PIN, buildingDorkosApps } from '../skills/building-dorkos-apps.js';

/**
 * The App Builder Pack is vendored byte for byte from one pinned marketplace
 * version (DOR-4061). Security reviewed exactly that tree, so these tests pin
 * three links of one chain: the vendored tree is the reviewed tree, the skill
 * DorkOS ships is the vendored tree, and what the seeder writes is that skill.
 */

/** The reviewed tree's `MANIFEST.sha256`, hashed. Security and Design OK'd this exact value. */
const REVIEWED_MANIFEST_SHA256 = 'e23f5eb8de5229a141d9890c3a20d6389453a84c57be4c727e1d1ca517010ade';

const PACK_DIR = fileURLToPath(new URL('../skills/app-builder-pack/', import.meta.url));
const SKILL_DIR = path.join(PACK_DIR, 'skills', 'building-dorkos-apps');

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Every file under `dir`, as POSIX paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const rel = prefix ? `${prefix}/${entry}` : entry;
    const abs = path.join(dir, entry);
    return statSync(abs).isDirectory() ? listFiles(abs, rel) : [rel];
  });
}

/** `MANIFEST.sha256` parsed into [hash, relative path] pairs. */
function manifestEntries(): Array<[string, string]> {
  return readFileSync(path.join(PACK_DIR, 'MANIFEST.sha256'), 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const match = /^([0-9a-f]{64}) {2}(.+)$/.exec(line);
      if (!match) throw new Error(`Unreadable MANIFEST.sha256 line: ${line}`);
      return [match[1]!, match[2]!];
    });
}

describe('the vendored App Builder Pack is the reviewed tree', () => {
  it('carries the reviewed MANIFEST.sha256, byte for byte', () => {
    expect(sha256(readFileSync(path.join(PACK_DIR, 'MANIFEST.sha256')))).toBe(
      REVIEWED_MANIFEST_SHA256
    );
    expect(APP_BUILDER_PACK_PIN.manifestSha256).toBe(REVIEWED_MANIFEST_SHA256);
  });

  it('matches every SHA-256 its manifest lists', () => {
    const entries = manifestEntries();
    // Pinned to the reviewed count, so a manifest that stopped parsing cannot
    // pass by checking nothing.
    expect(entries).toHaveLength(7);
    for (const [hash, rel] of entries) {
      expect({ file: rel, hash: sha256(readFileSync(path.join(PACK_DIR, rel))) }).toEqual({
        file: rel,
        hash,
      });
    }
  });

  it('holds no file the manifest does not list', () => {
    const listed = manifestEntries().map(([, rel]) => rel);
    expect(listFiles(PACK_DIR).sort()).toEqual([...listed, 'MANIFEST.sha256'].sort());
  });

  it('records the version its own manifest names', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACK_DIR, '.dork', 'manifest.json'), 'utf-8')
    );
    expect(manifest.name).toBe('app-builder-pack');
    expect(APP_BUILDER_PACK_PIN.version).toBe(manifest.version);
    expect(APP_BUILDER_PACK_PIN.version).toBe('1.1.1');
  });
});

describe('the shipped skill is the vendored tree', () => {
  const vendoredSkill = readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8');

  it('is in the Operating DorkOS pack', () => {
    expect(OPERATING_SKILLS_PACK).toContain(buildingDorkosApps);
  });

  it('takes its name, description and body from the vendored SKILL.md', () => {
    const { data, content } = parseFrontmatter(vendoredSkill);
    expect(buildingDorkosApps.name).toBe('building-dorkos-apps');
    expect(buildingDorkosApps.name).toBe(data.name);
    expect(buildingDorkosApps.description).toBe(data.description);
    expect(buildingDorkosApps.body.trim()).toBe(content.trim());
  });

  it('ships every supporting file byte for byte', () => {
    const supporting = listFiles(SKILL_DIR).filter((f) => f !== 'SKILL.md');
    expect(supporting.sort()).toEqual(['example.md', 'pitfalls.md', 'placement.md']);
    expect(Object.keys(buildingDorkosApps.files ?? {}).sort()).toEqual(supporting);
    for (const file of supporting) {
      expect(sha256(buildingDorkosApps.files![file]!)).toBe(
        sha256(readFileSync(path.join(SKILL_DIR, file)))
      );
    }
  });
});

describe('seeding writes the vendored skill', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'app-builder-pack-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes SKILL.md with the vendored body and each supporting file byte for byte', async () => {
    await seedOperatingSkills(root);
    const seededDir = path.join(root, '.agents', 'skills', 'building-dorkos-apps');

    const { data, content } = parseFrontmatter(
      await readFile(path.join(seededDir, 'SKILL.md'), 'utf-8')
    );
    const vendored = parseFrontmatter(readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf-8'));
    expect(data.name).toBe(vendored.data.name);
    expect(data.description).toBe(vendored.data.description);
    expect(content.trim()).toBe(vendored.content.trim());

    for (const file of ['example.md', 'pitfalls.md', 'placement.md']) {
      expect(sha256(await readFile(path.join(seededDir, file)))).toBe(
        sha256(readFileSync(path.join(SKILL_DIR, file)))
      );
    }
  });
});

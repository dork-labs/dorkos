import { parseFrontmatter } from '@dorkos/skills/frontmatter';
import type { OperatingSkill } from '../pack.js';
import { BUILDING_DORKOS_APPS_FILES } from './building-dorkos-apps.files.js';

/**
 * The marketplace pack this skill is vendored from, and the hash of the
 * `MANIFEST.sha256` Security and Design reviewed (DOR-4061). The vendored tree
 * sits in `./app-builder-pack/`; `../../scripts/sync-app-builder-pack.ts` turns it
 * into the strings this module reads.
 */
export const APP_BUILDER_PACK_PIN = {
  name: 'app-builder-pack',
  version: '1.1.1',
  manifestSha256: 'e23f5eb8de5229a141d9890c3a20d6389453a84c57be4c727e1d1ca517010ade',
} as const;

const { 'SKILL.md': skillFile, ...supportingFiles } = BUILDING_DORKOS_APPS_FILES;
const { data, content } = parseFrontmatter(skillFile);
if (typeof data.name !== 'string' || typeof data.description !== 'string') {
  throw new Error('The vendored building-dorkos-apps SKILL.md has no name or description.');
}

/**
 * Teaches any agent to build a small DorkOS app (an extension) for the person it
 * works with: the placement interview, scaffold, test, check it started, and
 * tell the person what it reaches. Shipped verbatim from the pinned pack; its
 * supporting files are seeded beside SKILL.md.
 */
export const buildingDorkosApps: OperatingSkill = {
  name: data.name,
  description: data.description,
  body: content.trim(),
  files: supportingFiles,
};

/**
 * J-11 — an agent workspace's whole life, three boots deep.
 *
 * Somebody creates an agent from a template. DorkOS owns that directory, so the
 * boot pass runs there unattended: it seeds the Operating DorkOS pack and links
 * every skill where Claude Code reads it. Then the server restarts twice more,
 * and between the boots two things happen that a person would never report — the
 * pack ships a new version, and a link gets deleted by hand.
 *
 * The contract's J-11 row says what must be true across all of that: the pack is
 * seeded and linked on creation, boot 2 changes nothing at all, a bump rewrites
 * only DorkOS's OWN unmodified copies and links whatever the bump added on the
 * same pass, the hand-deleted link is back after boot 3, and a person's
 * same-named skill is preserved throughout. Every one of those is measured here
 * as an exact before/after tree diff, so "changes nothing" means nothing rather
 * than nothing anybody checked.
 *
 * The fixture writes files with the journey kit's own writers
 * (`@dorkos/harness/journeys`) but not with `stageRepo`: that DSL describes a
 * REPOSITORY, and an agent home is not one — it has no manifest until the boot
 * writes it, no harnesses of its own, and its skills come from the real seeder
 * rather than from a spec.
 *
 * Rows: J-11, SRC-05 (the skill pack as a source), TR-03/TR-04 (the creation and
 * boot triggers), AP-01 (a projection is repaired, not duplicated), AP-13 (a
 * person's file at a managed name is never overwritten).
 *
 * @vitest-environment node
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OPERATING_SKILLS_PACK, OPERATING_SKILLS_VERSION } from '@dorkos/operating-skills';
import {
  diffSnapshots,
  readText,
  skillFile,
  snapshotTree,
  writeFileAt,
} from '@dorkos/harness/journeys';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { backfillAgentWorkspaceSkills } from '../../project-agent-workspace.js';
import { readSeededSkill, writeStalePackSkill } from './pack-stamp.js';

/** The pack skill this journey lets go stale, and the one it deletes to model a bump. */
const [UPGRADED, ADDED_BY_BUMP] = OPERATING_SKILLS_PACK;

/** The pack name the person happens to have written a skill of their own under. */
const PERSON_SKILL = OPERATING_SKILLS_PACK[2]?.name ?? '';

/** Every name the pack ships, sorted — what a provisioned workspace must hold. */
const PACK_NAMES = OPERATING_SKILLS_PACK.map((skill) => skill.name).sort();

let dorkHome = '';
let agentDir = '';

/** One server boot over this dork home's agents. */
async function boot(): Promise<{ seeded: number; projected: number }> {
  const summary = await backfillAgentWorkspaceSkills([agentDir], dorkHome);
  return { seeded: summary.seeded, projected: summary.projected };
}

/** Where Claude Code reads this workspace's skills. */
function claudeSkillsDir(): string {
  return join(agentDir, '.claude', 'skills');
}

beforeEach(() => {
  vi.clearAllMocks();
  dorkHome = mkdtempSync(join(tmpdir(), 'harness-j11-home-'));
  agentDir = join(dorkHome, 'agents', 'scribe');
  mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
  rmSync(dorkHome, { recursive: true, force: true });
  dorkHome = '';
  agentDir = '';
});

describe('J-11 — an agent workspace across three boots', () => {
  it('J-11, SRC-05, TR-03: creation seeds the pack and links every skill in one pass', async () => {
    // The template leaves a directory and nothing else — the state 12 of the 13
    // agents on the machine that motivated this pass were actually in.
    expect(readdirSync(agentDir)).toEqual([]);
    expect(PACK_NAMES).toHaveLength(7);

    expect(await boot()).toEqual({ seeded: 1, projected: 1 });

    expect(readdirSync(claudeSkillsDir()).sort()).toEqual(PACK_NAMES);
    for (const name of PACK_NAMES) {
      const link = join(claudeSkillsDir(), name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(realpathSync(join(agentDir, '.agents', 'skills', name)));
    }
  });

  it('J-11, TR-04, AP-01: the second boot changes not one byte', async () => {
    await boot();
    const settled = snapshotTree(agentDir);
    // Zero-subject guard: there IS a tree to leave alone.
    expect(settled.size).toBeGreaterThan(PACK_NAMES.length * 2);

    expect(await boot()).toEqual({ seeded: 0, projected: 1 });

    expect(diffSnapshots(settled, snapshotTree(agentDir))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('J-11, SRC-05, AP-01: a pack bump rewrites its own stale copy and links what it added', async () => {
    await boot();
    // The bump, staged from both sides: one skill DorkOS wrote is left stamped at
    // an older version, and one is gone entirely — which is what a workspace
    // seeded before that skill existed looks like.
    const staleBody = `# ${UPGRADED!.name}\n\nGuidance from an older pack version.`;
    await writeStalePackSkill(agentDir, UPGRADED!.name, staleBody, 1);
    rmSync(join(agentDir, '.agents', 'skills', ADDED_BY_BUMP!.name), {
      recursive: true,
      force: true,
    });
    rmSync(join(claudeSkillsDir(), ADDED_BY_BUMP!.name), { force: true });
    expect(readSeededSkill(agentDir, UPGRADED!.name)).toEqual({ body: staleBody, version: '1' });
    const before = snapshotTree(agentDir);

    expect(await boot()).toEqual({ seeded: 1, projected: 1 });

    // Exactly two skills move, and the missing one is linked on the SAME pass —
    // not on the boot after, which is the ordering DOR-671 was about.
    expect(diffSnapshots(before, snapshotTree(agentDir))).toEqual({
      added: [
        `.agents/skills/${ADDED_BY_BUMP!.name}`,
        `.agents/skills/${ADDED_BY_BUMP!.name}/SKILL.md`,
        `.claude/skills/${ADDED_BY_BUMP!.name}`,
      ].sort(),
      changed: [`.agents/skills/${UPGRADED!.name}/SKILL.md`],
      removed: [],
    });
    expect(readSeededSkill(agentDir, UPGRADED!.name)).toEqual({
      body: UPGRADED!.body.trim(),
      version: String(OPERATING_SKILLS_VERSION),
    });
  });

  it('J-11, AP-01: a link deleted by hand between boots is back after the next one', async () => {
    await boot();
    const settled = snapshotTree(agentDir);

    rmSync(join(claudeSkillsDir(), UPGRADED!.name), { force: true });
    expect(diffSnapshots(settled, snapshotTree(agentDir))).toEqual({
      added: [],
      changed: [],
      removed: [`.claude/skills/${UPGRADED!.name}`],
    });

    await boot();

    // Back, and nothing else moved with it — a repair, not a re-seed.
    expect(diffSnapshots(settled, snapshotTree(agentDir))).toEqual({
      added: [],
      changed: [],
      removed: [],
    });
  });

  it('J-11, AP-13: a person’s own skill at a pack name survives every boot', async () => {
    // Written before the first boot, so the seeder meets it the moment it looks:
    // no DorkOS stamp on it, so it is the person's and must never be rewritten.
    const mine = skillFile({ name: PERSON_SKILL });
    writeFileAt(join(agentDir, '.agents', 'skills', PERSON_SKILL, 'SKILL.md'), mine);

    await boot();
    const afterCreation = readText(join(agentDir, '.agents', 'skills', PERSON_SKILL, 'SKILL.md'));
    await boot();
    await writeStalePackSkill(agentDir, UPGRADED!.name, '# old\n', 1);
    await boot();

    expect(afterCreation).toBe(mine);
    expect(readText(join(agentDir, '.agents', 'skills', PERSON_SKILL, 'SKILL.md'))).toBe(mine);
    // …and it is still linked where Claude Code reads it, so preserving it did
    // not mean quietly dropping it out of the workspace.
    expect(readdirSync(claudeSkillsDir()).sort()).toEqual(PACK_NAMES);
  });
});

import fs from 'fs/promises';
import path from 'path';
import { ulid } from 'ulidx';
import { readManifest, writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { defaultSoulTemplate, defaultNopeTemplate } from '@dorkos/shared/convention-files';
import { writeConventionFile } from '@dorkos/shared/convention-files-io';
import { renderTraits } from '@dorkos/shared/trait-renderer';
import { dorkbotClaudeMdTemplate } from '@dorkos/shared/dorkbot-templates';
import { DEFAULT_TRAITS } from '@dorkos/shared/trait-renderer';
import { scaffoldInstructions } from '@dorkos/harness';
import { seedOperatingSkills } from '@dorkos/operating-skills';
import type { MeshCore } from '@dorkos/mesh';
import { logger } from '../../lib/logger.js';

/**
 * Seed (or re-seed) the Operating DorkOS skill pack into DorkBot's home.
 *
 * Runs on every boot so DorkBot picks up newer pack versions; idempotent and
 * version-stamped, and best-effort so a seeding hiccup never blocks boot (which
 * must finish before the task watchers start).
 *
 * @param dorkbotDir - DorkBot's workspace root.
 */
async function seedDorkbotSkills(dorkbotDir: string): Promise<void> {
  try {
    await seedOperatingSkills(dorkbotDir);
  } catch (err) {
    logger.warn('[Mesh] Failed to seed DorkBot Operating DorkOS skill pack: %s', String(err));
  }
}

/** DorkBot's branded display name — the label every roster surface renders. */
const DORKBOT_DISPLAY_NAME = 'DorkBot';

/**
 * Ensure DorkBot exists as the system agent.
 *
 * Four paths:
 * 1. **Fresh install** — scaffold workspace at `<dorkHome>/agents/dorkbot/` with full manifest
 * 2. **Upgrade** — existing DorkBot missing `isSystem: true` gets patched (and its
 *    display name backfilled)
 * 3. **Backfill** — an existing system-agent DorkBot with no `displayName` gets one,
 *    so the roster and dashboard composer show "DorkBot" rather than the bare slug
 * 4. **Already correct** — no manifest rewrite, just a re-sync
 *
 * Must run before task file watchers start (DorkBot is the background task agent).
 *
 * @param meshCore - MeshCore instance for DB sync
 * @param dorkHome - Resolved data directory path (`~/.dork/` in prod)
 */
export async function ensureDorkBot(meshCore: MeshCore, dorkHome: string): Promise<void> {
  const dorkbotDir = path.join(dorkHome, 'agents', 'dorkbot');
  const existing = await readManifest(dorkbotDir);

  if (existing) {
    const isSystemAgent = existing.isSystem && existing.namespace === 'system';

    // Path 2: not yet a system agent — upgrade it, backfilling the display name
    // (a display name the user already set is preserved).
    if (!isSystemAgent) {
      const upgraded: AgentManifest = {
        ...existing,
        isSystem: true,
        namespace: 'system',
        capabilities: ['tasks', 'summaries'],
        displayName: existing.displayName ?? DORKBOT_DISPLAY_NAME,
      };
      await writeManifest(dorkbotDir, upgraded);
      logger.info('[Mesh] Upgraded existing DorkBot to system agent');
    } else if (!existing.displayName) {
      // Path 3: already a system agent but missing its display name — backfill it
      // so every roster surface renders "DorkBot", not "dorkbot".
      const named: AgentManifest = { ...existing, displayName: DORKBOT_DISPLAY_NAME };
      await writeManifest(dorkbotDir, named);
      logger.info('[Mesh] Backfilled DorkBot display name');
    } else {
      // Path 4: already correct — no manifest rewrite.
      logger.debug('[Mesh] DorkBot already registered as system agent');
    }

    // Common tail for every existing-DorkBot path: re-seed the skill pack (picks
    // up newer pack versions on boot) then sync. registerAgent re-asserts default
    // access rules on every boot, so existing installs pick up newly-introduced
    // rules (e.g. the system-agent cross-namespace allow) without a manifest change.
    await seedDorkbotSkills(dorkbotDir);
    await meshCore.syncFromDisk(dorkbotDir);
    return;
  }

  // Path 1: Fresh install — scaffold full workspace
  await fs.mkdir(path.join(dorkbotDir, '.dork'), { recursive: true });

  const manifest: AgentManifest = {
    id: ulid(),
    name: 'dorkbot',
    displayName: DORKBOT_DISPLAY_NAME,
    description: 'Your guide to DorkOS — helps you learn the platform and handles background jobs',
    runtime: 'claude-code',
    capabilities: ['tasks', 'summaries'],
    isSystem: true,
    namespace: 'system',
    behavior: { responseMode: 'always' },
    traits: { ...DEFAULT_TRAITS },
    conventions: { soul: true, nope: true, dorkosKnowledge: true },
    registeredAt: new Date().toISOString(),
    registeredBy: 'dorkos-system',
    personaEnabled: true,
    enabledToolGroups: {},
  };

  await writeManifest(dorkbotDir, manifest);

  // Scaffold convention files
  const traitBlock = renderTraits(DEFAULT_TRAITS);
  await writeConventionFile(dorkbotDir, 'SOUL.md', defaultSoulTemplate('DorkBot', traitBlock));
  await writeConventionFile(dorkbotDir, 'NOPE.md', defaultNopeTemplate());

  // Scaffold cross-harness instruction files: a canonical root AGENTS.md (DorkBot's
  // orientation template) plus per-harness pointers. Replaces the old
  // `.dork/AGENTS.md`, which nothing read — the harness + agent discovery both read
  // the root-level AGENTS.md.
  scaffoldInstructions(dorkbotDir, { agentsBody: dorkbotClaudeMdTemplate() });

  // Seed the Operating DorkOS skill pack so DorkBot ships knowing how to run DorkOS.
  await seedDorkbotSkills(dorkbotDir);

  // Sync to Mesh DB
  await meshCore.syncFromDisk(dorkbotDir);
  logger.info('[Mesh] Created DorkBot system agent at %s', dorkbotDir);
}

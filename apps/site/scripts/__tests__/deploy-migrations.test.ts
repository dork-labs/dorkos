/**
 * What a deploy migrates, and what it must never migrate.
 *
 * The control-plane tables share one database with the DorkOS Cloud control
 * plane, which owns their schema and migrates them from its own history into
 * the same journal table. A site deploy that ran the site's control-plane
 * history as well interleaved the two, and the control plane skipped its own
 * migrations (2026-09-26). These cases pin every path by which a deploy could
 * do that again: the build command, the `db:migrate` script, the baseline
 * step's history selection, and the drizzle config itself.
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { refuseControlPlaneMigrationOnVercel } from '../control-plane-deploy-guard';
import { MIGRATION_HISTORIES, selectHistories } from '../migration-histories';

const SITE_ROOT = fileURLToPath(new URL('../../', import.meta.url));

const scripts = (
  JSON.parse(readFileSync(join(SITE_ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts;
const vercel = JSON.parse(readFileSync(join(SITE_ROOT, 'vercel.json'), 'utf8')) as {
  buildCommand: string;
};

const CONTROL_PLANE = MIGRATION_HISTORIES.find((h) => h.id === 'control-plane')!;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('what a deploy migrates', () => {
  it('runs `pnpm db:migrate` before the build', () => {
    expect(vercel.buildCommand.startsWith('pnpm db:migrate &&')).toBe(true);
  });

  it('`db:migrate` baselines and migrates the public history only', () => {
    expect(scripts['db:migrate']).toBe(
      'tsx scripts/baseline-migrations.ts public && drizzle-kit migrate --config drizzle.public.config.ts'
    );
    expect(scripts['db:migrate']).not.toMatch(/control-plane/);
  });

  it('marks exactly the public history as applied on deploy', () => {
    expect(MIGRATION_HISTORIES.filter((h) => h.appliedOnDeploy).map((h) => h.id)).toEqual([
      'public',
    ]);
  });

  it('keeps the control-plane history runnable for local and test databases', () => {
    expect(scripts['db:migrate:control-plane']).toBe(
      'tsx scripts/baseline-migrations.ts control-plane && drizzle-kit migrate --config drizzle.control-plane.config.ts'
    );
  });
});

describe('the Vercel refusal', () => {
  it.each([
    ['production', { VERCEL: '1', VERCEL_ENV: 'production' }],
    ['preview', { VERCEL: '1', VERCEL_ENV: 'preview' }],
    ['a build exposing only VERCEL', { VERCEL: '1' }],
    ['a build exposing only VERCEL_ENV', { VERCEL_ENV: 'preview' }],
  ])('refuses the control-plane history in %s', (_name, env) => {
    expect(() => refuseControlPlaneMigrationOnVercel(env)).toThrow(/Refusing/);
    expect(() => selectHistories(['control-plane'], env)).toThrow(/Refusing/);
  });

  it('still lets a Vercel build baseline the public history', () => {
    expect(selectHistories(['public'], { VERCEL: '1', VERCEL_ENV: 'production' })).toEqual([
      MIGRATION_HISTORIES.find((h) => h.id === 'public'),
    ]);
  });

  it('lets a local run name either history', () => {
    expect(selectHistories(['public', 'control-plane'], {}).map((h) => h.id)).toEqual([
      'public',
      'control-plane',
    ]);
  });

  it('refuses to guess when no history, or an unknown one, is named', () => {
    // The script used to walk every history; an empty argument list must not
    // quietly bring that back.
    expect(() => selectHistories([], {})).toThrow(/name the history/);
    expect(() => selectHistories(['everything'], {})).toThrow(/unknown migration history/);
  });

  it('refuses to load the control-plane drizzle config inside a Vercel build', async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('VERCEL_ENV', 'production');
    await expect(import('../../drizzle.control-plane.config')).rejects.toThrow(/Refusing/);
  });

  it('loads the control-plane drizzle config anywhere else', async () => {
    vi.stubEnv('VERCEL', '');
    vi.stubEnv('VERCEL_ENV', '');
    const config = (await import('../../drizzle.control-plane.config')).default;
    expect(config.migrations?.table).toBe(CONTROL_PLANE.migrationsTable);
  });
});

describe('the control-plane history grows only on purpose', () => {
  it('holds exactly the migrations it had when deploys stopped applying it', () => {
    // A migration added here reaches local and test databases and NOTHING
    // ELSE: no deploy applies this history any more, so production would only
    // have the change if the control plane made it. The schema of these tables
    // is the control plane's. So the order is fixed: the change lands in the
    // control plane first (open an issue labelled `cloud-contract`); only then
    // does the site mirror it, with a migration here so local and test
    // databases match, and a new entry in this list. Adding an entry is the
    // statement "the control plane already has this".
    const journal = JSON.parse(
      readFileSync(join(CONTROL_PLANE.folder, 'meta', '_journal.json'), 'utf8')
    ) as { entries: { tag: string }[] };
    expect(journal.entries.map((entry) => entry.tag)).toEqual([
      '0000_baseline',
      '0001_account_issuer_optional',
    ]);
  });
});
